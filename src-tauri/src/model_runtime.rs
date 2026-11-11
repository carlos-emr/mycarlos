//! The AI helper's model at work (#72): the app's one model runner, started on first use from
//! the model `local_model` verifies, kept while the vault is unlocked, stopped by a lock, by a
//! cancel, by a timeout, and before the model file is added or removed.
//!
//! Each start verifies the model again (`local_model`: size and hash, on the handle the helper
//! then reads) and attributes every answer to that verified model: the helper's hello must name
//! it exactly. The requests are checked here first, whatever the renderer sent: the pages and
//! their sizes, the term and its sentence, and the language.

use crate::local_runner::{
    self, check_budget, AnswerLimit, AnswerWatch, Budget, CheckStop, MemoryProbe, ModelInfo, Page,
    Runner, RunnerConfig, RunnerError, Sentence, SummaryRequest,
};
use crate::model_helper;
use crate::vault::{AiResultInput, AiTool};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

/// At most this many pages, each at most this many bytes, all at most this many: the reader's
/// own caps (`documentText.ts`, `pdf_view`).
pub(crate) const MAX_PAGES: usize = 50;
pub(crate) const MAX_PAGE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// The longest term, and the longest sentence it is explained in, in characters.
pub(crate) const MAX_TERM_CHARS: usize = 200;
pub(crate) const MAX_CONTEXT_CHARS: usize = 2_000;
/// The longest wait for the helper's hello once started: loading 2 to 4 GB.
pub(crate) const START_TIMEOUT: Duration = Duration::from_secs(120);
/// How long one answer may take (#72), scaled to its prompt: the prompt read at about 6.7
/// tokens a second and an answer of up to 400 tokens for a summary (an explanation's 220-token
/// cap) at about 1.7 a second, after 30 s. Never under 5 minutes, never over 20. Measured on a
/// 4-core test computer with other builds running (5 Nov 2026), Qwen3.5 4B read 8.5 to 12
/// prompt tokens a second and wrote 2.1 to 3.0; the prompt estimate also runs long, so the
/// limit was about twice the time taken.
pub(crate) const ANSWER_LIMIT: AnswerLimit = AnswerLimit {
    fixed: Duration::from_secs(30),
    per_prompt_token: Duration::from_millis(150),
    per_answer_token: Duration::from_millis(600),
    floor: Duration::from_secs(5 * 60),
    ceiling: Duration::from_secs(20 * 60),
};
/// Above the model's own size: its cache at the context used, and the runtime's memory. The
/// helper's measured peak above the file was 508 to 626 MiB for Qwen3.5 4B, the larger listed
/// model, at the full 8,192 context and prompts of up to 7,155 tokens (11 Nov 2026); 1 GiB keeps
/// about 400 MiB over the highest.
const WORKING_BYTES: u64 = 1024 * 1024 * 1024;
/// The helper's memory limit above the model's size.
const LIMIT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The model as `local_model` hands it over at each start: checked, and open.
pub(crate) struct Verified {
    /// Linux: a sealed memfd holding the bytes that were hashed. Windows: the file, held with
    /// writers denied.
    pub(crate) file: std::fs::File,
    pub(crate) path: PathBuf,
    pub(crate) info: ModelInfo,
    pub(crate) size_bytes: u64,
    /// How the helper puts the conversation to this model (from the model's list entry).
    pub(crate) chat_format: model_helper::ChatFormat,
    /// The model's cache per token of window, from its list entry (D249; 0: not known).
    pub(crate) cache_bytes_per_token: u32,
}

/// Why no model can be had now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// All but NotInstalled come from the install step's source (local_model), which lands separately.
#[allow(dead_code)]
pub(crate) enum Unavailable {
    NotInstalled,
    /// There, but not the file the list names (size or hash).
    Damaged,
    /// This computer cannot run it.
    Unsupported,
    /// Being added or removed.
    Busy,
    /// Not enough free memory to verify it now (Linux: the sealed copy needs room too).
    Memory,
    /// Its folder could not be read or prepared.
    Storage,
}

/// Where the verified model comes from: `local_model` in the app, a fake in tests.
pub(crate) trait ModelSource: Send + Sync {
    /// The installed model's size from the list, before anything is read, for the memory
    /// check; `None` when there is none.
    fn installed_size(&self) -> Option<u64>;
    /// The model, verified again now.
    fn verified(&self) -> Result<Verified, Unavailable>;
}

/// The app's source until the install step (`local_model`) can verify a model: there is none,
/// as `ai_model_status` says.
pub(crate) struct NoModel;

impl ModelSource for NoModel {
    fn installed_size(&self) -> Option<u64> {
        None
    }
    fn verified(&self) -> Result<Verified, Unavailable> {
        Err(Unavailable::NotInstalled)
    }
}

/// A summary request from the renderer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SummarizeRequest {
    pub(crate) pages: Vec<Page>,
    pub(crate) lang: String,
    /// The document, and the text ticket its pages came with (`vault_document_text`). With
    /// both, the answer is kept natively for that document's save (D2); with neither, it is
    /// only returned.
    #[serde(default)]
    pub(crate) record_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub(crate) ticket: Option<uuid::Uuid>,
}

/// An explain request from the renderer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExplainRequest {
    pub(crate) term: String,
    pub(crate) context: String,
    pub(crate) lang: String,
    /// The document the term is in: with it, the answer is kept for that document's save.
    #[serde(default)]
    pub(crate) record_id: Option<uuid::Uuid>,
}

/// A summary sentence's place in the document, as the reader found its quote (`SourceSpan` in
/// src/ai/types.ts): the page's index and the span on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceSpan {
    pub(crate) page: u32,
    pub(crate) start: u32,
    pub(crate) end: u32,
}

/// An answer as the runtime gave it, kept natively for the document's save (#212). The save
/// names it by document, tool, language and term; page code adds only a summary's source
/// places, so the words, the model and the flags the vault keeps are the runtime's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum KeptAnswer {
    Summary {
        sentences: Vec<Sentence>,
        /// The last page read, by its number from 1 (0 when none was), as the reader says it.
        last_page: u32,
        /// The index (from 0) of the last page the model read: no source lies past it.
        last_index: u32,
        /// The summary covers only part of the document: pages were left out of the text,
        /// the model read fewer than were sent, or only the start of the last one.
        partial: bool,
        /// Some page had no text, or was cut or refused when the text was read.
        pages_missing: bool,
        model: ModelInfo,
        lang: String,
        /// When it was written, in ms since the epoch.
        created_at: u64,
    },
    Explain {
        /// The term as asked, trimmed.
        term: String,
        /// The sentence the term was found in, as the reader sent it.
        context: String,
        text: String,
        model: ModelInfo,
        lang: String,
        created_at: u64,
    },
}

impl KeptAnswer {
    /// What the vault is told about this answer, and its bytes as the reader keeps them
    /// (`SummaryResult` / `ExplainResult` in src/ai/types.ts, as src/ai/localModel.ts builds
    /// them), with `sources` for a summary's sentences. None when the sources do not fit the
    /// answer: a summary needs one per sentence (a place or none), each on a page the model
    /// read; an explanation takes none.
    pub(crate) fn content(
        &self,
        sources: Option<&[Option<SourceSpan>]>,
    ) -> Option<(AiResultInput, String)> {
        let (input, value) = match self {
            KeptAnswer::Summary {
                sentences,
                last_page,
                last_index,
                partial,
                pages_missing,
                model,
                lang,
                created_at,
            } => {
                let sources = sources?;
                if sources.len() != sentences.len()
                    || sources.iter().flatten().any(|span| span.page > *last_index)
                {
                    return None;
                }
                let sentences: Vec<_> = sentences
                    .iter()
                    .zip(sources)
                    .map(|(sentence, source)| {
                        serde_json::json!({
                            "text": sentence.text,
                            "quote": sentence.quote,
                            "source": source,
                        })
                    })
                    .collect();
                (
                    AiResultInput {
                        tool: AiTool::Summary,
                        lang: lang.clone(),
                        term: None,
                        model_name: model.name.clone(),
                        model_sha256: model.sha256.clone(),
                    },
                    serde_json::json!({
                        "tool": "summary",
                        "sentences": sentences,
                        "model": model,
                        "lang": lang,
                        "createdAt": created_at,
                        "partial": partial,
                        "lastPage": last_page,
                        "pagesMissing": pages_missing,
                    }),
                )
            }
            KeptAnswer::Explain {
                term,
                context,
                text,
                model,
                lang,
                created_at,
            } => {
                if sources.is_some() {
                    return None;
                }
                (
                    AiResultInput {
                        tool: AiTool::Explain,
                        lang: lang.clone(),
                        term: Some(term.clone()),
                        model_name: model.name.clone(),
                        model_sha256: model.sha256.clone(),
                    },
                    serde_json::json!({
                        "tool": "explain",
                        "term": term,
                        "context": context,
                        "text": text,
                        "model": model,
                        "lang": lang,
                        "createdAt": created_at,
                    }),
                )
            }
        };
        Some((input, value.to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummaryResult {
    pub(crate) sentences: Vec<Sentence>,
    pub(crate) model: ModelInfo,
    pub(crate) last_page: u32,
    pub(crate) last_page_cut: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ExplainResult {
    pub(crate) text: String,
    pub(crate) model: ModelInfo,
}

/// What loading the model in use once says (D218), as the settings are told: it runs here, it
/// cannot run here, there is not enough free memory to try it now, or its file is damaged.
/// `Skipped` loads nothing and says nothing: an answer is asked or being written (its own start
/// then tells, as before), another check runs, the model is being added or removed, or the
/// vault locked meanwhile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LoadCheck {
    Ready,
    CannotRun,
    Memory,
    Damaged,
    Skipped,
}

impl From<AiError> for LoadCheck {
    fn from(error: AiError) -> Self {
        match error {
            AiError::Failed => Self::CannotRun,
            AiError::Memory => Self::Memory,
            AiError::Damaged => Self::Damaged,
            AiError::NotInstalled | AiError::Busy | AiError::Storage | AiError::Cancelled => {
                Self::Skipped
            }
        }
    }
}

/// Why a run gave nothing, as the renderer is told (`code`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AiError {
    NotInstalled,
    Damaged,
    /// Not enough free memory now.
    Memory,
    /// The model is being added or removed.
    Busy,
    /// The model's file could not be read from this computer's disk.
    Storage,
    /// The vault locked, or the reader left: nothing to show.
    Cancelled,
    /// Anything else: the helper could not start, answer, or answer in time, or the request
    /// was not one the reader sends.
    Failed,
}

impl AiError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::NotInstalled => "aiNotInstalled",
            Self::Damaged => "aiDamaged",
            Self::Memory => "aiMemory",
            Self::Busy => "aiBusy",
            Self::Storage => "aiStorage",
            Self::Cancelled => "aiCancelled",
            Self::Failed => "aiFailed",
        }
    }
}

