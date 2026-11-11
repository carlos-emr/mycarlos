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
//! 3. set the model's thread count in its arguments, and bound it on
//!    Windows with a job object as the PDF helper is bounded (on unix the
//!    runner already starts it in its own process group, stops the whole
//!    group, and on Linux caps its data size: [`RunnerConfig::memory_limit_bytes`]);
//!    add the macOS and Windows memory probes, which until then report
//!    unknown, so the budget refuses there;
//! 4. fill [`install`] from the app state so that a lock stops the process;
//! 5. wire `ai_model_status` and the reader's actions to [`Runner`].
//!
//! The contract (JSON, one object per line, over the process's stdin and
//! stdout; a line is at most [`MAX_LINE_BYTES`], and an answer is one line,
//! never spread over several):
//! - on start, the model writes one hello line:
//!   `{"hello":"mycarlos-model/1","model":{"name":…,"sha256":…}}`;
//! - a summary request `{"id":n,"tool":"summary","lang":…,"pages":[{"index":…,
//!   "text":…},…],"maxSentences":k}` is answered by `{"id":n,"sentences":[{"text":…,
//!   "quote":…},…],"lastPage":p,"lastPageCut":c}`: at most k sentences, each part at
//!   most [`MAX_SENTENCE_CHARS`], each quote taken verbatim from the pages read; the
//!   model reads whole pages in order while they fit, and `lastPage` is the index of
//!   the last one (`lastPageCut`: only its start, when the first page alone is too
//!   long);
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
use std::process::{Child, Command, Stdio};
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

/// How long one answer may take, from the size of its request: a fixed part, a cost for each
/// prompt token (reading the prompt is most of an answer's time on a computer's processor) and
/// for each answer token allowed, kept between a floor and a ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AnswerLimit {
    pub(crate) fixed: Duration,
    pub(crate) per_prompt_token: Duration,
    pub(crate) per_answer_token: Duration,
    pub(crate) floor: Duration,
    pub(crate) ceiling: Duration,
}

impl AnswerLimit {
    /// The same limit whatever the request.
    #[allow(dead_code)] // Tests' runners, and the runtime's test helpers.
    pub(crate) const fn fixed(limit: Duration) -> Self {
        Self {
            fixed: limit,
            per_prompt_token: Duration::ZERO,
            per_answer_token: Duration::ZERO,
            floor: limit,
            ceiling: limit,
        }
    }

    /// The limit for a request whose prompt is about `prompt_tokens` and whose answer may run
    /// to `answer_tokens`.
    pub(crate) fn for_request(&self, prompt_tokens: u32, answer_tokens: u32) -> Duration {
        self.fixed
            .saturating_add(self.per_prompt_token.saturating_mul(prompt_tokens))
            .saturating_add(self.per_answer_token.saturating_mul(answer_tokens))
            .max(self.floor)
            .min(self.ceiling)
    }
}

/// About how many tokens a prompt is: the helper's own words (`fixed`: system text,
/// instructions, the answer's shape) and `text_bytes` of the document's or the term's words at
/// three bytes a token. That is a cautious rate (English runs about 4.5, accented and CJK text
/// fewer), so the estimate errs long, and so does the limit. At most the model's context.
fn prompt_tokens(fixed: u32, text_bytes: usize) -> u32 {
    let tokens = u64::from(fixed).saturating_add((text_bytes as u64).div_ceil(3));
    tokens.min(u64::from(crate::model_helper::CONTEXT_TOKENS)) as u32
}

/// The helper's own words around a summary's pages, and around a term and its sentence, in
/// tokens, with room to spare (about 450 and 300 today).
pub(crate) const SUMMARY_PROMPT_TOKENS: u32 = 750;
const EXPLAIN_PROMPT_TOKENS: u32 = 400;
/// The answer a summary's limit allows for: about 53 tokens a sentence were measured (5 Nov
/// 2026), so six sentences run to about 320; its cap (`SUMMARY_TOKENS`) stops it anyway,
/// keeping the sentences it finished.
const SUMMARY_ANSWER_TOKENS: u32 = 400;

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
    /// The longest wait for one answer, from the size of its request.
    pub(crate) answer_limit: AnswerLimit,
    /// The most data memory the process may take (Linux, `RLIMIT_DATA`):
    /// above it, allocations fail and the model ends instead of taking the
    /// computer down. `None` sets no limit. Other platforms do not enforce it.
    /// It counts the heap and private writable mappings only: weights the
    /// model maps read-only from its file are outside it, so a budget for
    /// those belongs to `needed_bytes` and the device check, not this cap.
    pub(crate) memory_limit_bytes: Option<u64>,
    /// The model the process must name in its hello, exactly: the verified one, which every
    /// answer is attributed to. A process that names any other (the test stub, which says
    /// all zeros, among them) is refused and stopped. `None` takes whatever it names: tests
    /// with a fake model only.
    pub(crate) expected_model: Option<ModelInfo>,
    /// The verified model file. On unix it is handed to the process as descriptor 3 and let
    /// go once the process has greeted; on Windows it is held, writers denied, until the
    /// process ends.
    pub(crate) model_file: Option<Arc<std::fs::File>>,
    /// Started through the helpers' launcher (Windows: its own AppContainer and a job that
    /// caps its memory at `memory_limit_bytes`); on unix the helper sandboxes itself.
    pub(crate) sandboxed: bool,
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
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
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
}

/// One page of a document's text, by its index from 0.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Page {
    pub(crate) index: u32,
    pub(crate) text: String,
}

/// A summary request: the pages in order, as the reader read them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummaryRequest {
    pub(crate) lang: String,
    pub(crate) pages: Vec<Page>,
    pub(crate) max_sentences: usize,
}

/// One sentence of a summary: the words, and the words of the document it
/// rests on, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Sentence {
    pub(crate) text: String,
    pub(crate) quote: String,
}

