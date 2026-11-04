//! The AI helper's local summary runner (#172): a model process on this
//! computer, started on first use and kept while the vault is unlocked,
//! asked one thing at a time, stopped when the vault locks and when
//! myCarlos closes.
//!
//! Model-independent: the model is whatever command [`RunnerConfig`] names,
//! as long as it speaks the line contract below. Nothing here downloads,
//! reads a model file, or opens a connection; the choice of model, its
//! download and its hash check come with the model PR.
//!
//! The contract (JSON, one object per line, over the process's stdin and
//! stdout):
//! - on start, the model writes one hello line:
//!   `{"hello":"mycarlos-model/1","model":{"name":…,"sha256":…}}`;
//! - a summary request `{"id":n,"tool":"summary","lang":…,"text":…,
//!   "maxSentences":k}` is answered by `{"id":n,"sentences":[{"text":…,
//!   "quote":…},…]}`, each quote taken verbatim from the text;
//! - an explain request `{"id":n,"tool":"explain","term":…,"context":…,
//!   "lang":…}` is answered by `{"id":n,"text":…}`;
//! - `{"id":n,"error":…}` says the model could not answer.
//!
//! A request in flight is cancelled by the vault locking ([`cancel_all`],
//! as `pdf_view` does for pages) or by the renderer leaving the document
//! (a newer [`Ticket`]): the model process is stopped, its partial answer
//! discarded, nothing written anywhere. Before a start, the device budget
//! is checked against the memory the model needs at the context asked:
//! not enough, or not known, refuses.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Which model answers: its name and the hash of its file, as the renderer
/// shows them with every result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ModelInfo {
    pub(crate) name: String,
    pub(crate) sha256: String,
}

/// What a runner starts and how much it may use.
#[derive(Debug, Clone)]
pub(crate) struct RunnerConfig {
    /// The model process: an executable, or an interpreter with its script in
    /// `args`.
    pub(crate) command: PathBuf,
    pub(crate) args: Vec<OsString>,
    /// The memory the model needs at the context the app asks for: its
    /// weights, its cache for that context, and the runtime's own.
    pub(crate) needed_bytes: u64,
    /// The longest wait for the hello line after the start.
    pub(crate) start_timeout: Duration,
    /// The longest wait for one answer.
    pub(crate) answer_timeout: Duration,
}

/// Reads how much memory this device has free for a model.
pub(crate) trait MemoryProbe: Send + Sync {
    /// `None` when it cannot be read here: that counts as not enough.
    fn available_bytes(&self) -> Option<u64>;
}

/// Linux: `MemAvailable` from /proc/meminfo, the kernel's estimate of what a
/// new program can use without swapping. Other platforms are not read yet.
pub(crate) struct ProcMemInfo;

impl MemoryProbe for ProcMemInfo {
    fn available_bytes(&self) -> Option<u64> {
        #[cfg(target_os = "linux")]
        {
            let text = std::fs::read_to_string("/proc/meminfo").ok()?;
            parse_mem_available(&text)
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }
}

/// `MemAvailable:   12345 kB` → bytes.
fn parse_mem_available(meminfo: &str) -> Option<u64> {
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    kib.checked_mul(1024)
}

/// Whether the model fits the device now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Budget {
    Fits {
        available_bytes: u64,
    },
    Refused {
        needed_bytes: u64,
        available_bytes: Option<u64>,
    },
}

/// Not enough free memory for the model, or no way to tell, refuses: a model
/// that swaps is a model that never answers.
pub(crate) fn check_budget(needed_bytes: u64, probe: &dyn MemoryProbe) -> Budget {
    match probe.available_bytes() {
        Some(available_bytes) if available_bytes >= needed_bytes => {
            Budget::Fits { available_bytes }
        }
        available_bytes => Budget::Refused {
            needed_bytes,
            available_bytes,
        },
    }
}

/// What the renderer is told about the model on this computer. The first two
/// are the shape `ai_model_status` answers today; the others are the runner's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum RunnerStatus {
    /// No model on this computer: nothing to start.
    NotInstalled,
    /// A model is here and not running.
    Installed { model: ModelInfo },
    /// The device has not enough memory for it now.
    #[serde(rename_all = "camelCase")]
    BudgetRefused {
        needed_bytes: u64,
        available_bytes: Option<u64>,
    },
    /// Started, waiting for its hello.
    Starting,
    /// Running and idle.
    Ready { model: ModelInfo },
    /// Answering a request.
    Working { model: ModelInfo },
    /// It could not be started, or stopped answering; the next use starts it
    /// again.
    Failed { reason: String },
}