/// The helper's thread count: one core left for myCarlos, at most four.
pub(crate) fn threads() -> u32 {
    let cores = std::thread::available_parallelism().map_or(2, |count| count.get());
    cores.saturating_sub(1).clamp(1, 4) as u32
}

/// The free memory a start needs for a model of `size` bytes, checked before the model is
/// verified. On Linux the sealed copy and the weights read from it are both in memory until the
/// helper has loaded and closed it.
pub(crate) fn needed_bytes(size: u64) -> u64 {
    let copies = if cfg!(target_os = "linux") { 2 } else { 1 };
    size.saturating_mul(copies).saturating_add(WORKING_BYTES)
}

/// The free memory still needed once the model is verified, checked again just before the
/// helper starts: on Linux the sealed copy then exists and already takes its share, so only the
/// loaded weights and the working memory are left to find.
pub(crate) fn needed_after_verifying(size: u64) -> u64 {
    size.saturating_add(WORKING_BYTES)
}

/// The memory a summary's larger window needs above the default one (D249): the model's cache
/// for each token past [`model_helper::CONTEXT_TOKENS`]. `WORKING_BYTES` already covers the
/// default window; 0 for it, and for a model whose cache cost is not known.
pub(crate) const fn window_extra_bytes(cache_bytes_per_token: u32, window: u32) -> u64 {
    (cache_bytes_per_token as u64)
        .saturating_mul(window.saturating_sub(model_helper::CONTEXT_TOKENS) as u64)
}

/// The helper's memory limit (Linux `RLIMIT_DATA`) above the model's size: room for the largest
/// window, so the app's own cap never refuses a window its memory check allowed.
pub(crate) const fn limit_bytes(cache_bytes_per_token: u32) -> u64 {
    LIMIT_BYTES.saturating_add(window_extra_bytes(
        cache_bytes_per_token,
        model_helper::CONTEXT_CAP,
    ))
}

/// The window a summary of about `need` tokens (prompt, pages, answer and margin) is read in
/// (D249). The smallest listed window that holds it, or the largest when none does; then, while
/// `fits` refuses its extra cache ([`window_extra_bytes`]), the next smaller one, down to the
/// default, which needs nothing more. Never above the model's trained context (`trained`, 0 when
/// not known). A model whose cache cost is not known (0) keeps the default window.
pub(crate) fn choose_window(
    need: u32,
    trained: u32,
    cache_bytes_per_token: u32,
    fits: impl Fn(u64) -> bool,
) -> u32 {
    if cache_bytes_per_token == 0 {
        return model_helper::CONTEXT_TOKENS;
    }
    let allowed = |window: &u32| trained == 0 || *window <= trained;
    let windows = model_helper::CONTEXT_WINDOWS
        .iter()
        .copied()
        .filter(allowed);
    let wanted = windows
        .clone()
        .find(|window| *window >= need)
        .or_else(|| windows.clone().last())
        .unwrap_or(model_helper::CONTEXT_TOKENS);
    windows
        .rev()
        .filter(|window| *window <= wanted)
        .find(|window| {
            *window == model_helper::CONTEXT_TOKENS
                || fits(window_extra_bytes(cache_bytes_per_token, *window))
        })
        .unwrap_or(model_helper::CONTEXT_TOKENS)
}

/// About the window a summary of `text_bytes` of pages needs to read them all (D249, design
/// section 4): the pages at about 3 bytes a token, the helper's words around them
/// ([`local_runner::SUMMARY_PROMPT_TOKENS`]), its longest summary and its margin. The helper
/// counts the pages' own tokens and reads the ones that fit.
pub(crate) fn summary_need(text_bytes: usize) -> u32 {
    let need = model_helper::window_need(
        local_runner::SUMMARY_PROMPT_TOKENS as usize,
        text_bytes.div_ceil(3),
        model_helper::SUMMARY_TOKENS,
    );
    u32::try_from(need).unwrap_or(u32::MAX)
}

/// The next smaller listed window than `window`, down to the default: what a summary asks for
/// once more when the helper could not make the one it asked (D249).
pub(crate) fn smaller_window(window: u32) -> u32 {
    model_helper::CONTEXT_WINDOWS
        .iter()
        .rev()
        .copied()
        .find(|smaller| *smaller < window)
        .unwrap_or(model_helper::CONTEXT_TOKENS)
}

/// The helper's word for a window it could not make (`Engine::use_window`).
const WINDOW_REFUSED: &str = "window";

/// Checks a summary request: 1 to [`MAX_PAGES`] pages, indexes strictly increasing and below
/// [`MAX_PAGES`], each page at most [`MAX_PAGE_BYTES`], all at most [`MAX_TEXT_BYTES`], some
/// text, and a language myCarlos speaks.
pub(crate) fn check_summary(request: &SummarizeRequest) -> Result<(), AiError> {
    let pages = &request.pages;
    let ordered = pages.windows(2).all(|pair| pair[0].index < pair[1].index);
    let total: usize = pages.iter().map(|page| page.text.len()).sum();
    let valid = !pages.is_empty()
        && pages.len() <= MAX_PAGES
        && ordered
        && pages
            .iter()
            .all(|page| (page.index as usize) < MAX_PAGES && page.text.len() <= MAX_PAGE_BYTES)
        && total <= MAX_TEXT_BYTES
        && pages.iter().any(|page| !page.text.trim().is_empty())
        && model_helper::language_name(&request.lang).is_some();
    valid.then_some(()).ok_or(AiError::Failed)
}

/// Checks an explain request: a term of 1 to [`MAX_TERM_CHARS`], a sentence of at most
/// [`MAX_CONTEXT_CHARS`], and a language myCarlos speaks.
pub(crate) fn check_explain(request: &ExplainRequest) -> Result<(), AiError> {
    let term = request.term.trim().chars().count();
    let valid = (1..=MAX_TERM_CHARS).contains(&term)
        && request.context.chars().count() <= MAX_CONTEXT_CHARS
        && model_helper::language_name(&request.lang).is_some();
    valid.then_some(()).ok_or(AiError::Failed)
}

/// The app's runner and where its model comes from.
pub(crate) struct ModelRuntime {
    runner: Arc<Runner>,
    source: Box<dyn ModelSource>,
    probe: Box<dyn MemoryProbe>,
    /// Builds the helper's start from the verified model.
    launch: fn(&Verified) -> Result<RunnerConfig, AiError>,
    /// The model the last answer here came from: the vault keeps an answer
    /// only under the model that gave one (#212).
    answered: Mutex<Option<ModelInfo>>,
    /// The claim of the last answer asked, until it ends: while it is current, a load check
    /// loads nothing (D218). Taken with the claim itself, so a check never misses an answer.
    /// An answer whose worker never runs (its hold ended first: a lock, a newer answer) is
    /// cleared by nothing here, but its claim is no longer current by then, so it holds no
    /// check back.
    answering: Mutex<Option<crate::local_runner::Ticket>>,
    /// A load check is running: a second one is not queued behind it.
    checking: AtomicBool,
    /// The cache cost per token of window of the model the helper was last started with, by
    /// its SHA-256 (D249): a summary's window is chosen for the model that is running.
    window_cost: Mutex<Option<(String, u32)>>,
}

/// Ends an answer's claim on the load check, however the answer ends.
struct AnswerEnds<'a> {
    answering: &'a Mutex<Option<crate::local_runner::Ticket>>,
    ticket: crate::local_runner::Ticket,
}

impl Drop for AnswerEnds<'_> {
    fn drop(&mut self) {
        let mut answering = self
            .answering
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *answering == Some(self.ticket) {
            *answering = None;
        }
    }
}

/// How often, and how far apart, a load check tries to stop its model while something holds
/// the process for a moment.
const CHECK_STOP_TRIES: usize = 50;
const CHECK_STOP_WAIT: Duration = Duration::from_millis(20);

/// Lets the next load check run, however this one ends.
struct CheckEnds<'a>(&'a AtomicBool);

impl Drop for CheckEnds<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl ModelRuntime {
    pub(crate) fn new(
        source: Box<dyn ModelSource>,
        probe: Box<dyn MemoryProbe>,
        launch: fn(&Verified) -> Result<RunnerConfig, AiError>,
    ) -> Self {
        Self {
            runner: Arc::new(Runner::new(idle_config())),
            source,
            probe,
            launch,
            answered: Mutex::new(None),
            answering: Mutex::new(None),
            checking: AtomicBool::new(false),
            window_cost: Mutex::new(None),
        }
    }

