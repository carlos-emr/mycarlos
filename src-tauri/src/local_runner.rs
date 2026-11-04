//! The AI helper's local summary runner (#172): a model process on this
//! computer, started on first use and kept while the vault is unlocked,
//! asked one thing at a time, stopped when the vault locks and when
//! myCarlos closes.
//!
//! Model-independent: the model is whatever command [`RunnerConfig`] names,
//! as long as it speaks the line contract below. Nothing here downloads,
//! reads a model file, or opens a connection; the choice of model, its
//! download and its hash check come with the model PR. That PR's checklist,
//! in order:
//! 1. verify the model file against its published hash before the first
//!    load, and refuse an unverified file;
//! 2. name the command with an absolute path, the model's licence shown and
//!    the "Built with Llama" line if that is the model;
//! 3. bound the process (threads, memory) as the PDF helper is bounded;
//! 4. fill [`install`] from the app state so that a lock stops the process;
//! 5. wire `ai_model_status` and the reader's actions to [`Runner`].
//!
//! The contract (JSON, one object per line, over the process's stdin and
//! stdout; a line is at most [`MAX_LINE_BYTES`], and an answer is one line,
//! never spread over several):
//! - on start, the model writes one hello line:
//!   `{"hello":"mycarlos-model/1","model":{"name":…,"sha256":…}}`;
//! - a summary request `{"id":n,"tool":"summary","lang":…,"text":…,
//!   "maxSentences":k}` is answered by `{"id":n,"sentences":[{"text":…,
//!   "quote":…},…]}`, each quote taken verbatim from the text, at most k
//!   sentences, each part at most [`MAX_SENTENCE_CHARS`];
//! - an explain request `{"id":n,"tool":"explain","term":…,"context":…,
//!   "lang":…}` is answered by `{"id":n,"text":…}`;
//! - `{"id":n,"error":…}` says the model could not answer. Its text is cut
//!   to [`MAX_ERROR_CHARS`] and is the model's own words: shown on its own,
//!   never beside the document's text, and never written anywhere.
//!
//! A request in flight is cancelled by the vault locking ([`on_lock`], which
//! also stops the installed runner's process) or by the reader leaving the
//! document (a newer [`Ticket`] from the same runner): the model process is
//! stopped, its partial answer discarded, nothing written anywhere. Before a
//! start, the device budget is checked against the memory the model needs
//! at the context asked: not enough, or not known, refuses.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// The longest line the model may write; a longer one ends the exchange
/// and the process.
pub(crate) const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// The longest sentence or quote taken from an answer.
pub(crate) const MAX_SENTENCE_CHARS: usize = 2_000;
/// How much of a model's error text is kept.
pub(crate) const MAX_ERROR_CHARS: usize = 200;

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
    /// The model process, by absolute path: an executable, or an interpreter
    /// with its script in `args`.
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
    /// The model said it could not answer: its own words, cut short, to be
    /// shown on their own and never beside the document's text.
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

/// A request's claim on its runner: current until the vault locks or the
/// reader asks that runner for something else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Ticket {
    runner: usize,
    generation: u64,
}

/// The runner the app installed, for the lock to stop. Filled by the state
/// wiring; empty until then, when a lock has nothing to stop.
static INSTALLED: Mutex<Option<Arc<Runner>>> = Mutex::new(None);

/// Makes `runner` the one a lock stops.
pub(crate) fn install(runner: Arc<Runner>) {
    *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = Some(runner);
}