/// Why a request or a start gave nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunnerError {
    /// The device budget refused the start.
    Budget {
        needed_bytes: u64,
        available_bytes: Option<u64>,
    },
    /// The process could not be started, or gave no hello in time.
    Start(String),
    /// No model process is running (start it first).
    NotRunning,
    /// The vault locked, or the reader left the document, while it worked.
    Cancelled,
    /// No answer within the time allowed.
    Timeout,
    /// The model answered, but not as the contract says.
    Protocol(String),
    /// The model said it could not answer.
    Model(String),
    /// Every sentence's quote was missing from the document: nothing to show.
    Unlocated,
}

/// A summary request, as the renderer sends it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummaryRequest {
    pub(crate) lang: String,
    pub(crate) text: String,
    pub(crate) max_sentences: usize,
}

/// One sentence of a summary: the words, and the words of the document it
/// rests on, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Sentence {
    pub(crate) text: String,
    pub(crate) quote: String,
}

/// A summary as given back: the sentences whose quotes are in the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Summary {
    pub(crate) sentences: Vec<Sentence>,
    pub(crate) model: ModelInfo,
    /// How many sentences the model wrote whose quote was not in the
    /// document, and were dropped.
    pub(crate) dropped: usize,
}

// --- Cancellation -------------------------------------------------------

/// The generation of requests still wanted. A lock, or the reader leaving
/// the document, moves it on; a request from before then is cancelled.
static REQUEST_GENERATION: AtomicU64 = AtomicU64::new(0);

/// A request's claim on the runner: current until the vault locks or the
/// reader asks for something else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ticket(u64);

impl Ticket {
    /// A new claim, which ends every older one.
    pub(crate) fn new() -> Self {
        Self(REQUEST_GENERATION.fetch_add(1, Ordering::SeqCst) + 1)
    }

    pub(crate) fn is_current(&self) -> bool {
        REQUEST_GENERATION.load(Ordering::SeqCst) == self.0
    }
}

/// Ends every request in flight: when the vault locks, and when the reader
/// closes the panel or changes document.
pub(crate) fn cancel_all() {
    REQUEST_GENERATION.fetch_add(1, Ordering::SeqCst);
}

// --- The process --------------------------------------------------------

/// The model process while it runs: its input, and its output line by line
/// through a reader thread, so that a wait can be bounded and interrupted.
struct Sidecar {
    child: Child,
    input: ChildStdin,
    lines: Receiver<std::io::Result<String>>,
    model: ModelInfo,
    next_id: u64,
}

impl Sidecar {
    /// Stops the process and waits for it, so that nothing of it is left.
    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The runner: at most one model process, asked one thing at a time.
pub(crate) struct Runner {
    config: RunnerConfig,
    sidecar: Mutex<Option<Sidecar>>,
    status: Mutex<RunnerStatus>,
}

#[derive(Deserialize)]
struct Hello {
    hello: String,
    model: ModelInfo,
}

#[derive(Deserialize)]
struct Answer {
    id: u64,
    #[serde(default)]
    sentences: Option<Vec<Sentence>>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

const HELLO: &str = "mycarlos-model/1";
/// How often a waiting request looks at its ticket.
const CANCEL_POLL: Duration = Duration::from_millis(50);

impl Runner {
    pub(crate) fn new(config: RunnerConfig) -> Self {
        Self {
            config,
            sidecar: Mutex::new(None),
            status: Mutex::new(RunnerStatus::NotInstalled),
        }
    }