    /// The model the last answer here came from, if one has: what an answer
    /// the vault is asked to keep must name.
    pub(crate) fn answered_model(&self) -> Option<ModelInfo> {
        self.answered
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn answered_by(&self, model: &ModelInfo) {
        *self.answered.lock().unwrap_or_else(PoisonError::into_inner) = Some(model.clone());
    }

    /// The runner, for the lock to stop (`local_runner::install`).
    pub(crate) fn runner(&self) -> Arc<Runner> {
        Arc::clone(&self.runner)
    }

    /// Starts the helper if it is not running: the memory first, from the model's listed size,
    /// then the model verified again, then the start. The model that is running.
    fn start(&self, ticket: crate::local_runner::Ticket) -> Result<ModelInfo, AiError> {
        let mut unavailable = None;
        let prepare = || {
            let size = self.source.installed_size().ok_or_else(|| {
                unavailable = Some(AiError::NotInstalled);
                RunnerError::NotRunning
            })?;
            if let Budget::Refused {
                needed_bytes,
                available_bytes,
            } = check_budget(needed_bytes(size), &*self.probe)
            {
                unavailable = Some(AiError::Memory);
                return Err(RunnerError::Budget {
                    needed_bytes,
                    available_bytes,
                });
            }
            let verified = self.source.verified().map_err(|reason| {
                unavailable = Some(match reason {
                    Unavailable::NotInstalled => AiError::NotInstalled,
                    Unavailable::Damaged => AiError::Damaged,
                    Unavailable::Unsupported => AiError::Failed,
                    Unavailable::Storage => AiError::Storage,
                    Unavailable::Busy => AiError::Busy,
                    Unavailable::Memory => AiError::Memory,
                });
                RunnerError::NotRunning
            })?;
            *self
                .window_cost
                .lock()
                .unwrap_or_else(PoisonError::into_inner) =
                Some((verified.info.sha256.clone(), verified.cache_bytes_per_token));
            (self.launch)(&verified).map_err(|error| {
                unavailable = Some(error);
                RunnerError::NotRunning
            })
        };
        let started = self.runner.start_for(ticket, &*self.probe, prepare);
        match (started, unavailable) {
            (Ok(model), _) => Ok(model),
            (Err(_), Some(error)) => Err(error),
            (Err(error), None) => Err(from_runner(&error)),
        }
    }

    /// A summary of the pages that fit, in the language asked. `watch` is told the answer's
    /// own time limit as it is asked.
    #[cfg(test)]
    pub(crate) fn summarize(
        &self,
        request: SummarizeRequest,
        watch: AnswerWatch,
    ) -> Result<SummaryResult, AiError> {
        self.summarize_for(self.reserve_answer(), request, watch)
    }

    pub(crate) fn reserve_answer(&self) -> crate::local_runner::Ticket {
        let mut answering = self.answers();
        let ticket = self.runner.ticket();
        *answering = Some(ticket);
        ticket
    }

    fn answers(&self) -> std::sync::MutexGuard<'_, Option<crate::local_runner::Ticket>> {
        self.answering
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn answer_ends(&self, ticket: crate::local_runner::Ticket) -> AnswerEnds<'_> {
        AnswerEnds {
            answering: &self.answering,
            ticket,
        }
    }

    /// The claim a load check runs under (D218): the one in force now, ending none, unless an
    /// answer is asked or being written, when there is none and the check loads nothing. The
    /// command reads it before it checks that the vault is unlocked, so a lock in between ends
    /// the check.
    pub(crate) fn load_check_claim(&self) -> Option<crate::local_runner::Ticket> {
        let answering = self.answers();
        if answering.is_some_and(|answer| self.runner.is_current(answer)) {
            return None;
        }
        Some(self.runner.current_ticket())
    }

    /// Loads the model in use once under `claim` ([`Self::load_check_claim`]), to say now
    /// whether it runs on this computer, then stops it: no model stays loaded for a check
    /// (D218). It goes through an answer's own start (the memory, the model verified again,
    /// the helper's hello and card), so a model that passes starts the same way for its first
    /// answer, and its card confirms what the settings say it reads. It never waits behind an
    /// answer and never cancels one: an answer asked while it loads ends the check (`Skipped`)
    /// and loads the model itself, and one asked after the hello keeps the loaded model. A
    /// model an earlier answer loaded is `Ready` and stays loaded, as it would have. One check
    /// at a time.
    pub(crate) fn check_load(&self, claim: crate::local_runner::Ticket) -> LoadCheck {
        self.check_load_with(claim, || ())
    }

    /// [`Self::check_load`], with `loaded` run between the load and the stop (tests: an answer
    /// asked then).
    fn check_load_with(
        &self,
        claim: crate::local_runner::Ticket,
        loaded: impl FnOnce(),
    ) -> LoadCheck {
        if !self.runner.is_current(claim) || self.checking.swap(true, Ordering::SeqCst) {
            return LoadCheck::Skipped;
        }
        let _ends = CheckEnds(&self.checking);
        if self.runner.is_running() {
            return LoadCheck::Ready;
        }
        let outcome = match self.start(claim) {
            Ok(_) => LoadCheck::Ready,
            Err(error) => LoadCheck::from(error),
        };
        loaded();
        // Decided under the answers' lock: an answer asked before has a newer claim and keeps
        // the model; one asked after finds none and starts its own. That lock goes before the
        // helper is waited for, so an answer's admission (which holds the vault's and the idle
        // lock's) never waits for a model to exit. A stale request still leaving its start may
        // hold the process for a moment: tried again, never past about a second.
        for _ in 0..CHECK_STOP_TRIES {
            let answers = self.answers();
            match self.runner.stop_if_current(claim, move || drop(answers)) {
                CheckStop::Held => std::thread::sleep(CHECK_STOP_WAIT),
                CheckStop::Stopped | CheckStop::Claimed => break,
            }
        }
        outcome
    }

    pub(crate) fn summarize_for(
        &self,
        ticket: crate::local_runner::Ticket,
        request: SummarizeRequest,
        watch: AnswerWatch,
    ) -> Result<SummaryResult, AiError> {
        let _ends = self.answer_ends(ticket);
        check_summary(&request)?;
        self.runner.watch_answer(ticket, watch);
        let model = self.start(ticket)?;
        let text_bytes = request.pages.iter().map(|page| page.text.len()).sum();
        let window = self.window_for(&model, text_bytes);
        let mut asked = SummaryRequest {
            lang: request.lang,
            pages: request.pages,
            max_sentences: model_helper::MAX_SENTENCES,
            context_tokens: (window > model_helper::CONTEXT_TOKENS).then_some(window),
        };
        let summary = match self.runner.summarize(ticket, &asked) {
            // llama.cpp could not make the window after all: once more, one size smaller. The
            // watch was told the larger window's limit, which covers the smaller one's.
            Err(RunnerError::Model(reason))
                if reason == WINDOW_REFUSED && window > model_helper::CONTEXT_TOKENS =>
            {
                let smaller = smaller_window(window);
                asked.context_tokens = (smaller > model_helper::CONTEXT_TOKENS).then_some(smaller);
                self.runner.summarize(ticket, &asked)
            }
            outcome => outcome,
        }
        .map_err(|error| from_runner(&error))?;
        self.answered_by(&summary.model);
        Ok(SummaryResult {
            sentences: summary.sentences,
            model: summary.model,
            last_page: summary.last_page,
            last_page_cut: summary.last_page_cut,
        })
    }

    /// The window a summary of `text_bytes` of pages is read in by the running `model` (D249,
    /// design section 4): the smallest that holds them, up to the cap and the model's own
    /// context, as free memory allows the extra cache (the helper is running, so only that is
    /// still to find). The default window for a model whose cache cost or card is not known.
    fn window_for(&self, model: &ModelInfo, text_bytes: usize) -> u32 {
        let cost = self
            .window_cost
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .filter(|(sha256, _)| *sha256 == model.sha256)
            .map_or(0, |(_, cost)| *cost);
        let Some(card) = self.runner.card_for(&model.sha256) else {
            return model_helper::CONTEXT_TOKENS;
        };
        choose_window(
            summary_need(text_bytes),
            card.trained_context,
            cost,
            |extra| matches!(check_budget(extra, &*self.probe), Budget::Fits { .. }),
        )
    }

    /// What a term means in its sentence, in the language asked. `watch` is told the answer's
    /// own time limit as it is asked.
    pub(crate) fn explain_for(
        &self,
        ticket: crate::local_runner::Ticket,
        request: ExplainRequest,
        watch: AnswerWatch,
    ) -> Result<ExplainResult, AiError> {
        let _ends = self.answer_ends(ticket);
        check_explain(&request)?;
        self.runner.watch_answer(ticket, watch);
        self.start(ticket)?;
        let (text, model) = self
            .runner
            .explain(ticket, request.term.trim(), &request.context, &request.lang)
            .map_err(|error| from_runner(&error))?;
        self.answered_by(&model);
        Ok(ExplainResult { text, model })
    }

    /// Ends the run in flight, if any: its process stops; the next run starts it again.
    pub(crate) fn cancel(&self) {
        self.runner.cancel_all();
    }

    /// Stops the helper, for the model file to be added or removed.
    pub(crate) fn stop(&self) {
        self.runner.cancel_all();
        self.runner.stop();
    }
}

fn from_runner(error: &RunnerError) -> AiError {
    match error {
        RunnerError::Budget { .. } => AiError::Memory,
        RunnerError::Cancelled => AiError::Cancelled,
        RunnerError::Start(_)
        | RunnerError::NotRunning
        | RunnerError::Timeout
        | RunnerError::Protocol(_)
        | RunnerError::Model(_) => AiError::Failed,
    }
}

/// Never started: `ModelRuntime` starts with what `launch` builds.
fn idle_config() -> RunnerConfig {
    RunnerConfig {
        command: PathBuf::new(),
        args: Vec::new(),
        needed_bytes: u64::MAX,
        start_timeout: START_TIMEOUT,
        answer_limit: ANSWER_LIMIT,
        memory_limit_bytes: None,
        expected_model: None,
        model_file: None,
        sandboxed: true,
        generation_threads: None,
    }
}