/// Forgets the installed runner, without stopping it.
pub(crate) fn uninstall() {
    *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The vault locked: the installed runner's request in flight is cancelled
/// and its process stopped. Called from the manual and the idle lock.
pub(crate) fn on_lock() {
    let installed = INSTALLED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(runner) = installed {
        runner.cancel_all();
        runner.stop();
    }
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
    /// The generation of requests still wanted from this runner.
    generation: AtomicU64,
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
            generation: AtomicU64::new(0),
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

    /// A new claim on this runner, which ends every older one: the reader
    /// takes one when it asks for a document, and the old document's request
    /// is cancelled by it.
    pub(crate) fn ticket(&self) -> Ticket {
        Ticket {
            runner: self as *const Self as usize,
            generation: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
        }
    }

    fn is_current(&self, ticket: Ticket) -> bool {
        ticket.runner == self as *const Self as usize
            && self.generation.load(Ordering::SeqCst) == ticket.generation
    }

    /// Ends every request in flight on this runner: when the vault locks,
    /// and when the reader closes the panel.
    pub(crate) fn cancel_all(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
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
        if !self.config.command.is_absolute() {
            let reason = "command must be an absolute path".to_owned();
            self.set_status(RunnerStatus::Failed {
                reason: reason.clone(),
            });
            return Err(RunnerError::Start(reason));
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
        std::thread::spawn(move || read_lines(output, &sender));
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
        let hello: Hello = match serde_json::from_str(&hello) {
            Ok(hello) => hello,
            Err(_) => {
                sidecar.stop();
                return Err(RunnerError::Start("hello not understood".to_owned()));
            }
        };
        if hello.hello != HELLO {
            sidecar.stop();
            return Err(RunnerError::Start(format!(
                "unknown contract {}",
                cut(&hello.hello, 64)
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
    /// answer discarded. At most `max_sentences` come back.
    pub(crate) fn summarize(
        &self,
        ticket: Ticket,
        request: &SummaryRequest,
    ) -> Result<Summary, RunnerError> {
        let request_json = serde_json::to_value(request)
            .map_err(|error| RunnerError::Protocol(error.to_string()))?;
        let (answer, model) = self.ask(ticket, "summary", request_json)?;
        let Some(sentences) = answer.sentences else {
            return Err(RunnerError::Protocol("no sentences".to_owned()));
        };
        if sentences.iter().any(|sentence| {
            sentence.text.chars().count() > MAX_SENTENCE_CHARS
                || sentence.quote.chars().count() > MAX_SENTENCE_CHARS
        }) {
            return Err(RunnerError::Protocol("sentence too long".to_owned()));
        }
        let written = sentences.len().min(request.max_sentences);
        let located: Vec<Sentence> = sentences
            .into_iter()
            .take(request.max_sentences)
            .filter(|sentence| quote_in(&request.text, &sentence.quote))
            .collect();
        if located.is_empty() {
            return Err(RunnerError::Unlocated);
        }
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
        let (answer, _model) = self.ask(
            ticket,
            "explain",
            serde_json::json!({ "term": term, "context": context, "lang": lang }),
        )?;
        let text = answer
            .text
            .ok_or_else(|| RunnerError::Protocol("no text".to_owned()))?;
        if text.chars().count() > MAX_SENTENCE_CHARS {
            return Err(RunnerError::Protocol("text too long".to_owned()));
        }
        Ok(text)
    }

    /// One request, one answer, bounded by `answer_timeout` and by the
    /// ticket. Holds the process for the whole exchange; the answer comes
    /// with the model it is attributed to.
    fn ask(
        &self,
        ticket: Ticket,
        tool: &str,
        mut request: serde_json::Value,
    ) -> Result<(Answer, ModelInfo), RunnerError> {
        if !self.is_current(ticket) {
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
        let mut outcome = exchange(
            running,
            || self.is_current(ticket),
            &request,
            self.config.answer_timeout,
            id,
        );
        // Cancelled while the answer was already in: the reader has left,
        // and the answer belongs to nobody.
        if outcome.is_ok() && !self.is_current(ticket) {
            outcome = Err(RunnerError::Cancelled);
        }
        match &outcome {
            Ok(_) => self.set_status(RunnerStatus::Ready {
                model: model.clone(),
            }),
            Err(RunnerError::Cancelled) | Err(RunnerError::Timeout) => {
                // Whatever it was still writing is not wanted: stop it.
                *slot = None;
                self.set_status(RunnerStatus::Installed {
                    model: model.clone(),
                });
            }
            Err(RunnerError::Model(_)) => self.set_status(RunnerStatus::Ready {
                model: model.clone(),
            }),
            Err(error) => {
                *slot = None;
                self.set_status(RunnerStatus::Failed {
                    reason: format!("{error:?}"),
                });
            }
        }
        outcome.map(|answer| (answer, model))
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Feeds the model's output to the channel, one line at a time, each at
/// most `MAX_LINE_BYTES`: a longer one is an error, and the end of reading.
fn read_lines(output: std::process::ChildStdout, sender: &mpsc::Sender<std::io::Result<String>>) {
    let mut reader = BufReader::new(output).take(0);
    let mut line = Vec::new();
    loop {
        line.clear();
        reader.set_limit(MAX_LINE_BYTES as u64 + 1);
        let read = match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) => {
                let _ = sender.send(Err(error));
                break;
            }
        };
        if read > MAX_LINE_BYTES {
            let _ = sender.send(Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "line too long",
            )));
            break;
        }
        if line.last() == Some(&b'\n') {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
        }
        let text = match String::from_utf8(line.clone()) {
            Ok(text) => text,
            Err(_) => {
                let _ = sender.send(Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "line not UTF-8",
                )));
                break;
            }
        };
        if sender.send(Ok(text)).is_err() {
            break;
        }
    }
}

/// Writes the request and waits for its answer, looking at the ticket every
/// `CANCEL_POLL`.
fn exchange(
    running: &mut Sidecar,
    current: impl Fn() -> bool,
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
        if !current() {
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
                if answer.sentences.is_none() && answer.text.is_none() && answer.error.is_none() {
                    return Err(RunnerError::Protocol("empty answer".to_owned()));
                }
                if answer.id != id {
                    // An answer to an earlier, abandoned request: not this one's.
                    continue;
                }
                if let Some(error) = answer.error {
                    return Err(RunnerError::Model(cut(&error, MAX_ERROR_CHARS)));
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

/// The first `chars` characters of `text`.
fn cut(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
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

    fn model() -> ModelInfo {
        ModelInfo {
            name: "FAKE model".to_owned(),
            sha256: "0".repeat(64),
        }
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
        assert_eq!(
            serde_json::to_value(RunnerStatus::NotInstalled).unwrap(),
            serde_json::json!({ "state": "notInstalled" })
        );
        assert_eq!(
            serde_json::to_value(RunnerStatus::Installed { model: model() }).unwrap(),
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
            serde_json::to_value(RunnerStatus::Ready { model: model() }).unwrap()["state"],
            "ready"
        );
    }

    #[test]
    fn a_quote_is_found_whatever_the_whitespace_and_an_empty_one_is_not() {
        assert!(quote_in("The  blood\ntest was normal.", "blood test was"));
        assert!(!quote_in("The blood test was normal.", "blood work"));
        assert!(!quote_in("Anything.", "   "));
    }

    fn idle_config() -> RunnerConfig {
        RunnerConfig {
            command: PathBuf::from("/nonexistent/FAKE-model"),
            args: Vec::new(),
            needed_bytes: GIB,
            start_timeout: Duration::from_secs(1),
            answer_timeout: Duration::from_secs(1),
        }
    }

    #[test]
    fn a_newer_ticket_ends_an_older_one_of_the_same_runner_only() {
        let runner = Runner::new(idle_config());
        let other = Runner::new(idle_config());
        let first = runner.ticket();
        assert!(runner.is_current(first));
        let second = runner.ticket();
        assert!(!runner.is_current(first));
        assert!(runner.is_current(second));
        // The other runner's claims are its own.
        let elsewhere = other.ticket();
        assert!(runner.is_current(second));
        assert!(other.is_current(elsewhere));
        assert!(!runner.is_current(elsewhere));
        runner.cancel_all();
        assert!(!runner.is_current(second));
        assert!(other.is_current(elsewhere));
    }

    #[test]
    fn a_command_that_is_not_an_absolute_path_is_refused_before_the_budget() {
        let mut config = idle_config();
        config.command = PathBuf::from("python3");
        let runner = Runner::new(config);
        assert_eq!(
            runner.start(&Fixed(Some(8 * GIB))),
            Err(RunnerError::Start(
                "command must be an absolute path".to_owned()
            ))
        );
        assert!(matches!(runner.status(), RunnerStatus::Failed { .. }));
    }

    #[test]
    fn a_lock_with_no_runner_installed_has_nothing_to_stop() {
        // Other tests may install one meanwhile; this only proves the call
        // is safe either way.
        on_lock();
    }

    /// The fake model, through the Python on the test machine (Linux and
    /// macOS CI runners have it; Windows is not where the model runs yet).
    #[cfg(unix)]
    mod with_the_fake_model {
        use super::*;

        const TEXT: &str =
            "The blood test was normal. The next visit is in June. Take one tablet each morning.";

        /// The interpreter, found once on PATH: the runner wants an absolute
        /// path.
        fn python3() -> PathBuf {
            let path = std::env::var_os("PATH").expect("PATH");
            std::env::split_paths(&path)
                .map(|dir| dir.join("python3"))
                .find(|candidate| candidate.is_file())
                .expect("python3 on PATH")
        }

        fn config(fake_args: &[&str], needed_bytes: u64) -> RunnerConfig {
            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/local-runner/fake-model.py");
            let mut args = vec![script.into_os_string()];
            args.extend(fake_args.iter().map(OsString::from));
            RunnerConfig {
                command: python3(),
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
            let runner = Runner::new(config(&[], GIB));
            let model = runner.start(&Fixed(Some(8 * GIB))).unwrap();
            assert_eq!(model.name, "FAKE model");
            assert!(runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Ready { .. }));

            let summary = runner.summarize(runner.ticket(), &request()).unwrap();
            assert_eq!(summary.sentences.len(), 3);
            assert_eq!(summary.dropped, 0);
            for sentence in &summary.sentences {
                assert!(TEXT.contains(&sentence.quote), "{}", sentence.quote);
                assert!(sentence.text.starts_with("In short: "));
            }
            assert_eq!(summary.model, model);
            assert!(matches!(runner.status(), RunnerStatus::Ready { .. }));

            // No more sentences than asked for.
            let two = runner
                .summarize(
                    runner.ticket(),
                    &SummaryRequest {
                        max_sentences: 2,
                        ..request()
                    },
                )
                .unwrap();
            assert_eq!(two.sentences.len(), 2);
            assert_eq!(two.dropped, 0);

            let explained = runner
                .explain(
                    runner.ticket(),
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
                runner.summarize(runner.ticket(), &request()),
                Err(RunnerError::NotRunning)
            );
        }

        #[test]
        fn a_lock_cancels_the_request_in_flight_and_stops_the_model() {
            let runner = Arc::new(Runner::new(config(&["--slow", "30"], GIB)));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let ticket = runner.ticket();
            let asked = {
                let runner = runner.clone();
                std::thread::spawn(move || runner.summarize(ticket, &request()))
            };
            // The request is under way, then the vault locks.
            std::thread::sleep(Duration::from_millis(300));
            assert!(matches!(runner.status(), RunnerStatus::Working { .. }));
            let locked_at = Instant::now();
            runner.cancel_all();
            let outcome = asked.join().unwrap();
            assert_eq!(outcome, Err(RunnerError::Cancelled));
            assert!(locked_at.elapsed() < Duration::from_secs(5));
            assert!(!runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Installed { .. }));
        }

        #[test]
        fn the_installed_runner_is_stopped_by_the_lock_even_when_idle() {
            let runner = Arc::new(Runner::new(config(&[], GIB)));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let ticket = runner.ticket();
            install(runner.clone());
            // As vault_lock and lock_if_idle call it. (Another test's lock
            // may run meanwhile, which only stops it sooner.)
            on_lock();
            uninstall();
            assert!(!runner.is_running());
            assert!(!runner.is_current(ticket));
            assert!(matches!(runner.status(), RunnerStatus::Installed { .. }));
        }

        #[test]
        fn the_reader_leaving_the_document_cancels_the_same_way() {
            let runner = Arc::new(Runner::new(config(&["--slow", "30"], GIB)));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let ticket = runner.ticket();
            let asked = {
                let runner = runner.clone();
                std::thread::spawn(move || runner.summarize(ticket, &request()))
            };
            std::thread::sleep(Duration::from_millis(300));
            // Another document: a newer ticket, as the panel would take.
            let _newer = runner.ticket();
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
            let runner = Runner::new(config(&["--unlocated"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            assert_eq!(
                runner.summarize(runner.ticket(), &request()),
                Err(RunnerError::Unlocated)
            );
            // The model is fine; only its answer was unusable.
            assert!(runner.is_running());
        }

        #[test]
        fn a_line_too_long_ends_the_exchange_and_the_process() {
            let runner = Runner::new(config(&["--long-line"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let outcome = runner.summarize(runner.ticket(), &request());
            assert!(
                matches!(&outcome, Err(RunnerError::Protocol(reason)) if reason.contains("line too long")),
                "{outcome:?}"
            );
            assert!(!runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Failed { .. }));
        }

        #[test]
        fn a_model_refusal_is_kept_short_and_leaves_the_model_running() {
            let runner = Runner::new(config(&["--refuse"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let outcome = runner.summarize(runner.ticket(), &request());
            match outcome {
                Err(RunnerError::Model(text)) => {
                    assert_eq!(text.chars().count(), MAX_ERROR_CHARS);
                    assert!(text.starts_with("FAKE refusal"));
                }
                other => panic!("{other:?}"),
            }
            assert!(runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Ready { .. }));
        }
    }
}