    pub(crate) fn status(&self) -> RunnerStatus {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set_status(&self, status: RunnerStatus) {
        *self.status.lock().unwrap_or_else(|e| e.into_inner()) = status;
    }

    /// Starts the model process if it is not running: the budget first, then
    /// the process, then its hello within `start_timeout`. The model it names
    /// is what every answer is attributed to.
    pub(crate) fn start(&self, probe: &dyn MemoryProbe) -> Result<ModelInfo, RunnerError> {
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(running) = slot.as_mut() {
            if matches!(running.child.try_wait(), Ok(None)) {
                return Ok(running.model.clone());
            }
            // It ended on its own: start afresh below.
            *slot = None;
        }
        if let Budget::Refused {
            needed_bytes,
            available_bytes,
        } = check_budget(self.config.needed_bytes, probe)
        {
            self.set_status(RunnerStatus::BudgetRefused {
                needed_bytes,
                available_bytes,
            });
            return Err(RunnerError::Budget {
                needed_bytes,
                available_bytes,
            });
        }
        self.set_status(RunnerStatus::Starting);
        let started = self.spawn();
        match started {
            Ok(sidecar) => {
                let model = sidecar.model.clone();
                *slot = Some(sidecar);
                self.set_status(RunnerStatus::Ready {
                    model: model.clone(),
                });
                Ok(model)
            }
            Err(error) => {
                self.set_status(RunnerStatus::Failed {
                    reason: match &error {
                        RunnerError::Start(reason) => reason.clone(),
                        other => format!("{other:?}"),
                    },
                });
                Err(error)
            }
        }
    }

    fn spawn(&self) -> Result<Sidecar, RunnerError> {
        let mut command = Command::new(&self.config.command);
        command
            .args(&self.config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|error| RunnerError::Start(format!("cannot start: {error}")))?;
        let input = child.stdin.take();
        let output = child.stdout.take();
        let (Some(input), Some(output)) = (input, output) else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RunnerError::Start("no pipes".to_owned()));
        };
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(output);
            for line in reader.lines() {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let mut sidecar = Sidecar {
            child,
            input,
            lines,
            model: ModelInfo {
                name: String::new(),
                sha256: String::new(),
            },
            next_id: 1,
        };
        let hello = match sidecar.lines.recv_timeout(self.config.start_timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(error)) => {
                sidecar.stop();
                return Err(RunnerError::Start(format!("cannot read: {error}")));
            }
            Err(RecvTimeoutError::Timeout) => {
                sidecar.stop();
                return Err(RunnerError::Start("no hello in time".to_owned()));
            }
            Err(RecvTimeoutError::Disconnected) => {
                sidecar.stop();
                return Err(RunnerError::Start("ended before its hello".to_owned()));
            }
        };
        let hello: Hello = serde_json::from_str(&hello).map_err(|_| {
            sidecar.stop();
            RunnerError::Start("hello not understood".to_owned())
        })?;
        if hello.hello != HELLO {
            sidecar.stop();
            return Err(RunnerError::Start(format!(
                "unknown contract {}",
                hello.hello
            )));
        }
        sidecar.model = hello.model;
        Ok(sidecar)
    }

    /// Stops the model process, if any: on lock, on exit, and after a
    /// cancelled request. The model stays installed; the next use starts it.
    pub(crate) fn stop(&self) {
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        let model = slot.as_ref().map(|running| running.model.clone());
        *slot = None;
        self.set_status(match model {
            Some(model) => RunnerStatus::Installed { model },
            None => match self.status() {
                RunnerStatus::NotInstalled => RunnerStatus::NotInstalled,
                other => other,
            },
        });
    }