/// The model helper's start for `verified`: this executable in its helper mode, sandboxed, with
/// the verified model expected in its hello. Production code builds no other helper start.
pub(crate) fn helper_launch(verified: &Verified) -> Result<RunnerConfig, AiError> {
    let executable = std::env::current_exe().map_err(|_| AiError::Failed)?;
    launch_at(executable, verified)
}

/// [`helper_launch`] with the executable given.
fn launch_at(executable: PathBuf, verified: &Verified) -> Result<RunnerConfig, AiError> {
    if !cfg!(any(target_os = "linux", windows)) {
        return Err(AiError::Failed);
    }
    let file = verified.file.try_clone().map_err(|_| AiError::Failed)?;
    #[cfg(target_os = "linux")]
    if !sealed(&file) {
        return Err(AiError::Damaged);
    }
    let model = if cfg!(windows) {
        model_helper::ModelFile::Path(verified.path.clone())
    } else {
        model_helper::ModelFile::Descriptor(model_helper::MODEL_FD)
    };
    let threads = threads();
    let args = model_helper::arguments(&model_helper::Settings {
        chat_format: verified.chat_format,
        threads,
        model,
        name: verified.info.name.clone(),
        sha256: verified.info.sha256.clone(),
    });
    Ok(RunnerConfig {
        command: executable,
        args,
        needed_bytes: needed_after_verifying(verified.size_bytes),
        start_timeout: START_TIMEOUT,
        answer_limit: ANSWER_LIMIT,
        memory_limit_bytes: Some(
            verified
                .size_bytes
                .saturating_add(limit_bytes(verified.cache_bytes_per_token)),
        ),
        expected_model: Some(verified.info.clone()),
        model_file: Some(Arc::new(file)),
        sandboxed: true,
        generation_threads: Some(threads),
    })
}

/// Whether `file` is a memfd sealed against every change, as `local_model` hands it over.
#[cfg(target_os = "linux")]
pub(crate) fn sealed(file: &std::fs::File) -> bool {
    use std::os::fd::AsRawFd;
    let all = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    // SAFETY: F_GET_SEALS only reads the descriptor's seals.
    let seals = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GET_SEALS) };
    seals >= 0 && seals & all == all
}

static APP: OnceLock<ModelRuntime> = OnceLock::new();

/// Sets where the app's model comes from and how free memory is read, once, at setup (the
/// install step: its store and its memory probe). `false` when the runtime was already made.
#[allow(dead_code)] // Called by the install step's setup (local_model), which lands separately.
pub(crate) fn init(source: Box<dyn ModelSource>, probe: Box<dyn MemoryProbe>) -> bool {
    let mut made = false;
    APP.get_or_init(|| {
        made = true;
        installed(ModelRuntime::new(source, probe, helper_launch))
    });
    made
}

/// The app's model runtime, installed for the lock. Until `init` names a source, there is no
/// model, as `ai_model_status` says.
pub(crate) fn app() -> &'static ModelRuntime {
    APP.get_or_init(|| {
        installed(ModelRuntime::new(
            Box::new(NoModel),
            Box::new(local_runner::ProcMemInfo),
            helper_launch,
        ))
    })
}

fn installed(runtime: ModelRuntime) -> ModelRuntime {
    local_runner::install(runtime.runner());
    runtime
}