/// A summary as given back. A sentence whose quote is not in the pages read keeps its words,
/// with an empty quote: the reader then says no source was found (AI-05).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Summary {
    pub(crate) sentences: Vec<Sentence>,
    pub(crate) model: ModelInfo,
    /// The index of the last page the model read.
    pub(crate) last_page: u32,
    /// Only the start of that page fitted.
    pub(crate) last_page_cut: bool,
    /// How many quotes were not in the pages read, and were emptied.
    pub(crate) unlocated: usize,
    /// What those quotes said, for measuring a model's quoting (tests print them); never shown.
    #[allow(dead_code)]
    pub(crate) unlocated_quotes: Vec<String>,
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
// Used by the tests and the stub's tests only.
#[allow(dead_code)]
pub(crate) fn uninstall() {
    *INSTALLED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The vault locked: the installed runner's request in flight, or its start, is
/// cancelled and its process stopped. Called from the manual and the idle lock,
/// which it never keeps waiting (see [`Runner::stop_without_waiting`]).
pub(crate) fn on_lock() {
    let installed = INSTALLED.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(runner) = installed {
        runner.cancel_all();
        runner.stop_without_waiting();
    }
}

// --- The process --------------------------------------------------------

/// The model process while it runs: its input, and its output line by line
/// through a reader thread, so that a wait can be bounded and interrupted.
struct Sidecar {
    process: Process,
    input: Box<dyn Write + Send>,
    lines: Receiver<std::io::Result<String>>,
    model: ModelInfo,
    next_id: u64,
    answer_limit: AnswerLimit,
    /// The model file while the process may still read it (see `RunnerConfig::model_file`).
    model_file: Option<Arc<std::fs::File>>,
    /// What the helper said it found in the model file, checked (model limits).
    card: Option<crate::model_limits::ModelCard>,
}

/// The model process: started as it is, or through the helpers' launcher.
enum Process {
    Plain(Child),
    #[cfg(windows)]
    Confined(crate::pdf_unlock::ConfinedHelper),
}

impl Process {
    fn running(&mut self) -> bool {
        match self {
            Self::Plain(child) => matches!(child.try_wait(), Ok(None)),
            #[cfg(windows)]
            Self::Confined(helper) => matches!(helper.try_wait(), Ok(None)),
        }
    }

    /// Stops the process and waits for it, so that nothing of it is left.
    fn stop(&mut self) {
        match self {
            Self::Plain(child) => {
                // On unix the model is its own process group (see `bound`): a
                // wrapper and anything it started go with it.
                #[cfg(unix)]
                if let Ok(group) = libc::pid_t::try_from(child.id()) {
                    // SAFETY: the group is the model's own, made by setpgid before
                    // it started; a group already gone only makes this fail.
                    unsafe { libc::killpg(group, libc::SIGKILL) };
                }
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(windows)]
            Self::Confined(helper) => helper.stop(),
        }
    }
}

impl Sidecar {
    fn stop(&mut self) {
        self.process.stop();
        self.model_file = None;
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The runner: at most one model process, asked one thing at a time.
pub(crate) struct Runner {
    /// The config `start` uses (tests); the app starts with its admitted ticket through `start_for`.
    #[allow(dead_code)]
    config: RunnerConfig,
    sidecar: Mutex<Option<Sidecar>>,
    status: Mutex<RunnerStatus>,
    /// The generation of requests still wanted from this runner.
    generation: AtomicU64,
    /// How the last answer was made, when the model said.
    last_stats: Mutex<Option<crate::model_helper::Stats>>,
    /// Told the time limit of the answer asked under its ticket, as it is asked.
    answer_watch: Mutex<Option<(Ticket, AnswerWatch)>>,
    /// The checked cards of the models started in this session, by their SHA-256 (model
    /// limits): kept after the helper ends, for the settings.
    cards: Mutex<Vec<(String, crate::model_limits::ModelCard)>>,
}

/// What is told an answer's own time limit as the answer is asked: the idle lock's hold on
/// the answer, and the renderer's (D19).
pub(crate) type AnswerWatch = Box<dyn FnOnce(Duration) + Send>;

#[derive(Deserialize)]
struct Hello {
    hello: String,
    model: ModelInfo,
    /// What the helper found in the file it loaded (model limits). Absent from a helper that
    /// loaded no model (the test stub); kept only when `ModelCard::checked` passes.
    #[serde(default)]
    card: Option<crate::model_limits::ModelCard>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    id: u64,
    #[serde(default)]
    sentences: Option<Vec<Sentence>>,
    #[serde(default)]
    last_page: Option<u32>,
    #[serde(default)]
    last_page_cut: bool,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    error: Option<String>,
    /// How the helper made it (counts and times), for measuring.
    #[serde(default)]
    stats: Option<crate::model_helper::Stats>,
}

const HELLO: &str = crate::model_helper::CONTRACT;
/// The most model cards a runner keeps (one per model started in a session).
const MAX_CARDS: usize = 16;
/// The pages' separator in a document's joined text (`documentText.ts`'s PAGE_SEPARATOR).
pub(crate) const PAGE_SEPARATOR: &str = "\n\n";
/// How often a waiting request looks at its ticket.
const CANCEL_POLL: Duration = Duration::from_millis(50);

impl Runner {
    pub(crate) fn new(config: RunnerConfig) -> Self {
        Self {
            config,
            sidecar: Mutex::new(None),
            status: Mutex::new(RunnerStatus::NotInstalled),
            generation: AtomicU64::new(0),
            last_stats: Mutex::new(None),
            answer_watch: Mutex::new(None),
            cards: Mutex::new(Vec::new()),
        }
    }

    /// The checked card of the model with this SHA-256, when the helper has run it in this
    /// session (model limits).
    pub(crate) fn card_for(&self, sha256: &str) -> Option<crate::model_limits::ModelCard> {
        let cards = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        cards
            .iter()
            .find(|(hash, _)| hash == sha256)
            .map(|(_, card)| card.clone())
    }

    /// Keeps a started model's card, in place of an older one for the same file. At most
    /// [`MAX_CARDS`] are kept: the oldest goes.
    fn remember_card(&self, sha256: &str, card: crate::model_limits::ModelCard) {
        let mut cards = self.cards.lock().unwrap_or_else(|e| e.into_inner());
        cards.retain(|(hash, _)| hash != sha256);
        if cards.len() >= MAX_CARDS {
            cards.remove(0);
        }
        cards.push((sha256.to_owned(), card));
    }

    /// Tells `watch` the time limit of the answer asked under `ticket`, as it is asked; never,
    /// if none is (a failed start, a cancel first). Takes the place of an earlier watch.
    pub(crate) fn watch_answer(&self, ticket: Ticket, watch: AnswerWatch) {
        let mut slot = self.answer_watch.lock().unwrap_or_else(|e| e.into_inner());
        if self.is_current(ticket) {
            *slot = Some((ticket, watch));
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
        let _watch = self.answer_watch.lock().unwrap_or_else(|e| e.into_inner());
        Ticket {
            runner: self as *const Self as usize,
            generation: self.generation.fetch_add(1, Ordering::SeqCst) + 1,
        }
    }

    pub(crate) fn is_current(&self, ticket: Ticket) -> bool {
        ticket.runner == self as *const Self as usize
            && self.generation.load(Ordering::SeqCst) == ticket.generation
    }

    /// Ends every request in flight on this runner: when the vault locks,
    /// and when the reader closes the panel.
    pub(crate) fn cancel_all(&self) {
        let _watch = self.answer_watch.lock().unwrap_or_else(|e| e.into_inner());
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    /// Starts the model process if it is not running, with the config it was made with.
    #[allow(dead_code)] // The tests' way in; the app uses `start_for`.
    pub(crate) fn start(&self, probe: &dyn MemoryProbe) -> Result<ModelInfo, RunnerError> {
        self.start_with(probe, || Ok(self.config.clone()))
    }

    /// Starts the model process if it is not running: `prepare` gives the config for this
    /// start (the model verified again, its file opened), then the budget, then the process,
    /// then its hello within `start_timeout`. The model it names, which must be the expected
    /// one when there is one, is what every answer is attributed to.
    ///
    /// A cancel meanwhile (a lock, a closing reader, a newer request) ends the
    /// start: the process, if started, is stopped, and nothing is kept.
    pub(crate) fn start_with(
        &self,
        probe: &dyn MemoryProbe,
        prepare: impl FnOnce() -> Result<RunnerConfig, RunnerError>,
    ) -> Result<ModelInfo, RunnerError> {
        self.start_for(
            Ticket {
                runner: self as *const Self as usize,
                generation: self.generation.load(Ordering::SeqCst),
            },
            probe,
            prepare,
        )
    }

    /// An answer's ticket is reserved at admission, never when its worker resumes.
    pub(crate) fn start_for(
        &self,
        ticket: Ticket,
        probe: &dyn MemoryProbe,
        prepare: impl FnOnce() -> Result<RunnerConfig, RunnerError>,
    ) -> Result<ModelInfo, RunnerError> {
        let wanted = || self.is_current(ticket);
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        // Before inspecting or changing the resident helper, status or config.
        if !wanted() {
            return Err(RunnerError::Cancelled);
        }
        if let Some(running) = slot.as_mut() {
            if running.process.running() {
                return Ok(running.model.clone());
            }
            // It ended on its own: start afresh below.
            *slot = None;
        }
        let config = match prepare() {
            Ok(config) => config,
            Err(error) => {
                self.set_status(RunnerStatus::Failed {
                    reason: format!("{error:?}"),
                });
                return Err(error);
            }
        };
        if !config.command.is_absolute() {
            let reason = "command must be an absolute path".to_owned();
            self.set_status(RunnerStatus::Failed {
                reason: reason.clone(),
            });
            return Err(RunnerError::Start(reason));
        }
        if let Budget::Refused {
            needed_bytes,
            available_bytes,
        } = check_budget(config.needed_bytes, probe)
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
        let not_started = || match config.expected_model.clone() {
            Some(model) => RunnerStatus::Installed { model },
            None => RunnerStatus::NotInstalled,
        };
        if !wanted() {
            self.set_status(not_started());
            return Err(RunnerError::Cancelled);
        }
        self.set_status(RunnerStatus::Starting);
        let started = spawn(&config, &wanted);
        match started {
            // Cancelled as it greeted: not kept (dropping it stops it).
            Ok(_) if !wanted() => {
                self.set_status(not_started());
                Err(RunnerError::Cancelled)
            }
            Err(RunnerError::Cancelled) => {
                self.set_status(not_started());
                Err(RunnerError::Cancelled)
            }
            Ok(sidecar) => {
                let model = sidecar.model.clone();
                if let Some(card) = sidecar.card.clone() {
                    self.remember_card(&model.sha256, card);
                }
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

    /// How the last answer was made, when the model said (counts and times only).
    #[allow(dead_code)] // For measuring: the real-model test prints it.
    pub(crate) fn last_stats(&self) -> Option<crate::model_helper::Stats> {
        *self.last_stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Stops the model process now if nothing holds it; otherwise as soon as its
    /// holder lets go (a start or a request, which a cancel has ended by then), on
    /// a thread of its own. A lock calls this, and must never wait for a model.
    pub(crate) fn stop_without_waiting(self: &Arc<Self>) {
        match self.sidecar.try_lock() {
            Ok(slot) => {
                drop(slot);
                self.stop();
            }
            Err(std::sync::TryLockError::Poisoned(_)) => self.stop(),
            Err(std::sync::TryLockError::WouldBlock) => {
                let runner = Arc::clone(self);
                std::thread::spawn(move || runner.stop());
            }
        }
    }

    /// Whether a model process is running now.
    // Used by the tests and the stub's tests only.
    #[allow(dead_code)]
    pub(crate) fn is_running(&self) -> bool {
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_mut() {
            Some(running) => running.process.running(),
            None => false,
        }
    }

    /// Asks for a summary under `ticket`. One request at a time: a second
    /// caller waits for the first. Cancelled as soon as the ticket is no
    /// longer current; the model process is then stopped and its partial
    /// answer discarded. At most `max_sentences` come back; a quote that is not
    /// in the pages read is emptied, its sentence kept.
    pub(crate) fn summarize(
        &self,
        ticket: Ticket,
        request: &SummaryRequest,
    ) -> Result<Summary, RunnerError> {
        let request_json = serde_json::to_value(request)
            .map_err(|error| RunnerError::Protocol(error.to_string()))?;
        let text_bytes = request.pages.iter().map(|page| page.text.len()).sum();
        let (answer, model) = self.ask(
            ticket,
            "summary",
            request_json,
            (
                prompt_tokens(SUMMARY_PROMPT_TOKENS, text_bytes),
                SUMMARY_ANSWER_TOKENS,
            ),
        )?;
        let Some(sentences) = answer.sentences else {
            return Err(RunnerError::Protocol("no sentences".to_owned()));
        };
        if sentences.is_empty() {
            return Err(RunnerError::Protocol("no sentences".to_owned()));
        }
        if sentences.iter().any(|sentence| {
            sentence.text.chars().count() > MAX_SENTENCE_CHARS
                || sentence.quote.chars().count() > MAX_SENTENCE_CHARS
        }) {
            return Err(RunnerError::Protocol("sentence too long".to_owned()));
        }
        let last_page = answer
            .last_page
            .ok_or_else(|| RunnerError::Protocol("no last page".to_owned()))?;
        let Some(read) = request
            .pages
            .iter()
            .position(|page| page.index == last_page)
        else {
            return Err(RunnerError::Protocol("last page not sent".to_owned()));
        };
        let text = request.pages[..=read]
            .iter()
            .map(|page| page.text.as_str())
            .collect::<Vec<_>>()
            .join(PAGE_SEPARATOR);
        let mut unlocated_quotes = Vec::new();
        let sentences = sentences
            .into_iter()
            .take(request.max_sentences)
            .map(|mut sentence| {
                if !quote_in(&text, &sentence.quote) || quote_is_heading(&text, &sentence.quote) {
                    unlocated_quotes.push(std::mem::take(&mut sentence.quote));
                }
                sentence
            })
            .collect();
        Ok(Summary {
            sentences,
            model,
            last_page,
            last_page_cut: answer.last_page_cut,
            unlocated: unlocated_quotes.len(),
            unlocated_quotes,
        })
    }

    /// Asks what a term means in its sentence, under `ticket`: the answer, and the model it is
    /// attributed to.
    pub(crate) fn explain(
        &self,
        ticket: Ticket,
        term: &str,
        context: &str,
        lang: &str,
    ) -> Result<(String, ModelInfo), RunnerError> {
        let (answer, model) = self.ask(
            ticket,
            "explain",
            serde_json::json!({ "term": term, "context": context, "lang": lang }),
            (
                prompt_tokens(EXPLAIN_PROMPT_TOKENS, term.len() + context.len()),
                crate::model_helper::EXPLAIN_TOKENS as u32,
            ),
        )?;
        let text = answer
            .text
            .ok_or_else(|| RunnerError::Protocol("no text".to_owned()))?;
        if text.chars().count() > MAX_SENTENCE_CHARS {
            return Err(RunnerError::Protocol("text too long".to_owned()));
        }
        Ok((text, model))
    }

    /// Test builds only: asks the stub helper what its sandbox allows (`model_helper`).
    #[cfg(all(feature = "ai-helper-stub", any(target_os = "linux", windows)))]
    pub(crate) fn probe(&self, ticket: Ticket, what: &str) -> Result<String, RunnerError> {
        let (answer, _model) =
            self.ask(ticket, "probe", serde_json::json!({ "what": what }), (0, 0))?;
        answer
            .text
            .ok_or_else(|| RunnerError::Protocol("no text".to_owned()))
    }

    /// One request, one answer, bounded by the answer limit for its `size` (prompt tokens,
    /// answer tokens allowed) and by the ticket. Holds the process for the whole exchange; the
    /// answer comes with the model it is attributed to.
    fn ask(
        &self,
        ticket: Ticket,
        tool: &str,
        mut request: serde_json::Value,
        size: (u32, u32),
    ) -> Result<(Answer, ModelInfo), RunnerError> {
        if !self.is_current(ticket) {
            return Err(RunnerError::Cancelled);
        }
        let mut slot = self.sidecar.lock().unwrap_or_else(|e| e.into_inner());
        // A stale worker must not touch the current helper, status or stats.
        if !self.is_current(ticket) {
            return Err(RunnerError::Cancelled);
        }
        // A failed answer leaves none: never the stats of the one before.
        *self.last_stats.lock().unwrap_or_else(|e| e.into_inner()) = None;
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
        let answer_timeout = running.answer_limit.for_request(size.0, size.1);
        // Only this ticket's watch: a newer request's waits for its own answer.
        let watch = {
            let mut slot = self.answer_watch.lock().unwrap_or_else(|e| e.into_inner());
            match slot.take() {
                Some((watched, watch)) if watched == ticket => Some(watch),
                other => {
                    *slot = other;
                    None
                }
            }
        };
        if let Some(watch) = watch {
            watch(answer_timeout);
        }
        let mut outcome = exchange(
            running,
            || self.is_current(ticket),
            &request,
            answer_timeout,
            id,
        );
        // Cancelled while the answer was already in: the reader has left,
        // and the answer belongs to nobody.
        if outcome.is_ok() && !self.is_current(ticket) {
            outcome = Err(RunnerError::Cancelled);
        }
        if let Ok(answer) = &outcome {
            *self.last_stats.lock().unwrap_or_else(|e| e.into_inner()) = answer.stats;
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

/// Starts the process `config` names and waits for its hello, which must name the expected
/// model when there is one, looking every `CANCEL_POLL` whether it is still `wanted`.
fn spawn(config: &RunnerConfig, wanted: &dyn Fn() -> bool) -> Result<Sidecar, RunnerError> {
    let mut command = Command::new(&config.command);
    command.args(&config.args);
    let (process, input, output) = start_process(command, config)?;
    let (sender, lines) = mpsc::channel();
    std::thread::spawn(move || read_lines(output, &sender));
    let mut sidecar = Sidecar {
        process,
        input,
        lines,
        model: ModelInfo {
            name: String::new(),
            sha256: String::new(),
        },
        next_id: 1,
        answer_limit: config.answer_limit,
        model_file: config.model_file.clone(),
        card: None,
    };
    let deadline = Instant::now() + config.start_timeout;
    let hello = loop {
        let now = Instant::now();
        if now >= deadline {
            sidecar.stop();
            return Err(RunnerError::Start("no hello in time".to_owned()));
        }
        match sidecar.lines.recv_timeout(CANCEL_POLL.min(deadline - now)) {
            Ok(Ok(line)) => break line,
            Ok(Err(error)) => {
                sidecar.stop();
                return Err(RunnerError::Start(format!("cannot read: {error}")));
            }
            Err(RecvTimeoutError::Timeout) if !wanted() => {
                sidecar.stop();
                return Err(RunnerError::Cancelled);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                sidecar.stop();
                return Err(RunnerError::Start("ended before its hello".to_owned()));
            }
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
    if config
        .expected_model
        .as_ref()
        .is_some_and(|expected| *expected != hello.model)
    {
        sidecar.stop();
        return Err(RunnerError::Start("not the verified model".to_owned()));
    }
    sidecar.model = hello.model;
    // Kept only in range, and only for a context no larger than the one asked for: the rest is
    // dropped, and the catalogue's limits stay (model limits, slice 1: nothing is refused yet).
    sidecar.card = hello
        .card
        .and_then(|card| card.checked(crate::model_helper::CONTEXT_TOKENS).ok());
    // The process holds its own copy of the descriptor now, closed once it has loaded.
    #[cfg(unix)]
    {
        sidecar.model_file = None;
    }
    Ok(sidecar)
}

/// The started process, its input, and its output.
type Started = (Process, Box<dyn Write + Send>, Box<dyn Read + Send>);

/// Starts `command` as `config` says: through the helpers' launcher on Windows when
/// sandboxed, otherwise with pipes and `bound`; a sandboxed one gets no environment.
fn start_process(mut command: Command, config: &RunnerConfig) -> Result<Started, RunnerError> {
    if config.sandboxed {
        command.env_clear();
    }
    #[cfg(windows)]
    if config.sandboxed {
        let limit = config
            .memory_limit_bytes
            .ok_or_else(|| RunnerError::Start("no memory limit".to_owned()))?;
        let (helper, input, output) = crate::pdf_unlock::start_confined(
            command,
            crate::pdf_unlock::HelperProfile::Model {
                memory_limit_bytes: limit,
            },
        )
        .map_err(|_| RunnerError::Start("cannot start in its sandbox".to_owned()))?;
        return Ok((Process::Confined(helper), Box::new(input), Box::new(output)));
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    bound(
        &mut command,
        config.memory_limit_bytes,
        config.model_file.as_deref(),
    );
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
    Ok((Process::Plain(child), Box::new(input), Box::new(output)))
}

/// Starts the model in its own process group, so that stopping it stops
/// whatever it started too, without core dumps, on Linux with its data
/// size capped, and with the model file, if any, as descriptor 3.
#[cfg(unix)]
fn bound(
    command: &mut Command,
    memory_limit_bytes: Option<u64>,
    model_file: Option<&std::fs::File>,
) {
    use std::os::fd::AsRawFd;
    use std::os::unix::process::CommandExt;
    const MODEL_FD: libc::c_int = crate::model_helper::MODEL_FD;
    let model = model_file.map(|file| file.as_raw_fd());
    // Computed before the fork: nothing is allocated between fork and exec.
    #[cfg(target_os = "linux")]
    let data = memory_limit_bytes.map(|bytes| (libc::RLIMIT_DATA, bytes as libc::rlim_t));
    #[cfg(not(target_os = "linux"))]
    let data: Option<(libc::c_int, libc::rlim_t)> = {
        let _ = memory_limit_bytes;
        None
    };
    let limits = [Some((libc::RLIMIT_CORE, 0 as libc::rlim_t)), data];
    // SAFETY: only setpgid, setrlimit, dup2 and fcntl, which are async-signal-safe,
    // run between fork and exec, on values computed before the fork.
    unsafe {
        command.pre_exec(move || {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            for (resource, value) in limits.into_iter().flatten() {
                let limit = libc::rlimit {
                    rlim_cur: value,
                    rlim_max: value,
                };
                if libc::setrlimit(resource as _, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            let handed_over = match model {
                // Already there: it only has to survive the exec.
                Some(MODEL_FD) => libc::fcntl(MODEL_FD, libc::F_SETFD, 0) == 0,
                // The copy dup2 makes is not closed on exec.
                Some(fd) => libc::dup2(fd, MODEL_FD) == MODEL_FD,
                None => true,
            };
            if !handed_over {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Elsewhere a plain start is not bounded: the model helper starts sandboxed
/// there (`RunnerConfig::sandboxed`).
#[cfg(not(unix))]
fn bound(
    _command: &mut Command,
    _memory_limit_bytes: Option<u64>,
    _model_file: Option<&std::fs::File>,
) {
}

/// Feeds the model's output to the channel, one line at a time, each at
/// most `MAX_LINE_BYTES`: a longer one is an error, and the end of reading.
fn read_lines(output: Box<dyn Read + Send>, sender: &mpsc::Sender<std::io::Result<String>>) {
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

/// What a quote may start or end with that is not part of it, as the reader
/// trims it (`locateQuote`): quotation marks, straight or curly, and `.,;:`.
const QUOTE_ENDS: &[char] = &[
    '"', '\'', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '.', ',', ';', ':',
];

/// Whether the document contains the quote, word for word, as the reader
/// matches one (`locateQuote`): whitespace runs count as one, case does not
/// count, and spaces and [`QUOTE_ENDS`] at either end of the quote are not
/// part of it. A model often copies the colon of a "Label: value" line
/// (": Admitted: 2026-10-01"). The renderer places it exactly; here a quote
/// that is not there at all is enough to empty it.
fn quote_in(text: &str, quote: &str) -> bool {
    let quote = folded(quote);
    !quote.is_empty() && fold(text).contains(&quote)
}

/// At most this many words make a heading (see [`quote_is_heading`]).
const HEADING_WORDS: usize = 4;

/// Whether the quote is a heading of the pages rather than something they say: a whole line
/// on its own, of at most [`HEADING_WORDS`] words and no digit, that reads as a heading. A
/// line reads as one when it ends with a colon ("Follow-up:"), is in capitals ("DISCHARGE
/// SUMMARY"), or has a list or table under it: its next line with words is indented further
/// than it, a bullet or numbered ("Medications at discharge" over the medicines). A quote must support its
/// sentence, and a heading only names a part of the document; the reader would link the
/// sentence to it. A short finding on a line of its own ("No known allergies", "Non-smoker",
/// "Allergies: none") is no heading, nor is a line with a value in it ("Admitted:
/// 2026-10-01") or a sentence ("Hypertension is treated.").
fn quote_is_heading(text: &str, quote: &str) -> bool {
    let quote = folded(quote);
    if quote.is_empty()
        || quote.split(' ').count() > HEADING_WORDS
        || quote.chars().any(char::is_numeric)
    {
        return false;
    }
    let lines: Vec<&str> = text.lines().collect();
    lines.iter().enumerate().any(|(at, line)| {
        let next = lines[at + 1..].iter().find(|next| !next.trim().is_empty());
        folded(line) == quote && reads_as_heading(line, next.copied())
    })
}

/// Whether a short line reads as a heading, from its own shape and from the line with words
/// after it (see [`quote_is_heading`]).
fn reads_as_heading(line: &str, next: Option<&str>) -> bool {
    // In characters, so that any kind of space counts as one (a no-break space is 2 bytes).
    let indent = |text: &str| text.chars().take_while(|c| c.is_whitespace()).count();
    let line_indent = indent(line);
    let line = line.trim();
    if line.ends_with(['.', '!', '?']) {
        // A sentence on a line of its own says something.
        return false;
    }
    let in_capitals =
        line.chars().any(char::is_alphabetic) && !line.chars().any(char::is_lowercase);
    let over_a_list = next.is_some_and(|next| {
        let item = next.trim_start();
        let numbered = item
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .starts_with(['.', ')'])
            && item.starts_with(|c: char| c.is_ascii_digit());
        // PDF text often indents ordinary lines too: only a line indented further than this
        // one is under it.
        indent(next) > line_indent
            || item.starts_with(['-', '*', '\u{2022}', '\u{2013}'])
            || numbered
    });
    line.ends_with(':') || in_capitals || over_a_list
}

/// Whitespace runs as one space, in lower case.
fn fold(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A quote, or a line, as quotes are compared: folded, without [`QUOTE_ENDS`] or spaces at
/// either end.
fn folded(text: &str) -> String {
    fold(text.trim_matches(|c: char| c.is_whitespace() || QUOTE_ENDS.contains(&c)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A card as a Qwen3.5 4B-like model's helper sends it (model limits). FAKE.
    fn card_json(context_made: u32) -> serde_json::Value {
        serde_json::json!({
            "architecture": "qwen35",
            "trainedContext": 262_144,
            "contextMade": context_made,
            "parameters": 4_330_000_000u64,
            "layers": 32,
            "vocabulary": 248_320,
            "recurrent": false,
            "hybrid": true
        })
    }

    #[test]
    fn a_hello_may_carry_a_card_and_it_is_kept_only_when_it_checks() {
        let base = serde_json::json!({
            "hello": HELLO,
            "model": { "name": "FAKE model", "sha256": "ab".repeat(32) }
        });
        // The stub (no model loaded) sends none.
        let hello: Hello = serde_json::from_value(base.clone()).unwrap();
        assert!(hello.card.is_none());
        let with = |card: serde_json::Value| {
            let mut line = base.clone();
            line["card"] = card;
            serde_json::from_value::<Hello>(line).unwrap().card
        };
        let kept = with(card_json(crate::model_helper::CONTEXT_TOKENS))
            .unwrap()
            .checked(crate::model_helper::CONTEXT_TOKENS);
        assert!(kept.is_ok());
        // A context larger than the one asked for is never trusted.
        let more = with(card_json(crate::model_helper::CONTEXT_TOKENS + 1))
            .unwrap()
            .checked(crate::model_helper::CONTEXT_TOKENS);
        assert_eq!(more, Err(crate::model_limits::CardRejected::ContextMade));
        // A card that is not one is no hello at all.
        let mut odd = base;
        odd["card"] = serde_json::json!({ "architecture": "qwen35" });
        assert!(serde_json::from_value::<Hello>(odd).is_err());
        // A null card reads as none.
        assert!(with(serde_json::Value::Null).is_none());
    }

    #[test]
    fn a_runner_keeps_one_card_per_model_and_the_newest_cards() {
        let runner = Runner::new(idle_config());
        let card: crate::model_limits::ModelCard =
            serde_json::from_value(card_json(8_192)).unwrap();
        assert!(runner.card_for("a").is_none());
        runner.remember_card("a", card.clone());
        let smaller = crate::model_limits::ModelCard {
            context_made: 4_096,
            ..card.clone()
        };
        runner.remember_card("a", smaller.clone());
        assert_eq!(runner.card_for("a"), Some(smaller));
        for index in 0..MAX_CARDS {
            runner.remember_card(&format!("other {index}"), card.clone());
        }
        // The oldest went to make room.
        assert!(runner.card_for("a").is_none());
        assert_eq!(runner.card_for("other 0"), Some(card));
    }

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
        // As the reader matches: the ends' punctuation and the case do not count.
        let letter = "Admitted: 2026-10-01\nIt lasts 3 to 5 minutes and settles with rest.";
        assert!(quote_in(letter, ": Admitted: 2026-10-01"));
        assert!(quote_in(
            letter,
            "\"it lasts 3 to 5 minutes and settles with rest\""
        ));
        assert!(quote_in(letter, "settles with rest.;"));
        assert!(quote_in(letter, "“Admitted: 2026-10-01”"));
        assert!(!quote_in(letter, ": Discharged: 2026-10-01"));
        assert!(!quote_in(letter, " :.;'\" "));
        // Inside the quote, the words still have to be there as written.
        assert!(!quote_in(letter, "lasts 3 to 6 minutes"));
    }

    #[test]
    fn a_quote_that_is_only_a_heading_is_one_and_a_line_with_a_value_is_not() {
        let summary = "DISCHARGE SUMMARY\n\nMedications at discharge\n\n  Ticagrelor  90 mg twice daily  NEW\n\
                       Follow-up:\nBlood tests in 1 week.\nAdmitted: 2026-10-01\n\
                       Instructions to the patient\n- Weigh yourself every morning.\n\
                       Diagnoses\n1. Heart attack\nHypertension is treated.";
        // Indented itself, a heading still has its table under it when that is deeper.
        let indented = "  Medications at discharge\n      Ticagrelor  90 mg twice daily  NEW";
        assert!(quote_is_heading(indented, "Medications at discharge"));
        assert!(!quote_is_heading(
            "  Medications at discharge\n  Ticagrelor  90 mg twice daily  NEW",
            "Medications at discharge"
        ));
        for heading in [
            "Discharge summary",
            "Medications at discharge",
            "medications at discharge:",
            "Follow-up",
            "\u{201C}Instructions to the patient\u{201D}",
            "Diagnoses",
        ] {
            assert!(quote_is_heading(summary, heading), "{heading}");
        }
        for content in [
            // A value, words of a longer line, or a sentence.
            ": Admitted: 2026-10-01",
            "Ticagrelor 90 mg twice daily",
            "Medications",
            "Hypertension is treated.",
            "Blood tests in 1 week.",
            "",
        ] {
            assert!(!quote_is_heading(summary, content), "{content}");
        }
    }

    #[test]
    fn a_short_finding_on_a_line_of_its_own_keeps_its_quote() {
        // Each finding as its own line, then as its own paragraph, and over a sentence.
        let findings = [
            "No known allergies",
            "Allergies: none",
            "Lives alone",
            "Non-smoker",
            "Normal sinus rhythm",
            "No acute distress",
        ];
        let lines = format!(
            "Social history\n{}\nPlan as discussed.",
            findings.join("\n")
        );
        let paragraphs = format!("{}\n\nPlan as discussed.", findings.join("\n\n"));
        // PDF text often indents every line alike: one as deep as the line before is not under it.
        let indented = format!(
            "  Social history\n  {}\n  Plan as discussed.",
            findings.join("\n  ")
        );
        // Spaces of other kinds count as one each: a no-break or ideographic space under a
        // plain one is no deeper.
        let mixed = format!(
            " {}\n\u{a0}Lives alone\n  Non-smoker\n\u{3000}Plan as discussed.",
            findings[0]
        );
        assert!(!quote_is_heading(&mixed, findings[0]));
        assert!(!quote_is_heading(&mixed, "Non-smoker"));
        for text in [&lines, &paragraphs, &indented] {
            for finding in findings {
                assert!(quote_in(text, finding), "{finding}");
                assert!(!quote_is_heading(text, finding), "{finding} in {text:?}");
            }
        }
    }

    #[test]
    fn an_answer_limit_grows_with_its_request_between_its_floor_and_ceiling() {
        let fixed = AnswerLimit::fixed(Duration::from_secs(7));
        assert_eq!(fixed.for_request(0, 0), Duration::from_secs(7));
        assert_eq!(
            fixed.for_request(u32::MAX, u32::MAX),
            Duration::from_secs(7)
        );
        let scaled = AnswerLimit {
            fixed: Duration::from_secs(30),
            per_prompt_token: Duration::from_millis(150),
            per_answer_token: Duration::from_millis(600),
            floor: Duration::from_secs(300),
            ceiling: Duration::from_secs(1200),
        };
        assert_eq!(scaled.for_request(0, 0), Duration::from_secs(300));
        assert_eq!(
            scaled.for_request(2_000, 350),
            Duration::from_secs(30 + 300 + 210)
        );
        // No overflow: the ceiling.
        assert_eq!(
            scaled.for_request(u32::MAX, u32::MAX),
            Duration::from_secs(1200)
        );
    }

    #[test]
    fn a_prompt_is_estimated_long_from_its_bytes_and_never_past_the_context() {
        assert_eq!(prompt_tokens(750, 0), 750);
        assert_eq!(prompt_tokens(750, 3_563), 750 + 1_188);
        assert_eq!(
            prompt_tokens(750, usize::MAX),
            crate::model_helper::CONTEXT_TOKENS
        );
    }

    #[test]
    fn a_new_request_forgets_the_last_answers_stats() {
        let runner = Runner::new(idle_config());
        *runner.last_stats.lock().unwrap() = Some(crate::model_helper::Stats::default());
        // Not running: the request fails, and leaves no stats from the one before.
        assert!(matches!(
            runner.explain(runner.ticket(), "FAKE", "FAKE context", "en"),
            Err(RunnerError::NotRunning)
        ));
        assert_eq!(runner.last_stats(), None);
    }

    fn idle_config() -> RunnerConfig {
        RunnerConfig {
            command: PathBuf::from("/nonexistent/FAKE-model"),
            args: Vec::new(),
            needed_bytes: GIB,
            start_timeout: Duration::from_secs(1),
            answer_limit: AnswerLimit::fixed(Duration::from_secs(1)),
            memory_limit_bytes: None,
            expected_model: None,
            model_file: None,
            sandboxed: false,
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
                answer_limit: AnswerLimit::fixed(Duration::from_secs(10)),
                memory_limit_bytes: None,
                expected_model: None,
                model_file: None,
                sandboxed: false,
            }
        }

        /// The text on page 0, and a page 2 the fake model reads only when asked to.
        fn request() -> SummaryRequest {
            SummaryRequest {
                lang: "en".to_owned(),
                pages: vec![
                    Page {
                        index: 0,
                        text: TEXT.to_owned(),
                    },
                    Page {
                        index: 2,
                        text: "FAKE page three says the clinic phoned.".to_owned(),
                    },
                ],
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
            assert_eq!(summary.unlocated, 0);
            assert_eq!((summary.last_page, summary.last_page_cut), (0, false));
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
            assert_eq!(two.unlocated, 0);

            let (explained, attributed) = runner
                .explain(
                    runner.ticket(),
                    "tablet",
                    "Take one tablet each morning.",
                    "en",
                )
                .unwrap();
            assert!(explained.starts_with("FAKE: tablet"));
            assert_eq!(attributed, model);

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
        fn ownership_an_admitted_old_worker_cannot_change_a_new_answers_helper() {
            // Pause A after admission, before start, then admit B either in
            // the same session or after locking and unlocking. Resume A only
            // after B has a resident helper, stats and its own waiting watch.
            for next_session in [false, true] {
                let runner = Arc::new(Runner::new(config(&[], GIB)));
                let idle = Arc::new(crate::idle::IdleDeadline::new(Instant::now()));
                idle.arm(Instant::now());
                let origin = idle.answer_origin().unwrap();
                let (old_hold, old_ticket) = idle
                    .admit_answer(origin, Duration::from_secs(1200), || runner.ticket())
                    .unwrap();
                let (release, resume) = mpsc::channel();
                let worker = Arc::clone(&runner);
                let old = std::thread::spawn(move || {
                    resume.recv_timeout(Duration::from_secs(10)).unwrap();
                    let announced = old_hold.watch(|_| panic!("old answer announced"));
                    worker.watch_answer(old_ticket, announced);
                    let start = worker.start_for(old_ticket, &Fixed(Some(8 * GIB)), || {
                        panic!("old worker prepared a model")
                    });
                    assert_eq!(start, Err(RunnerError::Cancelled));
                    assert_eq!(
                        worker.summarize(old_ticket, &request()),
                        Err(RunnerError::Cancelled)
                    );
                    assert!(!old_hold.finish(true));
                });
                if next_session {
                    runner.cancel_all();
                    idle.disarm();
                    idle.arm(Instant::now());
                }
                let origin = idle.answer_origin().unwrap();
                let (new_hold, new_ticket) = idle
                    .admit_answer(origin, Duration::from_secs(300), || runner.ticket())
                    .unwrap();
                runner
                    .start_for(new_ticket, &Fixed(Some(8 * GIB)), || {
                        Ok(runner.config.clone())
                    })
                    .unwrap();
                runner.summarize(new_ticket, &request()).unwrap();
                let (told, heard) = mpsc::channel();
                runner.watch_answer(new_ticket, Box::new(move |limit| told.send(limit).unwrap()));
                let state = || {
                    let slot = runner.sidecar.lock().unwrap();
                    let running = slot.as_ref().unwrap();
                    let Process::Plain(child) = &running.process;
                    (
                        child.id(),
                        running.next_id,
                        runner.status(),
                        serde_json::to_value(runner.last_stats()).unwrap(),
                    )
                };
                let before = state();
                release.send(()).unwrap();
                old.join().unwrap();
                assert_eq!(state(), before, "new session: {next_session}");
                assert!(new_hold.is_current());
                assert_eq!(heard.try_recv(), Err(mpsc::TryRecvError::Empty));
                runner.summarize(new_ticket, &request()).unwrap();
                assert!(heard.try_recv().is_ok(), "B retained its watch");
                assert!(new_hold.finish(true));
                runner.stop();
            }
        }

        #[test]
        fn a_watch_is_told_its_own_answers_limit_once_as_it_is_asked() {
            let limit = AnswerLimit {
                fixed: Duration::from_secs(2),
                per_prompt_token: Duration::from_millis(1),
                per_answer_token: Duration::from_millis(1),
                floor: Duration::from_secs(1),
                ceiling: Duration::from_secs(60),
            };
            let runner = Runner::new(RunnerConfig {
                answer_limit: limit,
                ..config(&[], GIB)
            });
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let text_bytes = request().pages.iter().map(|page| page.text.len()).sum();
            let own = limit.for_request(
                prompt_tokens(SUMMARY_PROMPT_TOKENS, text_bytes),
                SUMMARY_ANSWER_TOKENS,
            );
            let (told, heard) = mpsc::channel();
            let ticket = runner.ticket();
            runner.watch_answer(ticket, Box::new(move |limit| told.send(limit).unwrap()));
            runner.summarize(ticket, &request()).unwrap();
            assert_eq!(heard.try_recv(), Ok(own));
            // Told once: the watch is used up.
            runner.summarize(runner.ticket(), &request()).unwrap();
            assert_eq!(heard.try_recv(), Err(mpsc::TryRecvError::Disconnected));

            // A watch for an older request is not told a newer one's limit.
            let (told, heard) = mpsc::channel();
            let older = runner.ticket();
            runner.watch_answer(older, Box::new(move |limit| told.send(limit).unwrap()));
            runner
                .explain(runner.ticket(), "tablet", "Take one tablet.", "en")
                .unwrap();
            assert_eq!(heard.try_recv(), Err(mpsc::TryRecvError::Empty));
            // Nor is a request cancelled before it was asked.
            assert_eq!(
                runner.summarize(older, &request()),
                Err(RunnerError::Cancelled)
            );
            assert_eq!(heard.try_recv(), Err(mpsc::TryRecvError::Empty));
            runner.stop();
        }

        #[test]
        fn lock_now_during_a_held_answer_stops_it_at_once_and_ends_the_hold() {
            use crate::idle::{IdleDeadline, MARGIN};
            use crate::model_runtime::AiError;
            let runner = Arc::new(Runner::new(config(&["--slow", "30"], GIB)));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let armed_at = Instant::now();
            let idle = Arc::new(IdleDeadline::new(armed_at));
            idle.arm(armed_at);
            let (told, asked) = mpsc::channel();
            let answering = {
                let (runner, idle) = (runner.clone(), idle.clone());
                std::thread::spawn(move || {
                    let origin = idle.answer_origin().unwrap();
                    let (hold, ticket) = idle
                        .admit_answer(origin, crate::model_runtime::ANSWER_LIMIT.ceiling, || {
                            runner.ticket()
                        })
                        .unwrap();
                    tauri::async_runtime::block_on(crate::held_for_answer(
                        hold,
                        move |limit| told.send(limit).unwrap(),
                        move |watch| {
                            runner.watch_answer(ticket, watch);
                            match runner.summarize(ticket, &request()) {
                                Ok(_) => Ok(()),
                                Err(RunnerError::Cancelled) => Err(AiError::Cancelled),
                                Err(_) => Err(AiError::Failed),
                            }
                        },
                    ))
                })
            };
            // The answer is being written, under its limit (10 s here), and
            // the idle lock waits for it.
            assert_eq!(
                asked.recv_timeout(Duration::from_secs(5)),
                Ok(Duration::from_secs(10))
            );
            // Unheld, the delay would have run out a second past this.
            let heard_at = Instant::now();
            assert!(!idle
                .is_due(heard_at + Duration::from_secs(15 * 60) + MARGIN + Duration::from_secs(1)));
            // Lock now, as vault_lock does it: the model stops, and the vault
            // locks, which ends every hold.
            install(runner.clone());
            let locked_at = Instant::now();
            on_lock();
            idle.disarm();
            assert!(locked_at.elapsed() < Duration::from_millis(200));
            uninstall();
            assert_eq!(answering.join().unwrap(), Err(AiError::Cancelled));
            assert!(locked_at.elapsed() < Duration::from_secs(5));
            assert!(!runner.is_running());
            // The next session's delay runs from its unlock.
            let unlocked_at = Instant::now();
            idle.arm(unlocked_at);
            assert!(idle.is_due(unlocked_at + Duration::from_secs(15 * 60) + MARGIN));
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
        fn a_lock_during_a_start_ends_it_and_never_waits_for_it() {
            // A model that takes its time to greet, as a large one loading does.
            let mut slow = config(&["--greet-after", "30"], GIB);
            slow.start_timeout = Duration::from_secs(60);
            let runner = Arc::new(Runner::new(slow));
            let starting = {
                let runner = runner.clone();
                std::thread::spawn(move || runner.start(&Fixed(Some(8 * GIB))))
            };
            std::thread::sleep(Duration::from_millis(500));
            assert!(matches!(runner.status(), RunnerStatus::Starting));
            install(runner.clone());
            let locked_at = Instant::now();
            on_lock();
            // The lock itself returns at once.
            assert!(locked_at.elapsed() < Duration::from_millis(200));
            uninstall();
            assert_eq!(starting.join().unwrap(), Err(RunnerError::Cancelled));
            assert!(locked_at.elapsed() < Duration::from_secs(5));
            assert!(!runner.is_running());
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
        fn a_quote_not_in_the_pages_read_is_emptied_and_its_sentence_kept() {
            let runner = Runner::new(config(&["--unlocated"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let summary = runner.summarize(runner.ticket(), &request()).unwrap();
            assert_eq!(summary.unlocated, 3);
            assert!(summary
                .sentences
                .iter()
                .all(|sentence| sentence.quote.is_empty() && !sentence.text.is_empty()));
            assert!(runner.is_running());
        }

        #[test]
        fn a_quote_from_a_page_the_model_did_not_read_is_not_located() {
            // The fake model reads page 0 only, but quotes page 2.
            let runner = Runner::new(config(&["--quote-unread"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let summary = runner.summarize(runner.ticket(), &request()).unwrap();
            assert_eq!(summary.last_page, 0);
            assert_eq!(summary.unlocated, 1);
        }

        #[test]
        fn the_last_page_read_and_its_cut_come_back_and_must_be_a_page_sent() {
            let runner = Runner::new(config(&["--read-all"], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let summary = runner.summarize(runner.ticket(), &request()).unwrap();
            assert_eq!((summary.last_page, summary.last_page_cut), (2, false));
            let cut = Runner::new(config(&["--cut-first"], GIB));
            cut.start(&Fixed(Some(8 * GIB))).unwrap();
            let summary = cut.summarize(cut.ticket(), &request()).unwrap();
            assert_eq!((summary.last_page, summary.last_page_cut), (0, true));
            let wrong = Runner::new(config(&["--last-page", "1"], GIB));
            wrong.start(&Fixed(Some(8 * GIB))).unwrap();
            assert_eq!(
                wrong.summarize(wrong.ticket(), &request()),
                Err(RunnerError::Protocol("last page not sent".to_owned()))
            );
        }

        #[test]
        fn a_model_that_greets_as_another_model_is_refused_and_stopped() {
            // The fake greets as "FAKE model" with an all-zero hash, as the stub does: a
            // production config expects the verified model's own hash.
            let mut expecting = config(&[], GIB);
            expecting.expected_model = Some(ModelInfo {
                name: "FAKE model".to_owned(),
                sha256: "ab".repeat(32),
            });
            let runner = Runner::new(expecting);
            assert_eq!(
                runner.start(&Fixed(Some(8 * GIB))),
                Err(RunnerError::Start("not the verified model".to_owned()))
            );
            assert!(!runner.is_running());
            assert!(matches!(runner.status(), RunnerStatus::Failed { .. }));
            // The same model, expected as it greets, starts.
            let mut matching = config(&[], GIB);
            matching.expected_model = Some(model());
            Runner::new(matching).start(&Fixed(Some(8 * GIB))).unwrap();
        }

        #[test]
        fn a_start_prepared_per_use_hands_over_the_model_file_as_descriptor_3() {
            let dir = tempfile::tempdir().unwrap();
            let model_path = dir.path().join("FAKE-model.gguf");
            std::fs::write(&model_path, b"GGUF FAKE weights").unwrap();
            let runner = Runner::new(idle_config());
            let prepared = || {
                let mut config = config(&["--read-fd"], GIB);
                config.model_file = Some(Arc::new(std::fs::File::open(&model_path).unwrap()));
                Ok(config)
            };
            runner.start_with(&Fixed(Some(8 * GIB)), prepared).unwrap();
            let (explained, _) = runner
                .explain(runner.ticket(), "fd", "descriptor three", "en")
                .unwrap();
            assert_eq!(explained, "GGUF FAKE weights");
            // A refused preparation starts nothing.
            runner.stop();
            assert_eq!(
                runner.start_with(&Fixed(Some(8 * GIB)), || Err(RunnerError::NotRunning)),
                Err(RunnerError::NotRunning)
            );
            assert!(!runner.is_running());
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
        fn stopping_the_model_stops_what_it_started() {
            let dir = tempfile::tempdir().unwrap();
            let pid_file = dir.path().join("child.pid");
            let pid_arg = pid_file.to_str().unwrap().to_owned();
            let runner = Runner::new(config(&["--spawn-child", &pid_arg], GIB));
            runner.start(&Fixed(Some(8 * GIB))).unwrap();
            let child: libc::pid_t = std::fs::read_to_string(&pid_file)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            // SAFETY: signal 0 only asks whether the process exists.
            assert_eq!(unsafe { libc::kill(child, 0) }, 0);
            runner.stop();
            let deadline = Instant::now() + Duration::from_secs(5);
            // Gone, or a zombie its new parent has yet to reap: either way not
            // running. Read its state where /proc has it.
            loop {
                let state = std::fs::read_to_string(format!("/proc/{child}/stat")).ok();
                // SAFETY: as above.
                let exists = unsafe { libc::kill(child, 0) } == 0;
                let zombie = state
                    .as_deref()
                    .and_then(|stat| stat.rsplit(')').next())
                    .is_some_and(|rest| rest.trim_start().starts_with('Z'));
                if !exists || zombie {
                    break;
                }
                assert!(Instant::now() < deadline, "the model's child still runs");
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn a_model_over_its_memory_limit_ends_instead_of_starting() {
            let mut limited = config(&["--allocate", "536870912"], GIB);
            limited.memory_limit_bytes = Some(256 * 1024 * 1024);
            let runner = Runner::new(limited);
            assert_eq!(
                runner.start(&Fixed(Some(8 * GIB))),
                Err(RunnerError::Start("ended before its hello".to_owned()))
            );
            assert!(!runner.is_running());
            // The same model with no limit starts.
            let free = Runner::new(config(&["--allocate", "536870912"], GIB));
            free.start(&Fixed(Some(8 * GIB))).unwrap();
            assert!(free.is_running());
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