    /// Whether a model process is running now.
    pub(crate) fn is_running(&self) -> bool {
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_mut() {
            Some(running) => matches!(running.child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Asks for a summary under `ticket`. One request at a time: a second
    /// caller waits for the first. Cancelled as soon as the ticket is no
    /// longer current; the model process is then stopped and its partial
    /// answer discarded.
    pub(crate) fn summarize(
        &self,
        ticket: Ticket,
        request: &SummaryRequest,
    ) -> Result<Summary, RunnerError> {
        let request_json = serde_json::to_value(request)
            .map_err(|error| RunnerError::Protocol(error.to_string()))?;
        let answer = self.ask(ticket, "summary", request_json)?;
        let Some(sentences) = answer.sentences else {
            return Err(RunnerError::Protocol("no sentences".to_owned()));
        };
        let written = sentences.len();
        let located: Vec<Sentence> = sentences
            .into_iter()
            .filter(|sentence| quote_in(&request.text, &sentence.quote))
            .collect();
        if located.is_empty() {
            return Err(RunnerError::Unlocated);
        }
        let model = self
            .sidecar
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|running| running.model.clone())
            .ok_or(RunnerError::NotRunning)?;
        Ok(Summary {
            dropped: written - located.len(),
            sentences: located,
            model,
        })
    }

    /// Asks what a term means in its sentence, under `ticket`.
    pub(crate) fn explain(
        &self,
        ticket: Ticket,
        term: &str,
        context: &str,
        lang: &str,
    ) -> Result<String, RunnerError> {
        let answer = self.ask(
            ticket,
            "explain",
            serde_json::json!({ "term": term, "context": context, "lang": lang }),
        )?;
        answer
            .text
            .ok_or_else(|| RunnerError::Protocol("no text".to_owned()))
    }

    /// One request, one answer, bounded by `answer_timeout` and by the
    /// ticket. Holds the process for the whole exchange.
    fn ask(
        &self,
        ticket: Ticket,
        tool: &str,
        mut request: serde_json::Value,
    ) -> Result<Answer, RunnerError> {
        if !ticket.is_current() {
            return Err(RunnerError::Cancelled);
        }
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        let Some(running) = slot.as_mut() else {
            return Err(RunnerError::NotRunning);
        };
        let id = running.next_id;
        running.next_id += 1;
        if let Some(object) = request.as_object_mut() {
            object.insert("id".to_owned(), serde_json::json!(id));
            object.insert("tool".to_owned(), serde_json::json!(tool));
        }
        let model = running.model.clone();
        self.set_status(RunnerStatus::Working {
            model: model.clone(),
        });
        let outcome = exchange(running, ticket, &request, self.config.answer_timeout, id);
        match &outcome {
            Ok(_) => self.set_status(RunnerStatus::Ready { model }),
            Err(RunnerError::Cancelled) | Err(RunnerError::Timeout) => {
                // Whatever it was still writing is not wanted: stop it.
                *slot = None;
                self.set_status(RunnerStatus::Installed { model });
            }
            Err(RunnerError::Model(_)) => self.set_status(RunnerStatus::Ready { model }),
            Err(error) => {
                *slot = None;
                self.set_status(RunnerStatus::Failed {
                    reason: format!("{error:?}"),
                });
            }
        }
        outcome
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Writes the request and waits for its answer, looking at the ticket every
/// `CANCEL_POLL`.
fn exchange(
    running: &mut Sidecar,
    ticket: Ticket,
    request: &serde_json::Value,
    timeout: Duration,
    id: u64,
) -> Result<Answer, RunnerError> {
    let mut line =
        serde_json::to_string(request).map_err(|error| RunnerError::Protocol(error.to_string()))?;
    line.push('\n');
    running
        .input
        .write_all(line.as_bytes())
        .and_then(|()| running.input.flush())
        .map_err(|error| RunnerError::Protocol(format!("cannot write: {error}")))?;
    let deadline = Instant::now() + timeout;
    loop {
        if !ticket.is_current() {
            return Err(RunnerError::Cancelled);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(RunnerError::Timeout);
        }
        match running.lines.recv_timeout(CANCEL_POLL.min(deadline - now)) {
            Ok(Ok(text)) => {
                let answer: Answer = serde_json::from_str(&text)
                    .map_err(|_| RunnerError::Protocol("answer not understood".to_owned()))?;
                if answer.id != id {
                    // An answer to an earlier, abandoned request: not this one's.
                    continue;
                }
                if let Some(error) = answer.error {
                    return Err(RunnerError::Model(error));
                }
                return Ok(answer);
            }
            Ok(Err(error)) => return Err(RunnerError::Protocol(format!("cannot read: {error}"))),
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                return Err(RunnerError::Protocol("ended without answering".to_owned()))
            }
        }
    }
}

/// Whether the document contains the quote, word for word: whitespace runs
/// count as one. The renderer places it exactly (locateQuote); here a quote
/// that is not there at all is enough to drop the sentence.
fn quote_in(text: &str, quote: &str) -> bool {
    let fold = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let quote = fold(quote);
    !quote.is_empty() && fold(text).contains(&quote)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Option<u64>);

    impl MemoryProbe for Fixed {
        fn available_bytes(&self) -> Option<u64> {
            self.0
        }
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    /// Tickets are process-wide, so the tests that depend on one being
    /// current run one at a time.
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn mem_available_is_read_from_meminfo_in_kib() {
        let text = "MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    8000000 kB\n";
        assert_eq!(parse_mem_available(text), Some(8_000_000 * 1024));
        assert_eq!(parse_mem_available("MemTotal: 1 kB\n"), None);
    }

    #[test]
    fn the_budget_refuses_too_little_memory_and_memory_it_cannot_read() {
        assert_eq!(
            check_budget(3 * GIB, &Fixed(Some(8 * GIB))),
            Budget::Fits {
                available_bytes: 8 * GIB
            }
        );
        assert_eq!(
            check_budget(3 * GIB, &Fixed(Some(GIB))),
            Budget::Refused {
                needed_bytes: 3 * GIB,
                available_bytes: Some(GIB)
            }
        );
        assert_eq!(
            check_budget(3 * GIB, &Fixed(None)),
            Budget::Refused {
                needed_bytes: 3 * GIB,
                available_bytes: None
            }
        );
    }

    #[test]
    fn the_status_keeps_the_shape_the_renderer_reads_today() {
        let model = ModelInfo {
            name: "FAKE model".to_owned(),
            sha256: "0".repeat(64),
        };
        assert_eq!(
            serde_json::to_value(RunnerStatus::NotInstalled).unwrap(),
            serde_json::json!({ "state": "notInstalled" })
        );
        assert_eq!(
            serde_json::to_value(RunnerStatus::Installed {
                model: model.clone()
            })
            .unwrap(),
            serde_json::json!({ "state": "installed", "model": { "name": "FAKE model", "sha256": "0".repeat(64) } })
        );
        assert_eq!(
            serde_json::to_value(RunnerStatus::BudgetRefused {
                needed_bytes: 3 * GIB,
                available_bytes: None
            })
            .unwrap(),
            serde_json::json!({ "state": "budgetRefused", "neededBytes": 3 * GIB, "availableBytes": null })
        );
        assert_eq!(
            serde_json::to_value(RunnerStatus::Ready { model }).unwrap()["state"],
            "ready"
        );
    }

    #[test]
    fn a_quote_is_found_whatever_the_whitespace_and_an_empty_one_is_not() {
        assert!(quote_in("The  blood\ntest was normal.", "blood test was"));
        assert!(!quote_in("The blood test was normal.", "blood work"));
        assert!(!quote_in("Anything.", "   "));
    }

    #[test]
    fn a_newer_ticket_ends_an_older_one_and_a_lock_ends_them_all() {
        let _serial = serial();
        let first = Ticket::new();
        assert!(first.is_current());
        let second = Ticket::new();
        assert!(!first.is_current());
        assert!(second.is_current());
        cancel_all();
        assert!(!second.is_current());
    }

    /// The fake model, through the Python on the test machine (Linux and
    /// macOS CI runners have it; Windows is not where the model runs yet).
    #[cfg(unix)]
    mod with_the_fake_model {
        use super::*;

        const TEXT: &str =
            "The blood test was normal. The next visit is in June. Take one tablet each morning.";

        fn config(fake_args: &[&str], needed_bytes: u64) -> RunnerConfig {
            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/local-runner/fake-model.py");
            let mut args = vec![script.into_os_string()];
            args.extend(fake_args.iter().map(OsString::from));
            RunnerConfig {
                command: PathBuf::from("python3"),
                args,
                needed_bytes,
                start_timeout: Duration::from_secs(10),
                answer_timeout: Duration::from_secs(10),
            }
        }

        fn request() -> SummaryRequest {
            SummaryRequest {
                lang: "en".to_owned(),
                text: TEXT.to_owned(),
                max_sentences: 5,
            }
        }

        #[test]
        fn starts_answers_with_located_quotes_and_stops() {
            let _serial = serial();
            let runner = Runner::new(config(&[], GIB));
            let model = runner.start(&Fixed(Some(8 * GIB))).unwrap();
            assert_eq!(model.name, "FAKE model");
            assert!(runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Ready { .. }));

            let summary = runner.summarize(Ticket::new(), &request()).unwrap();
            assert_eq!(summary.sentences.len(), 3);
            assert_eq!(summary.dropped, 0);
            for sentence in &summary.sentences {
                assert!(TEXT.contains(&sentence.quote), "{}", sentence.quote);
                assert!(sentence.text.starts_with("In short: "));
            }
            assert_eq!(summary.model, model);
            assert!(matches!(runner.status(), RunnerStatus::Ready { .. }));

            let explained = runner
                .explain(
                    Ticket::new(),
                    "tablet",
                    "Take one tablet each morning.",
                    "en",
                )
                .unwrap();
            assert!(explained.starts_with("FAKE: tablet"));

            // A second start while it runs keeps the same process.
            let again = runner.start(&Fixed(Some(8 * GIB))).unwrap();
            assert_eq!(again, model);

            runner.stop();
            assert!(!runner.is_running());
            assert_eq!(runner.status(), RunnerStatus::Installed { model });
            assert_eq!(
                runner.summarize(Ticket::new(), &request()),
                Err(RunnerError::NotRunning)
            );
        }

        #[test]
        fn a_lock_cancels_the_request_in_flight_and_stops_the_model() {
            let _serial = serial();
            let runner = std::sync::Arc::new(Runner::new(config(&["--slow", "30"], GIB)));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let ticket = Ticket::new();
            let asked = {
                let runner = runner.clone();
                std::thread::spawn(move || runner.summarize(ticket, &request()))
            };
            // The request is under way, then the vault locks.
            std::thread::sleep(Duration::from_millis(300));
            assert!(matches!(runner.status(), RunnerStatus::Working { .. }));
            let locked_at = Instant::now();
            cancel_all();
            let outcome = asked.join().unwrap();
            assert_eq!(outcome, Err(RunnerError::Cancelled));
            assert!(locked_at.elapsed() < Duration::from_secs(5));
            assert!(!runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Installed { .. }));
        }

        #[test]
        fn the_reader_leaving_the_document_cancels_the_same_way() {
            let _serial = serial();
            let runner = std::sync::Arc::new(Runner::new(config(&["--slow", "30"], GIB)));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let ticket = Ticket::new();
            let asked = {
                let runner = runner.clone();
                std::thread::spawn(move || runner.summarize(ticket, &request()))
            };
            std::thread::sleep(Duration::from_millis(300));
            // Another document: a newer ticket, as the panel would take.
            let _newer = Ticket::new();
            assert_eq!(asked.join().unwrap(), Err(RunnerError::Cancelled));
            assert!(!runner.is_running());
        }

        #[test]
        fn too_little_memory_refuses_before_anything_starts() {
            // A command that cannot exist: a start would fail as Start, not Budget.
            let mut config = config(&[], 3 * GIB);
            config.command = PathBuf::from("/nonexistent/FAKE-model");
            let runner = Runner::new(config);
            assert_eq!(
                runner.start(&Fixed(Some(GIB))),
                Err(RunnerError::Budget {
                    needed_bytes: 3 * GIB,
                    available_bytes: Some(GIB)
                })
            );
            assert_eq!(
                runner.status(),
                RunnerStatus::BudgetRefused {
                    needed_bytes: 3 * GIB,
                    available_bytes: Some(GIB)
                }
            );
            assert!(!runner.is_running());
            assert_eq!(
                runner.start(&Fixed(None)),
                Err(RunnerError::Budget {
                    needed_bytes: 3 * GIB,
                    available_bytes: None
                })
            );
        }

        #[test]
        fn a_model_that_never_greets_is_stopped_after_the_start_timeout() {
            let mut config = config(&["--mute"], GIB);
            config.start_timeout = Duration::from_millis(500);
            let runner = Runner::new(config);
            let started_at = Instant::now();
            assert_eq!(
                runner.start(&Fixed(Some(8 * GIB))),
                Err(RunnerError::Start("no hello in time".to_owned()))
            );
            assert!(started_at.elapsed() < Duration::from_secs(5));
            assert!(!runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Failed { .. }));
        }

        #[test]
        fn sentences_whose_quotes_are_not_in_the_document_are_dropped() {
            let _serial = serial();
            let runner = Runner::new(config(&["--unlocated"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            assert_eq!(
                runner.summarize(Ticket::new(), &request()),
                Err(RunnerError::Unlocated)
            );
            // The model is fine; only its answer was unusable.
            assert!(runner.is_running());
        }
    }
}