/// Stops the app's model helper, if it runs: for `local_model` before it adds or removes the
/// model file.
#[allow(dead_code)] // Called by the install step (local_model), which lands separately.
pub(crate) fn stop() {
    app().stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(index: u32, text: &str) -> Page {
        Page {
            index,
            text: text.to_owned(),
        }
    }

    fn summary(pages: Vec<Page>, lang: &str) -> SummarizeRequest {
        SummarizeRequest {
            pages,
            lang: lang.to_owned(),
            record_id: None,
            ticket: None,
        }
    }

    #[test]
    fn a_summary_needs_its_pages_and_the_helpers_prompt_answer_and_margin() {
        assert_eq!(summary_need(0), 750 + 900 + 32);
        // The default window's room for the document (6,510 tokens, #301) needs it exactly.
        assert_eq!(summary_need(6_510 * 3), model_helper::CONTEXT_TOKENS);
        assert_eq!(
            summary_need(6_510 * 3 + 1),
            model_helper::CONTEXT_TOKENS + 1
        );
        assert_eq!(summary_need(usize::MAX), u32::MAX);
    }

    #[test]
    fn a_refused_window_is_asked_again_one_size_smaller() {
        assert_eq!(smaller_window(32_768), 24_576);
        assert_eq!(smaller_window(24_576), 16_384);
        assert_eq!(smaller_window(16_384), 12_288);
        assert_eq!(smaller_window(12_288), model_helper::CONTEXT_TOKENS);
        assert_eq!(
            smaller_window(model_helper::CONTEXT_TOKENS),
            model_helper::CONTEXT_TOKENS
        );
    }

    #[test]
    fn a_summary_request_must_be_pages_the_reader_could_have_read() {
        assert_eq!(
            check_summary(&summary(vec![page(0, "FAKE text")], "fr")),
            Ok(())
        );
        assert_eq!(
            check_summary(&summary(vec![page(0, "a"), page(3, "b")], "zh-TW")),
            Ok(())
        );
        let refused = [
            summary(vec![], "en"),
            summary(vec![page(1, "a"), page(1, "b")], "en"),
            summary(vec![page(2, "a"), page(1, "b")], "en"),
            summary(vec![page(50, "a")], "en"),
            summary(vec![page(0, &"x".repeat(MAX_PAGE_BYTES + 1))], "en"),
            summary(vec![page(0, "  \n ")], "en"),
            summary(vec![page(0, "FAKE text")], "de"),
            summary((0..51).map(|index| page(index, "a")).collect(), "en"),
            summary(
                (0..5)
                    .map(|index| page(index, &"x".repeat(MAX_PAGE_BYTES)))
                    .collect(),
                "en",
            ),
        ];
        for request in refused {
            assert_eq!(check_summary(&request), Err(AiError::Failed));
        }
    }

    #[test]
    fn an_explain_request_has_a_short_term_a_bounded_sentence_and_a_known_language() {
        let explain = |term: &str, context: &str, lang: &str| ExplainRequest {
            term: term.to_owned(),
            context: context.to_owned(),
            lang: lang.to_owned(),
            record_id: None,
        };
        assert_eq!(
            check_explain(&explain("HbA1c", "FAKE HbA1c 6.1%", "pl")),
            Ok(())
        );
        assert_eq!(check_explain(&explain("HbA1c", "", "en")), Ok(()));
        for request in [
            explain(" ", "x", "en"),
            explain(&"t".repeat(MAX_TERM_CHARS + 1), "x", "en"),
            explain("t", &"c".repeat(MAX_CONTEXT_CHARS + 1), "en"),
            explain("t", "x", "xx"),
        ] {
            assert_eq!(check_explain(&request), Err(AiError::Failed));
        }
    }

    #[test]
    fn an_answer_may_take_five_minutes_at_least_twenty_at_most_and_longer_for_a_longer_prompt() {
        assert_eq!(ANSWER_LIMIT.for_request(0, 0), Duration::from_secs(5 * 60));
        // The FAKE discharge summary (3,563 bytes): about 1,938 prompt tokens, estimated long.
        assert_eq!(
            ANSWER_LIMIT.for_request(1_938, 400),
            Duration::from_millis(30_000 + 1_938 * 150 + 400 * 600)
        );
        assert_eq!(
            ANSWER_LIMIT.for_request(model_helper::CONTEXT_TOKENS, 400),
            Duration::from_secs(20 * 60)
        );
    }

    #[test]
    fn the_requests_may_name_their_document_for_the_answer_to_be_kept() {
        let id = uuid::Uuid::nil().to_string();
        let summary: SummarizeRequest = serde_json::from_value(serde_json::json!({
            "pages": [{"index": 0, "text": "a"}], "lang": "en", "recordId": id, "ticket": id
        }))
        .unwrap();
        assert_eq!(summary.record_id, Some(uuid::Uuid::nil()));
        assert_eq!(summary.ticket, Some(uuid::Uuid::nil()));
        let explain: ExplainRequest = serde_json::from_value(serde_json::json!({
            "term": "a", "context": "b", "lang": "en", "recordId": id
        }))
        .unwrap();
        assert_eq!(explain.record_id, Some(uuid::Uuid::nil()));
        assert!(serde_json::from_value::<ExplainRequest>(serde_json::json!({
            "term": "a", "context": "b", "lang": "en", "ticket": id
        }))
        .is_err());
    }

    fn kept_summary() -> KeptAnswer {
        KeptAnswer::Summary {
            sentences: vec![
                Sentence {
                    text: "FAKE first".to_owned(),
                    quote: "FAKE quote one".to_owned(),
                },
                Sentence {
                    text: "FAKE second".to_owned(),
                    quote: String::new(),
                },
            ],
            last_page: 2,
            last_index: 1,
            partial: true,
            pages_missing: false,
            model: ModelInfo {
                name: "FAKE model".to_owned(),
                sha256: "0".repeat(64),
            },
            lang: "fr".to_owned(),
            created_at: 7,
        }
    }

    #[test]
    fn a_kept_summary_is_kept_as_the_reader_keeps_one_with_its_source_places() {
        let span = SourceSpan {
            page: 1,
            start: 3,
            end: 17,
        };
        let (input, content) = kept_summary().content(Some(&[Some(span), None])).unwrap();
        assert_eq!(
            (input.tool, input.lang.as_str(), input.term.as_deref()),
            (AiTool::Summary, "fr", None)
        );
        assert_eq!(
            (input.model_name.as_str(), input.model_sha256.len()),
            ("FAKE model", 64)
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).unwrap(),
            serde_json::json!({
                "tool": "summary",
                "sentences": [
                    {"text": "FAKE first", "quote": "FAKE quote one",
                     "source": {"page": 1, "start": 3, "end": 17}},
                    {"text": "FAKE second", "quote": "", "source": null}
                ],
                "model": {"name": "FAKE model", "sha256": "0".repeat(64)},
                "lang": "fr", "createdAt": 7, "partial": true, "lastPage": 2,
                "pagesMissing": false
            })
        );
        // The vault's own check takes it, under the model that gave it.
        assert!(crate::vault::check_ai_answer(
            &input,
            content.as_bytes(),
            Some(("FAKE model", &"0".repeat(64)))
        )
        .is_ok());
    }

    #[test]
    fn a_kept_answer_takes_only_sources_that_fit_it() {
        let span = |page| SourceSpan {
            page,
            start: 0,
            end: 1,
        };
        // One per sentence, no more and no fewer, and none for a summary is refused.
        assert!(kept_summary().content(Some(&[None])).is_none());
        assert!(kept_summary().content(Some(&[None, None, None])).is_none());
        assert!(kept_summary().content(None).is_none());
        // Never past the last page the model read.
        assert!(kept_summary()
            .content(Some(&[Some(span(2)), None]))
            .is_none());
        assert!(kept_summary()
            .content(Some(&[Some(span(0)), Some(span(1))]))
            .is_some());
        // An explanation has no source places.
        let explained = KeptAnswer::Explain {
            term: "HbA1c".to_owned(),
            context: "FAKE HbA1c 6.1%".to_owned(),
            text: "FAKE text".to_owned(),
            model: ModelInfo {
                name: "FAKE model".to_owned(),
                sha256: "0".repeat(64),
            },
            lang: "en".to_owned(),
            created_at: 7,
        };
        assert!(explained.content(Some(&[])).is_none());
        let (input, content) = explained.content(None).unwrap();
        assert_eq!(
            (input.tool, input.term.as_deref()),
            (AiTool::Explain, Some("HbA1c"))
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&content).unwrap(),
            serde_json::json!({
                "tool": "explain", "term": "HbA1c", "context": "FAKE HbA1c 6.1%",
                "text": "FAKE text",
                "model": {"name": "FAKE model", "sha256": "0".repeat(64)},
                "lang": "en", "createdAt": 7
            })
        );
    }

    #[test]
    fn the_requests_refuse_fields_the_reader_does_not_send() {
        assert!(
            serde_json::from_value::<SummarizeRequest>(serde_json::json!({
                "pages": [{"index": 0, "text": "a"}], "lang": "en", "maxSentences": 99
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<ExplainRequest>(serde_json::json!({
            "term": "a", "context": "b", "lang": "en"
        }))
        .is_ok());
    }

    #[test]
    fn the_results_have_the_shape_the_renderer_reads() {
        let model = ModelInfo {
            name: "FAKE model".to_owned(),
            sha256: "0".repeat(64),
        };
        assert_eq!(
            serde_json::to_value(SummaryResult {
                sentences: vec![Sentence {
                    text: "t".to_owned(),
                    quote: String::new()
                }],
                model: model.clone(),
                last_page: 3,
                last_page_cut: false,
            })
            .unwrap(),
            serde_json::json!({
                "sentences": [{"text": "t", "quote": ""}],
                "model": {"name": "FAKE model", "sha256": "0".repeat(64)},
                "lastPage": 3,
                "lastPageCut": false
            })
        );
        assert_eq!(
            serde_json::to_value(ExplainResult {
                text: "t".to_owned(),
                model
            })
            .unwrap()["text"],
            "t"
        );
    }

    #[test]
    fn the_codes_are_the_agreed_ones() {
        let codes: Vec<_> = [
            AiError::NotInstalled,
            AiError::Damaged,
            AiError::Memory,
            AiError::Busy,
            AiError::Cancelled,
            AiError::Failed,
        ]
        .map(AiError::code)
        .into();
        assert_eq!(
            codes,
            [
                "aiNotInstalled",
                "aiDamaged",
                "aiMemory",
                "aiBusy",
                "aiCancelled",
                "aiFailed"
            ]
        );
    }

    #[test]
    fn a_larger_window_needs_only_its_extra_cache() {
        const MIB: u64 = 1024 * 1024;
        let qwen = crate::local_model::CATALOG[0].cache_bytes_per_token;
        let gemma = crate::local_model::CATALOG[1].cache_bytes_per_token;
        assert_eq!((qwen, gemma), (32 * 1024, 6 * 1024));
        // The design note's table (11 Nov): the cache above the default window.
        for (window, qwen_mib, gemma_mib) in [
            (8_192, 0, 0),
            (12_288, 128, 24),
            (16_384, 256, 48),
            (24_576, 512, 96),
            (32_768, 768, 144),
        ] {
            assert_eq!(window_extra_bytes(qwen, window), qwen_mib * MIB, "{window}");
            assert_eq!(
                window_extra_bytes(gemma, window),
                gemma_mib * MIB,
                "{window}"
            );
        }
        assert_eq!(window_extra_bytes(0, 32_768), 0);
        assert_eq!(limit_bytes(qwen), LIMIT_BYTES + 768 * MIB);
        assert_eq!(limit_bytes(0), LIMIT_BYTES);
    }

    #[test]
    fn a_window_is_the_smallest_that_holds_the_document_as_memory_allows() {
        let qwen = 32 * 1024;
        let plenty = |_extra: u64| true;
        assert_eq!(choose_window(3_000, 262_144, qwen, plenty), 8_192);
        assert_eq!(choose_window(8_192, 262_144, qwen, plenty), 8_192);
        assert_eq!(choose_window(8_193, 262_144, qwen, plenty), 12_288);
        assert_eq!(choose_window(16_000, 262_144, qwen, plenty), 16_384);
        assert_eq!(choose_window(30_000, 262_144, qwen, plenty), 32_768);
        // Longer than the cap: the cap, and the reader's question says what it reads.
        assert_eq!(choose_window(90_000, 262_144, qwen, plenty), 32_768);
        // Never above the model's own context.
        assert_eq!(choose_window(30_000, 16_384, qwen, plenty), 16_384);
        // Memory for 512 MiB more but not 768: one size smaller, then the next.
        let some = |extra: u64| extra <= 512 * 1024 * 1024;
        assert_eq!(choose_window(30_000, 262_144, qwen, some), 24_576);
        assert_eq!(choose_window(30_000, 262_144, qwen, |_| false), 8_192);
        // A model whose cache cost is not known keeps the default window.
        assert_eq!(choose_window(30_000, 262_144, 0, plenty), 8_192);
    }

    #[test]
    fn threads_leave_a_core_and_stop_at_four() {
        assert!((1..=4).contains(&threads()));
    }

    #[test]
    fn the_memory_needed_counts_the_sealed_copy_on_linux_only_and_only_once() {
        let size = 2_000_000_000;
        let copies = if cfg!(target_os = "linux") { 2 } else { 1 };
        assert_eq!(needed_bytes(size), size * copies + WORKING_BYTES);
        // Checked again once the copy exists: it is not counted a second time.
        assert_eq!(needed_after_verifying(size), size + WORKING_BYTES);
        assert!(needed_after_verifying(size) <= needed_bytes(size));
    }

    #[test]
    fn a_start_asks_for_the_model_and_1_gib_above_it() {
        // Qwen3.5 4B's listed size.
        let size = 3_013_027_808;
        assert_eq!(needed_after_verifying(size), 4_086_769_632);
        let expected = if cfg!(target_os = "linux") {
            7_099_797_440
        } else {
            4_086_769_632
        };
        assert_eq!(needed_bytes(size), expected);
    }

    struct Fixed(Option<u64>);

    impl MemoryProbe for Fixed {
        fn available_bytes(&self) -> Option<u64> {
            self.0
        }
    }

    struct Fake {
        size: Option<u64>,
        verified: Result<(), Unavailable>,
        asked: Arc<std::sync::atomic::AtomicUsize>,
        /// The model file's path, its SHA-256 and its cache per token of window (D249).
        path: PathBuf,
        sha256: String,
        cache_bytes_per_token: u32,
    }

    impl ModelSource for Fake {
        fn installed_size(&self) -> Option<u64> {
            self.size
        }
        fn verified(&self) -> Result<Verified, Unavailable> {
            self.asked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.verified?;
            Ok(Verified {
                file: tempfile::tempfile().unwrap(),
                path: self.path.clone(),
                info: ModelInfo {
                    name: "FAKE model".to_owned(),
                    sha256: self.sha256.clone(),
                },
                size_bytes: 1024,
                chat_format: model_helper::ChatFormat::Builtin,
                cache_bytes_per_token: self.cache_bytes_per_token,
            })
        }
    }

    fn never_launch(_: &Verified) -> Result<RunnerConfig, AiError> {
        Err(AiError::Failed)
    }

    fn runtime(fake: Fake, free: Option<u64>) -> ModelRuntime {
        ModelRuntime::new(Box::new(fake), Box::new(Fixed(free)), never_launch)
    }

    fn fake(
        size: Option<u64>,
        verified: Result<(), Unavailable>,
    ) -> (Fake, Arc<std::sync::atomic::AtomicUsize>) {
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        (
            Fake {
                size,
                verified,
                asked: Arc::clone(&asked),
                path: PathBuf::from("/FAKE/model.gguf"),
                sha256: "ab".repeat(32),
                cache_bytes_per_token: 0,
            },
            asked,
        )
    }

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn no_model_no_memory_or_a_bad_model_refuse_before_anything_starts() {
        let request = || summary(vec![page(0, "FAKE text")], "en");
        let (none, _) = fake(None, Err(Unavailable::NotInstalled));
        assert_eq!(
            runtime(none, Some(64 * GIB)).summarize(request(), Box::new(|_| ())),
            Err(AiError::NotInstalled)
        );
        // Too little memory: the model is not even verified (no copy of it is made).
        let (small, asked) = fake(Some(4 * GIB), Ok(()));
        assert_eq!(
            runtime(small, Some(GIB)).summarize(request(), Box::new(|_| ())),
            Err(AiError::Memory)
        );
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);
        let (unknown, _) = fake(Some(GIB), Ok(()));
        assert_eq!(
            runtime(unknown, None).summarize(request(), Box::new(|_| ())),
            Err(AiError::Memory)
        );
        for (reason, error) in [
            (Unavailable::Damaged, AiError::Damaged),
            (Unavailable::Busy, AiError::Busy),
            (Unavailable::NotInstalled, AiError::NotInstalled),
            (Unavailable::Memory, AiError::Memory),
            (Unavailable::Storage, AiError::Storage),
            (Unavailable::Unsupported, AiError::Failed),
        ] {
            let (bad, asked) = fake(Some(GIB), Err(reason));
            assert_eq!(
                runtime(bad, Some(64 * GIB)).summarize(request(), Box::new(|_| ())),
                Err(error)
            );
            assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        }
        // An invalid request is refused before any of it.
        let (never, asked) = fake(Some(GIB), Ok(()));
        assert_eq!(
            runtime(never, Some(64 * GIB)).summarize(summary(vec![], "en"), Box::new(|_| ())),
            Err(AiError::Failed)
        );
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[test]
    fn a_refused_run_names_no_model_for_the_vault_to_keep_an_answer_under() {
        let (bad, _) = fake(Some(GIB), Err(Unavailable::Damaged));
        let runtime = runtime(bad, Some(64 * GIB));
        assert_eq!(runtime.answered_model(), None);
        assert!(runtime
            .summarize(summary(vec![page(0, "FAKE text")], "en"), Box::new(|_| ()))
            .is_err());
        assert_eq!(runtime.answered_model(), None);
    }

    /// A load check as the command makes one: the claim first, then the check.
    fn check(runtime: &ModelRuntime) -> LoadCheck {
        runtime
            .load_check_claim()
            .map_or(LoadCheck::Skipped, |claim| runtime.check_load(claim))
    }

    #[test]
    fn a_load_check_says_why_a_model_cannot_start_here_or_not_now() {
        // A start the app cannot build: this computer cannot run it.
        let (source, asked) = fake(Some(GIB), Ok(()));
        assert_eq!(
            check(&runtime(source, Some(64 * GIB))),
            LoadCheck::CannotRun
        );
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
        // Too little free memory: not even verified, and no figure is given.
        let (source, asked) = fake(Some(4 * GIB), Ok(()));
        assert_eq!(check(&runtime(source, Some(GIB))), LoadCheck::Memory);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);
        for (reason, outcome) in [
            (Unavailable::Damaged, LoadCheck::Damaged),
            (Unavailable::Unsupported, LoadCheck::CannotRun),
            (Unavailable::Memory, LoadCheck::Memory),
            (Unavailable::Busy, LoadCheck::Skipped),
            (Unavailable::Storage, LoadCheck::Skipped),
            (Unavailable::NotInstalled, LoadCheck::Skipped),
        ] {
            let (source, _) = fake(Some(GIB), Err(reason));
            assert_eq!(
                check(&runtime(source, Some(64 * GIB))),
                outcome,
                "{reason:?}"
            );
        }
    }

    #[test]
    fn a_load_check_loads_nothing_while_an_answer_is_asked_and_never_ends_it() {
        let (source, asked) = fake(Some(GIB), Ok(()));
        let runtime = runtime(source, Some(64 * GIB));
        let answer = runtime.reserve_answer();
        assert_eq!(check(&runtime), LoadCheck::Skipped);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(runtime.runner.is_current(answer));
        // Once that answer has ended (here, refused at its start), a check loads again.
        assert_eq!(
            runtime.summarize_for(
                answer,
                summary(vec![page(0, "FAKE text")], "en"),
                Box::new(|_| ())
            ),
            Err(AiError::Failed)
        );
        assert_eq!(check(&runtime), LoadCheck::CannotRun);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 2);
        // A lock between the claim and the check ends the check: nothing is loaded.
        let claim = runtime.load_check_claim().unwrap();
        runtime.cancel();
        assert_eq!(runtime.check_load(claim), LoadCheck::Skipped);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 2);
        // An answer that never ran because the vault locked holds nothing back either.
        let _never_run = runtime.reserve_answer();
        runtime.cancel();
        assert_eq!(check(&runtime), LoadCheck::CannotRun);
    }

    #[test]
    fn the_load_check_outcomes_have_the_shape_the_settings_read() {
        for (outcome, word) in [
            (LoadCheck::Ready, "ready"),
            (LoadCheck::CannotRun, "cannotRun"),
            (LoadCheck::Memory, "memory"),
            (LoadCheck::Damaged, "damaged"),
            (LoadCheck::Skipped, "skipped"),
        ] {
            assert_eq!(serde_json::to_value(outcome).unwrap(), word);
        }
    }

    /// The fake model of `local_runner`'s tests, through the Python on the test machine: it
    /// greets as the helper does, unsandboxed, and any hello is accepted.
    #[cfg(unix)]
    mod with_the_fake_model {
        use super::*;
        use crate::local_runner::RunnerStatus;
        use std::sync::atomic::Ordering::SeqCst;

        fn fake_model(args: &[&str], start_timeout: Duration) -> RunnerConfig {
            let path = std::env::var_os("PATH").expect("PATH");
            let python3 = std::env::split_paths(&path)
                .map(|dir| dir.join("python3"))
                .find(|candidate| candidate.is_file())
                .expect("python3 on PATH");
            let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/local-runner/fake-model.py");
            let mut all = vec![script.into_os_string()];
            all.extend(args.iter().map(std::ffi::OsString::from));
            RunnerConfig {
                command: python3,
                args: all,
                needed_bytes: 0,
                start_timeout,
                answer_limit: crate::local_runner::AnswerLimit::fixed(Duration::from_secs(10)),
                memory_limit_bytes: None,
                expected_model: None,
                model_file: None,
                sandboxed: false,
                generation_threads: None,
            }
        }

        fn greets(_: &Verified) -> Result<RunnerConfig, AiError> {
            Ok(fake_model(&[], Duration::from_secs(10)))
        }

        fn never_greets(_: &Verified) -> Result<RunnerConfig, AiError> {
            Ok(fake_model(&["--mute"], Duration::from_secs(1)))
        }

        fn greets_late(_: &Verified) -> Result<RunnerConfig, AiError> {
            Ok(fake_model(&["--greet-after", "2"], Duration::from_secs(10)))
        }

        fn answers_slowly(_: &Verified) -> Result<RunnerConfig, AiError> {
            Ok(fake_model(&["--slow", "2"], Duration::from_secs(10)))
        }

        fn with(
            launch: fn(&Verified) -> Result<RunnerConfig, AiError>,
        ) -> (ModelRuntime, Arc<std::sync::atomic::AtomicUsize>) {
            let (source, asked) = fake(Some(GIB), Ok(()));
            (
                ModelRuntime::new(Box::new(source), Box::new(Fixed(Some(64 * GIB))), launch),
                asked,
            )
        }

        #[test]
        fn a_load_check_starts_the_model_once_and_stops_it_again() {
            let (runtime, asked) = with(greets);
            assert_eq!(check(&runtime), LoadCheck::Ready);
            assert_eq!(asked.load(SeqCst), 1);
            assert!(!runtime.runner.is_running());
            assert!(matches!(
                runtime.runner.status(),
                RunnerStatus::Installed { .. }
            ));
        }

        #[test]
        fn an_answer_asked_while_the_check_loads_ends_the_check_and_loads_once_itself() {
            let (runtime, asked) = with(greets_late);
            let runtime = Arc::new(runtime);
            let claim = runtime.load_check_claim().unwrap();
            let checker = {
                let runtime = Arc::clone(&runtime);
                std::thread::spawn(move || runtime.check_load(claim))
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !matches!(runtime.runner.status(), RunnerStatus::Starting) {
                assert!(std::time::Instant::now() < deadline, "never loading");
                std::thread::sleep(Duration::from_millis(20));
            }
            let answer = runtime.reserve_answer();
            assert_eq!(checker.join().unwrap(), LoadCheck::Skipped);
            // Nothing is left from the check, and the answer's claim stands.
            assert!(!runtime.runner.is_running());
            assert!(runtime.runner.is_current(answer));
            assert_eq!(asked.load(SeqCst), 1);
            // The answer loads the model once, itself.
            assert!(runtime
                .summarize_for(
                    answer,
                    summary(vec![page(0, "FAKE text. The FAKE clinic phoned.")], "en"),
                    Box::new(|_| ()),
                )
                .is_ok());
            assert_eq!(asked.load(SeqCst), 2);
            assert!(runtime.runner.is_running());
            runtime.stop();
        }

        #[test]
        fn an_answer_asked_after_the_hello_and_before_the_stop_keeps_the_model() {
            let (runtime, asked) = with(greets);
            let claim = runtime.load_check_claim().unwrap();
            let mut answer = None;
            assert_eq!(
                runtime.check_load_with(claim, || answer = Some(runtime.reserve_answer())),
                LoadCheck::Ready
            );
            let answer = answer.unwrap();
            assert!(runtime.runner.is_running());
            assert!(runtime.runner.is_current(answer));
            // The answer uses the model the check loaded: no second load.
            assert!(runtime
                .summarize_for(
                    answer,
                    summary(vec![page(0, "FAKE text. The FAKE clinic phoned.")], "en"),
                    Box::new(|_| ()),
                )
                .is_ok());
            assert_eq!(asked.load(SeqCst), 1);
            runtime.stop();
        }

        #[test]
        fn a_model_that_never_greets_within_the_start_limit_cannot_run_here() {
            let (runtime, _) = with(never_greets);
            assert_eq!(check(&runtime), LoadCheck::CannotRun);
            assert!(!runtime.runner.is_running());
        }

        #[test]
        fn a_load_check_while_an_answer_is_written_loads_nothing_and_keeps_its_model() {
            let (runtime, asked) = with(answers_slowly);
            let runtime = Arc::new(runtime);
            let ticket = runtime.reserve_answer();
            let writer = {
                let runtime = Arc::clone(&runtime);
                std::thread::spawn(move || {
                    runtime.summarize_for(
                        ticket,
                        summary(vec![page(0, "FAKE text. The FAKE clinic phoned.")], "en"),
                        Box::new(|_| ()),
                    )
                })
            };
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !matches!(runtime.runner.status(), RunnerStatus::Working { .. }) {
                assert!(std::time::Instant::now() < deadline, "never answering");
                std::thread::sleep(Duration::from_millis(20));
            }
            assert_eq!(check(&runtime), LoadCheck::Skipped);
            assert!(writer.join().unwrap().is_ok());
            // One load, the answer's; its model stays loaded, as before.
            assert_eq!(asked.load(SeqCst), 1);
            assert!(runtime.runner.is_running());
            // A check now finds it loaded: it runs here, and it stays.
            assert_eq!(check(&runtime), LoadCheck::Ready);
            assert!(runtime.runner.is_running());
            assert_eq!(asked.load(SeqCst), 1);
            runtime.stop();
        }

        /// Free memory a test changes as it goes.
        struct Shared(Arc<std::sync::atomic::AtomicU64>);

        impl MemoryProbe for Shared {
            fn available_bytes(&self) -> Option<u64> {
                Some(self.0.load(SeqCst))
            }
        }

        /// A launch is a plain function, so the fake model's path names the file its windows
        /// are logged to (`--log-windows`).
        fn windows_log(verified: &Verified) -> &str {
            verified.path.to_str().expect("a log path")
        }

        fn logs_windows(verified: &Verified) -> Result<RunnerConfig, AiError> {
            let log = windows_log(verified);
            Ok(fake_model(
                &["--card", "--log-windows", log],
                Duration::from_secs(10),
            ))
        }

        fn refuses_windows(verified: &Verified) -> Result<RunnerConfig, AiError> {
            let log = windows_log(verified);
            Ok(fake_model(
                &["--card", "--refuse-window", "--log-windows", log],
                Duration::from_secs(10),
            ))
        }

        fn logs_windows_without_a_card(verified: &Verified) -> Result<RunnerConfig, AiError> {
            let log = windows_log(verified);
            Ok(fake_model(&["--log-windows", log], Duration::from_secs(10)))
        }

        /// A runtime whose model costs Qwen3.5 4B's 32 KiB a token of window, with `free`
        /// bytes free; and the log of the windows its summaries asked for.
        fn windowed(
            launch: fn(&Verified) -> Result<RunnerConfig, AiError>,
            free: &Arc<std::sync::atomic::AtomicU64>,
        ) -> (ModelRuntime, tempfile::TempDir) {
            let folder = tempfile::tempdir().unwrap();
            let (mut source, _) = fake(Some(GIB), Ok(()));
            source.path = folder.path().join("windows.log");
            // The fake model's hello names this file.
            source.sha256 = "0".repeat(64);
            source.cache_bytes_per_token = 32 * 1024;
            let probe = Box::new(Shared(Arc::clone(free)));
            (ModelRuntime::new(Box::new(source), probe, launch), folder)
        }

        fn windows_asked(folder: &tempfile::TempDir) -> String {
            std::fs::read_to_string(folder.path().join("windows.log")).unwrap_or_default()
        }

        /// One FAKE page of about `bytes` bytes (about a third as many tokens).
        fn long(bytes: usize) -> SummarizeRequest {
            let text = "FAKE clinic note. ".repeat(bytes / 18);
            summary(vec![page(0, &text)], "en")
        }

        #[test]
        fn a_long_summary_is_read_in_the_window_that_holds_it_as_memory_allows() {
            const MIB: u64 = 1024 * 1024;
            let free = Arc::new(std::sync::atomic::AtomicU64::new(64 * GIB));
            let (runtime, folder) = windowed(logs_windows, &free);
            // About 1,700, 9,700, 13,700 and 31,700 tokens: 8k, 12k, 16k and 32k.
            for bytes in [0, 24_000, 36_000, 90_000] {
                let request = if bytes == 0 {
                    summary(vec![page(0, "FAKE text. The FAKE clinic phoned.")], "en")
                } else {
                    long(bytes)
                };
                assert!(runtime.summarize(request, Box::new(|_| ())).is_ok());
            }
            assert_eq!(windows_asked(&folder), "none\n12288\n16384\n32768\n");
            // Memory for 128 MiB more but not 256: 12k for the 16k document; then none at all.
            free.store(200 * MIB, SeqCst);
            assert!(runtime.summarize(long(36_000), Box::new(|_| ())).is_ok());
            free.store(0, SeqCst);
            assert!(runtime.summarize(long(36_000), Box::new(|_| ())).is_ok());
            assert_eq!(
                windows_asked(&folder),
                "none\n12288\n16384\n32768\n12288\nnone\n"
            );
            runtime.stop();
        }

        #[test]
        fn a_window_the_helper_cannot_make_is_asked_once_more_one_size_smaller() {
            let free = Arc::new(std::sync::atomic::AtomicU64::new(64 * GIB));
            let (runtime, folder) = windowed(refuses_windows, &free);
            // 12k refused: read in the default window.
            assert!(runtime.summarize(long(24_000), Box::new(|_| ())).is_ok());
            assert_eq!(windows_asked(&folder), "12288\nnone\n");
            // 32k refused, then 24k: once only, and the answer fails.
            assert_eq!(
                runtime.summarize(long(90_000), Box::new(|_| ())).err(),
                Some(AiError::Failed)
            );
            assert_eq!(windows_asked(&folder), "12288\nnone\n32768\n24576\n");
            runtime.stop();
        }

        #[test]
        fn a_model_without_a_card_keeps_the_default_window() {
            let free = Arc::new(std::sync::atomic::AtomicU64::new(64 * GIB));
            let (runtime, folder) = windowed(logs_windows_without_a_card, &free);
            assert!(runtime.summarize(long(36_000), Box::new(|_| ())).is_ok());
            assert_eq!(windows_asked(&folder), "none\n");
            runtime.stop();
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_a_fully_sealed_memfd_is_handed_to_the_helper() {
        assert!(!sealed(&tempfile::tempfile().unwrap()));
        let verified = Verified {
            file: tempfile::tempfile().unwrap(),
            path: PathBuf::from("/FAKE/model.gguf"),
            info: ModelInfo {
                name: "FAKE model".to_owned(),
                sha256: "ab".repeat(32),
            },
            size_bytes: 1024,
            chat_format: model_helper::ChatFormat::Builtin,
            cache_bytes_per_token: 0,
        };
        assert_eq!(helper_launch(&verified).err(), Some(AiError::Damaged));
    }
}

/// For tests/model_helper.rs only (test builds with the `ai-helper-stub` feature): the real
/// runner and launcher, started on the stub helper at `executable`, so that CI drives the
/// sandbox, cancel, lock and timeouts without a model. No command reaches it.
#[doc(hidden)]
#[cfg(all(feature = "ai-helper-stub", any(target_os = "linux", windows)))]
pub mod testing {
    use super::*;

    /// Plenty of memory, whatever the computer: the stub needs little.
    struct Plenty;

    impl MemoryProbe for Plenty {
        fn available_bytes(&self) -> Option<u64> {
            Some(u64::MAX)
        }
    }

    /// The stub, started through the app's launcher, sandboxed as the model helper is.
    pub struct StubRunner {
        runner: Arc<Runner>,
    }

    impl StubRunner {
        /// The stub at `executable`, answering after `delay_ms`. `expected_sha256`: the hash a
        /// start expects in the hello, as a production start expects the verified model's;
        /// `None` expects the stub's own (all zeros).
        pub fn new(
            executable: &std::path::Path,
            delay_ms: u64,
            answer_timeout: Duration,
            expected_sha256: Option<&str>,
        ) -> Self {
            let config = RunnerConfig {
                command: executable.to_owned(),
                args: vec![
                    model_helper::HELPER_ARG.into(),
                    model_helper::STUB_ARG.into(),
                    delay_ms.to_string().into(),
                ],
                needed_bytes: 0,
                start_timeout: Duration::from_secs(30),
                answer_limit: crate::local_runner::AnswerLimit::fixed(answer_timeout),
                memory_limit_bytes: Some(1024 * 1024 * 1024),
                expected_model: Some(ModelInfo {
                    name: model_helper::STUB_NAME.to_owned(),
                    sha256: expected_sha256.map_or_else(|| "0".repeat(64), str::to_owned),
                }),
                model_file: None,
                sandboxed: true,
                generation_threads: None,
            };
            Self {
                runner: Arc::new(Runner::new(config)),
            }
        }

        /// Starts it: the name it greeted with, or why not.
        pub fn start(&self) -> Result<String, String> {
            self.runner
                .start(&Plenty)
                .map(|model| model.name)
                .map_err(|error| format!("{error:?}"))
        }

        /// A summary of `pages` (index, text): its sentences (text, quote) and the last page.
        pub fn summarize(
            &self,
            pages: &[(u32, &str)],
        ) -> Result<(Vec<(String, String)>, u32), String> {
            let request = SummaryRequest {
                lang: "en".to_owned(),
                pages: pages
                    .iter()
                    .map(|(index, text)| Page {
                        index: *index,
                        text: (*text).to_owned(),
                    })
                    .collect(),
                max_sentences: model_helper::MAX_SENTENCES,
                context_tokens: None,
            };
            self.runner
                .summarize(self.runner.ticket(), &request)
                .map(|summary| {
                    (
                        summary
                            .sentences
                            .into_iter()
                            .map(|sentence| (sentence.text, sentence.quote))
                            .collect(),
                        summary.last_page,
                    )
                })
                .map_err(|error| format!("{error:?}"))
        }

        pub fn explain(&self, term: &str) -> Result<String, String> {
            self.runner
                .explain(self.runner.ticket(), term, "FAKE sentence.", "en")
                .map(|(text, _)| text)
                .map_err(|error| format!("{error:?}"))
        }

        /// What the sandbox lets the stub do (`model_helper::confine::probe`).
        pub fn probe(&self, what: &str) -> Result<String, String> {
            self.runner
                .probe(self.runner.ticket(), what)
                .map_err(|error| format!("{error:?}"))
        }

        /// Ends the request in flight, as a closing reader does.
        pub fn cancel(&self) {
            self.runner.cancel_all();
        }

        /// Stops it as a lock does: installed as the app's runner, then the lock hook.
        pub fn lock(&self) {
            local_runner::install(Arc::clone(&self.runner));
            local_runner::on_lock();
            local_runner::uninstall();
        }

        pub fn is_running(&self) -> bool {
            self.runner.is_running()
        }

        pub fn stop(&self) {
            self.runner.stop();
        }
    }
}

/// For tests/model_engine.rs only: the app's own helper start (`helper_launch`) on a model file a
/// test wrote, handed over as `local_model` hands one over, so that CI runs the real engine in
/// its sandbox on each desktop system. No command reaches it.
#[doc(hidden)]
#[cfg(any(target_os = "linux", windows))]
pub mod engine_testing {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};

    struct Plenty;

    impl MemoryProbe for Plenty {
        fn available_bytes(&self) -> Option<u64> {
            Some(u64::MAX)
        }
    }

    pub struct ModelRunner {
        runner: Arc<Runner>,
        /// The quotes the last summary had that were not in the pages read.
        unlocated: std::sync::Mutex<Vec<String>>,
    }

    impl ModelRunner {
        /// Starts the helper at `executable` on the model at `path`: on Linux copied into a
        /// sealed memfd as it is hashed, on Windows held open with writers denied (the file must
        /// be readable by AppContainers). The reason, when it does not start.
        pub fn start(executable: &std::path::Path, path: &std::path::Path) -> Result<Self, String> {
            Self::start_with(executable, path, "builtin")
        }

        /// As [`Self::start`], with the model's chat format by its word (`builtin`, `gemma4`).
        pub fn start_with(
            executable: &std::path::Path,
            path: &std::path::Path,
            chat_format: &str,
        ) -> Result<Self, String> {
            let chat_format = match chat_format {
                "builtin" => model_helper::ChatFormat::Builtin,
                "gemma4" => model_helper::ChatFormat::Gemma4,
                other => return Err(format!("unknown chat format {other}")),
            };
            let (file, sha256, size_bytes) = handed_over(path)?;
            let verified = Verified {
                file,
                path: path.to_owned(),
                info: ModelInfo {
                    name: "FAKE test model".to_owned(),
                    sha256,
                },
                size_bytes,
                chat_format,
                cache_bytes_per_token: 0,
            };
            let config = launch_at(executable.to_owned(), &verified)
                .map_err(|error| format!("{error:?}"))?;
            // The runner keeps no model file of its own: this one start hands the sealed copy
            // over and lets it go once the helper has greeted, as the app does. So a test holds
            // the model once, in the helper, not twice (Linux: a 3 GB memfd beside the weights).
            let runner = Arc::new(Runner::new(RunnerConfig {
                model_file: None,
                ..config.clone()
            }));
            runner
                .start_with(&Plenty, move || Ok(config))
                .map_err(|error| format!("{error:?}"))?;
            Ok(Self {
                runner,
                unlocated: std::sync::Mutex::default(),
            })
        }

        /// What the helper said it found in the model file (model limits), as JSON, and why
        /// the app did not keep it, when it did not.
        pub fn card(&self) -> Option<(serde_json::Value, Option<String>)> {
            self.runner.last_card().map(|(card, rejected)| {
                (
                    serde_json::to_value(card).unwrap_or_default(),
                    rejected.map(|why| format!("{why:?}")),
                )
            })
        }

        /// A summary of `pages` (index, text) in `lang`: sentences (text, quote), last page.
        pub fn summarize(
            &self,
            lang: &str,
            pages: &[(u32, &str)],
        ) -> Result<(Vec<(String, String)>, u32), String> {
            let request = SummaryRequest {
                lang: lang.to_owned(),
                pages: pages
                    .iter()
                    .map(|(index, text)| Page {
                        index: *index,
                        text: (*text).to_owned(),
                    })
                    .collect(),
                max_sentences: model_helper::MAX_SENTENCES,
                context_tokens: None,
            };
            self.runner
                .summarize(self.runner.ticket(), &request)
                .map(|summary| {
                    *self.unlocated.lock().unwrap() = summary.unlocated_quotes;
                    (
                        summary
                            .sentences
                            .into_iter()
                            .map(|sentence| (sentence.text, sentence.quote))
                            .collect(),
                        summary.last_page,
                    )
                })
                .map_err(|error| format!("{error:?}"))
        }

        /// What the last summary's quotes said where they were not in the pages read.
        pub fn last_unlocated(&self) -> Vec<String> {
            self.unlocated.lock().unwrap().clone()
        }

        /// How the last answer was made: prompt and answer tokens, and their times.
        pub fn last_stats(&self) -> String {
            self.runner.last_stats().map_or_else(
                || "no stats".to_owned(),
                |s| {
                    format!(
                        "prompt {} tokens {:.1} s on {} threads (prefix {} tokens, {}, {} bytes), \
                         answer {} tokens {:.1} s{} on {} threads, {} grammar scans",
                        s.prompt_tokens,
                        s.prompt_ms as f64 / 1000.0,
                        s.batch_threads,
                        s.prefix_len,
                        if s.cache_hit { "put back" } else { "read" },
                        s.snapshot_bytes,
                        s.answer_tokens,
                        s.answer_ms as f64 / 1000.0,
                        if s.capped { " (capped)" } else { "" },
                        s.threads,
                        s.grammar_scans
                    )
                },
            )
        }

        /// The last answer's instruction prefix: its length in tokens, whether its state was put
        /// back rather than read, and the size of that kept state.
        pub fn last_prefix(&self) -> Option<(u32, bool, u64)> {
            self.runner
                .last_stats()
                .map(|stats| (stats.prefix_len, stats.cache_hit, stats.snapshot_bytes))
        }

        /// The hash of the token ids the last answer was written in (see `Stats::answer_hash`).
        pub fn last_answer_hash(&self) -> Option<u64> {
            self.runner.last_stats().map(|stats| stats.answer_hash)
        }

        /// The threads the last answer was written on, and its prompt read on.
        pub fn last_threads(&self) -> Option<(u32, u32)> {
            self.runner
                .last_stats()
                .map(|stats| (stats.threads, stats.batch_threads))
        }

        /// Answers are written on `threads` threads from now on, whatever the computer's load;
        /// `None` chooses from the load again.
        pub fn override_threads(&self, threads: Option<u32>) {
            self.runner.override_threads(threads);
        }

        /// What `term` means in `context`, in `lang`.
        pub fn explain(&self, lang: &str, term: &str, context: &str) -> Result<String, String> {
            self.runner
                .explain(self.runner.ticket(), term, context, lang)
                .map(|(text, _)| text)
                .map_err(|error| format!("{error:?}"))
        }

        pub fn stop(&self) {
            self.runner.stop();
        }
    }

    /// The file read once and hashed as it is read: the handle the helper gets (Linux: a sealed
    /// memfd written in the same pass), its SHA-256 and its size.
    fn handed_over(path: &std::path::Path) -> Result<(std::fs::File, String, u64), String> {
        let text = |error: std::io::Error| error.to_string();
        let mut source = std::fs::File::open(path).map_err(text)?;
        let mut copy = copy_for_helper()?;
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = source.read(&mut buffer).map_err(text)?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
            size += read as u64;
            if let Some(copy) = copy.as_mut() {
                copy.write_all(&buffer[..read]).map_err(text)?;
            }
        }
        let file = match copy {
            Some(copy) => seal(copy)?,
            None => held_open(path)?,
        };
        Ok((file, format!("{:x}", hash.finalize()), size))
    }

    /// Linux: the memfd the bytes are copied into.
    #[cfg(target_os = "linux")]
    fn copy_for_helper() -> Result<Option<std::fs::File>, String> {
        use std::os::fd::FromRawFd;
        // SAFETY: a NUL-terminated name and known flags; the descriptor, when valid, is owned by
        // the File made from it.
        let fd = unsafe {
            libc::memfd_create(
                c"mycarlos-model".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if fd < 0 {
            return Err("memfd".to_owned());
        }
        // SAFETY: a fresh descriptor nobody else holds.
        Ok(Some(unsafe { std::fs::File::from_raw_fd(fd) }))
    }

    #[cfg(target_os = "linux")]
    fn seal(file: std::fs::File) -> Result<std::fs::File, String> {
        use std::os::fd::AsRawFd;
        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        // SAFETY: adds seals to a descriptor this function owns.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
            return Err("seals".to_owned());
        }
        Ok(file)
    }

    #[cfg(target_os = "linux")]
    fn held_open(_path: &std::path::Path) -> Result<std::fs::File, String> {
        Err("no copy".to_owned())
    }

    /// Windows: no copy; the file itself is held.
    #[cfg(windows)]
    fn copy_for_helper() -> Result<Option<std::fs::File>, String> {
        Ok(None)
    }

    #[cfg(windows)]
    fn seal(file: std::fs::File) -> Result<std::fs::File, String> {
        Ok(file)
    }

    #[cfg(windows)]
    fn held_open(path: &std::path::Path) -> Result<std::fs::File, String> {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ: others may read it, nobody may write it while it is held.
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(path)
            .map_err(|error| error.to_string())
    }
}
