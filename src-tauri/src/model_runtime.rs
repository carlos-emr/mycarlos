//! The AI helper's model at work (#72): the app's one model runner, started on first use from
//! the model `local_model` verifies, kept while the vault is unlocked, stopped by a lock, by a
//! cancel, by a timeout, and before the model file is added or removed.
//!
//! Each start verifies the model again (`local_model`: size and hash, on the handle the helper
//! then reads) and attributes every answer to that verified model: the helper's hello must name
//! it exactly. The requests are checked here first, whatever the renderer sent: the pages and
//! their sizes, the term and its sentence, and the language.

use crate::local_runner::{
    self, check_budget, AnswerLimit, AnswerWatch, Budget, MemoryProbe, ModelInfo, Page, Runner,
    RunnerConfig, RunnerError, Sentence, SummaryRequest,
};
use crate::model_helper;
use crate::vault::{AiResultInput, AiTool};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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
/// tokens a second and an answer of up to 600 tokens for a summary (an explanation's 220-token
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
/// Above the model's own size: its cache at the context used, and the runtime's memory.
const WORKING_BYTES: u64 = 3 * 512 * 1024 * 1024;
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
    /// The document's page count, as its text read found it (`vault_document_text`), when the
    /// renderer gives it: with a last page read after a gap, the result says whether that is the
    /// document's own last page (E4b). A kept answer's text ticket gives it instead.
    #[serde(default)]
    pub(crate) page_count: Option<u32>,
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

/// Exact page identities read by a summary: the sent prefix through its head,
/// plus only the explicitly reported later tail. Missing or unread gap pages stay out.
pub(crate) fn summary_read_pages(
    sent: &[u32],
    last_head: u32,
    tail: Option<u32>,
) -> Option<Vec<u32>> {
    if sent.is_empty()
        || sent.len() > MAX_PAGES
        || sent.iter().any(|&page| page as usize >= MAX_PAGES)
        || !sent.windows(2).all(|pair| pair[0] < pair[1])
    {
        return None;
    }
    let head_at = sent.iter().position(|&page| page == last_head)?;
    let mut read = sent[..=head_at].to_vec();
    if let Some(tail) = tail {
        if !sent[head_at + 1..].contains(&tail) {
            return None;
        }
        read.push(tail);
    }
    Some(read)
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
        /// Exact indexes the model read: its sent head prefix and optional tail, never the gap.
        read_pages: Vec<u32>,
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
    #[cfg(test)]
    pub(crate) fn content(
        &self,
        sources: Option<&[Option<SourceSpan>]>,
    ) -> Option<(AiResultInput, String)> {
        self.checked_content(sources).ok().flatten()
    }

    pub(crate) fn checked_content(
        &self,
        sources: Option<&[Option<SourceSpan>]>,
    ) -> Result<Option<(AiResultInput, String)>, crate::summary_contract::Error> {
        match self {
            KeptAnswer::Summary {
                sentences,
                last_page,
                read_pages,
                partial,
                pages_missing,
                model,
                lang,
                created_at,
            } => {
                let Some(sources) = sources else {
                    return Ok(None);
                };
                if sources.len() != sentences.len()
                    || sources.iter().flatten().any(|span| {
                        !read_pages.contains(&span.page)
                            || !crate::summary_contract::source_valid(span)
                    })
                {
                    return Ok(None);
                }
                let content = crate::summary_contract::serialize_summary(
                    sentences,
                    model,
                    lang,
                    crate::summary_contract::Metadata {
                        created_at: *created_at,
                        partial: *partial,
                        last_page: *last_page,
                        pages_missing: *pages_missing,
                    },
                    sources,
                )?;
                Ok(Some((
                    AiResultInput {
                        tool: AiTool::Summary,
                        lang: lang.clone(),
                        term: None,
                        model_name: model.name.clone(),
                        model_sha256: model.sha256.clone(),
                    },
                    content,
                )))
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
                    return Ok(None);
                }
                let value = serde_json::json!({ "tool": "explain", "term": term, "context": context,
                    "text": text, "model": model, "lang": lang, "createdAt": created_at });
                let content = value.to_string();
                Ok(Some((
                    AiResultInput {
                        tool: AiTool::Explain,
                        lang: lang.clone(),
                        term: Some(term.clone()),
                        model_name: model.name.clone(),
                        model_sha256: model.sha256.clone(),
                    },
                    content,
                )))
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SummaryResult {
    pub(crate) sentences: Vec<Sentence>,
    pub(crate) model: ModelInfo,
    pub(crate) last_page: u32,
    pub(crate) last_page_cut: bool,
    /// The document's last page, read after a gap (left out when there was none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tail_page: Option<u32>,
    /// With a tail page and the document's page count: whether the tail is the document's own
    /// last page, or only the last page of the text read (its 50-page or 1 MiB cap, or a last
    /// page that was blank or refused), so the reader can say "the last page" only when it is.
    /// Left out when either is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tail_is_last_page: Option<bool>,
}

/// Whether `tail_page` is the document's last page, when both are known.
pub(crate) fn tail_is_last_page(tail_page: Option<u32>, page_count: Option<u32>) -> Option<bool> {
    Some(tail_page?.checked_add(1)? == page_count?)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ExplainResult {
    pub(crate) text: String,
    pub(crate) model: ModelInfo,
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
    /// The complete postprocessed summary cannot fit its saved-answer budget.
    SummaryTooLarge,
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
            Self::SummaryTooLarge => "aiSummaryTooLarge",
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
        && request
            .page_count
            .is_none_or(|count| pages.last().is_some_and(|last| last.index < count))
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
    /// then the model verified again, then the start.
    fn start(&self, ticket: crate::local_runner::Ticket) -> Result<(), AiError> {
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
            (self.launch)(&verified).map_err(|error| {
                unavailable = Some(error);
                RunnerError::NotRunning
            })
        };
        let started = self.runner.start_for(ticket, &*self.probe, prepare);
        match (started, unavailable) {
            (Ok(_), _) => Ok(()),
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
        self.runner.ticket()
    }

    pub(crate) fn summarize_for(
        &self,
        ticket: crate::local_runner::Ticket,
        request: SummarizeRequest,
        watch: AnswerWatch,
    ) -> Result<SummaryResult, AiError> {
        check_summary(&request)?;
        let page_count = request.page_count;
        self.runner.watch_answer(ticket, watch);
        self.start(ticket)?;
        let summary = self
            .runner
            .summarize(
                ticket,
                &SummaryRequest {
                    lang: request.lang,
                    pages: request.pages,
                    max_sentences: model_helper::MAX_SENTENCES,
                },
            )
            .map_err(|error| from_runner(&error))?;
        self.answered_by(&summary.model);
        Ok(SummaryResult {
            sentences: summary.sentences,
            model: summary.model,
            last_page: summary.last_page,
            last_page_cut: summary.last_page_cut,
            tail_page: summary.tail_page,
            tail_is_last_page: tail_is_last_page(summary.tail_page, page_count),
        })
    }

    /// What a term means in its sentence, in the language asked. `watch` is told the answer's
    /// own time limit as it is asked.
    pub(crate) fn explain_for(
        &self,
        ticket: crate::local_runner::Ticket,
        request: ExplainRequest,
        watch: AnswerWatch,
    ) -> Result<ExplainResult, AiError> {
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
        RunnerError::SummaryTooLarge => AiError::SummaryTooLarge,
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
        memory_limit_bytes: Some(verified.size_bytes.saturating_add(LIMIT_BYTES)),
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
            page_count: None,
        }
    }

    #[test]
    fn summary_size_error_survives_runner_and_owned_save_boundaries() {
        assert_eq!(
            from_runner(&RunnerError::SummaryTooLarge),
            AiError::SummaryTooLarge
        );
        assert_eq!(AiError::SummaryTooLarge.code(), "aiSummaryTooLarge");
        let mut answer = kept_summary();
        if let KeptAnswer::Summary { sentences, .. } = &mut answer {
            sentences[0].text = "x".repeat(crate::summary_contract::MAX_BYTES);
        }
        assert!(matches!(
            answer.checked_content(Some(&[None, None])),
            Err(crate::summary_contract::Error::TooLarge)
        ));
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
        // A page count, when given, is past the last page sent (E4b).
        let counted = |count| SummarizeRequest {
            page_count: Some(count),
            ..summary(vec![page(0, "a"), page(3, "b")], "en")
        };
        assert_eq!(check_summary(&counted(4)), Ok(()));
        assert_eq!(check_summary(&counted(70)), Ok(()));
        assert_eq!(check_summary(&counted(3)), Err(AiError::Failed));
        assert_eq!(check_summary(&counted(0)), Err(AiError::Failed));
        // The renderer may send it.
        let sent: SummarizeRequest = serde_json::from_value(serde_json::json!({
            "pages": [{"index": 0, "text": "FAKE text"}],
            "lang": "en",
            "pageCount": 12,
        }))
        .unwrap();
        assert_eq!(sent.page_count, Some(12));
    }

    #[test]
    fn a_tail_page_is_the_last_page_only_when_the_document_ends_there() {
        // The document's last page (index 11 of 12) read after a gap.
        assert_eq!(tail_is_last_page(Some(11), Some(12)), Some(true));
        // Only the text read's last page: a 70-page document cut at 50 pages, or a last page
        // that was blank or refused.
        assert_eq!(tail_is_last_page(Some(49), Some(70)), Some(false));
        assert_eq!(tail_is_last_page(Some(10), Some(12)), Some(false));
        // Unknown either way: left out.
        assert_eq!(tail_is_last_page(None, Some(12)), None);
        assert_eq!(tail_is_last_page(Some(11), None), None);
        assert_eq!(tail_is_last_page(Some(u32::MAX), Some(0)), None);
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
            read_pages: vec![0, 1],
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
    fn summary_read_pages_preserves_sparse_head_and_only_the_reported_tail() {
        assert_eq!(summary_read_pages(&[0, 1, 2], 0, Some(2)), Some(vec![0, 2]));
        assert_eq!(
            summary_read_pages(&[0, 2, 3, 4], 2, Some(4)),
            Some(vec![0, 2, 4])
        );
        assert_eq!(summary_read_pages(&[0, 2, 4], 2, None), Some(vec![0, 2]));
        assert_eq!(summary_read_pages(&[0, 2, 4], 4, None), Some(vec![0, 2, 4]));
        for (sent, head, tail) in [
            (vec![], 0, None),
            (vec![0, 2], 1, None),
            (vec![0, 2], 0, Some(1)),
            (vec![0, 2], 2, Some(0)),
            (vec![0, 2], 2, Some(2)),
            (vec![0, 0], 0, None),
            (vec![2, 0], 0, None),
            (vec![MAX_PAGES as u32], MAX_PAGES as u32, None),
        ] {
            assert!(summary_read_pages(&sent, head, tail).is_none());
        }
    }

    #[test]
    fn kept_tail_source_passes_the_save_contract_but_an_unread_gap_does_not() {
        let mut answer = kept_summary();
        if let KeptAnswer::Summary { read_pages, .. } = &mut answer {
            *read_pages = summary_read_pages(&[0, 1, 2], 0, Some(2)).unwrap();
        }
        let source = |page| SourceSpan {
            page,
            start: 0,
            end: 1,
        };
        let (input, content) = answer.content(Some(&[Some(source(2)), None])).unwrap();
        assert!(crate::vault::check_ai_answer(
            &input,
            content.as_bytes(),
            Some(("FAKE model", &"0".repeat(64)))
        )
        .is_ok());
        assert!(answer.content(Some(&[Some(source(0)), None])).is_some());
        assert!(answer.content(Some(&[Some(source(1)), None])).is_none());
        assert!(answer.content(Some(&[Some(source(3)), None])).is_none());
        assert!(answer.content(Some(&[None, None])).is_some());
    }

    #[test]
    fn kept_sources_refuse_absent_pages_inside_the_head_prefix_too() {
        let mut answer = kept_summary();
        if let KeptAnswer::Summary { read_pages, .. } = &mut answer {
            *read_pages = summary_read_pages(&[0, 2, 3, 4], 2, Some(4)).unwrap();
        }
        let source = |page| SourceSpan {
            page,
            start: 0,
            end: 1,
        };
        for page in [0, 2, 4] {
            assert!(answer.content(Some(&[Some(source(page)), None])).is_some());
        }
        for page in [1, 3, 5] {
            assert!(answer.content(Some(&[Some(source(page)), None])).is_none());
        }
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
                tail_page: None,
                tail_is_last_page: None,
            })
            .unwrap(),
            serde_json::json!({
                "sentences": [{"text": "t", "quote": ""}],
                "model": {"name": "FAKE model", "sha256": "0".repeat(64)},
                "lastPage": 3,
                "lastPageCut": false
            })
        );
        // A last page read after a gap is named; without one the shape is unchanged.
        assert_eq!(
            serde_json::to_value(SummaryResult {
                sentences: vec![Sentence {
                    text: "t".to_owned(),
                    quote: String::new()
                }],
                model: model.clone(),
                last_page: 3,
                last_page_cut: false,
                tail_page: Some(9),
                tail_is_last_page: Some(false),
            })
            .unwrap(),
            serde_json::json!({
                "sentences": [{"text": "t", "quote": ""}],
                "model": {"name": "FAKE model", "sha256": "0".repeat(64)},
                "lastPage": 3,
                "lastPageCut": false,
                "tailPage": 9,
                "tailIsLastPage": false
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
                path: PathBuf::from("/FAKE/model.gguf"),
                info: ModelInfo {
                    name: "FAKE model".to_owned(),
                    sha256: "ab".repeat(32),
                },
                size_bytes: 1024,
                chat_format: model_helper::ChatFormat::Builtin,
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
        /// Original model quotes rejected before post-steps, for diagnostics;
        /// final measured sentences separately report their current source location.
        unlocated: std::sync::Mutex<Vec<String>>,
        /// The model file's SHA-256 as it was handed over, and its size.
        model_sha256: String,
        model_bytes: u64,
    }

    /// A summary with what a measurement needs (the evaluation run in tests/model_engine.rs).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Measured {
        pub sentences: Vec<MeasuredSentence>,
        /// The index of the last page read, and whether only its start fitted.
        pub last_page: u32,
        pub last_page_cut: bool,
        /// The document's last page, read after a gap.
        pub tail_page: Option<u32>,
        /// The answer's `Stats` as the helper reports them: counts and times, never words.
        pub stats: Option<serde_json::Value>,
        /// The time limit the runner gave this answer.
        pub answer_limit_ms: u64,
        /// K17: the post-step's name, and every sentence it rewrote (before and after).
        pub post_step: &'static str,
        pub rewrites: Vec<MeasuredRewrite>,
        /// K19: the glossary's name, and every sentence it explained (before and after).
        pub glossary: &'static str,
        pub explained: Vec<MeasuredExplained>,
        /// K20: the safety checks' name, and every fallback (before: none when a quote was added).
        pub safety: &'static str,
        pub fallbacks: Vec<MeasuredFallback>,
    }

    /// K20: one fallback of the safety checks (`safety`).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeasuredFallback {
        pub check: &'static str,
        pub index: usize,
        pub before: Option<String>,
        pub after: String,
    }

    /// K19: one sentence the glossary step explained (`glossary`).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeasuredExplained {
        pub index: usize,
        pub before: String,
        pub after: String,
        pub terms: Vec<String>,
    }

    /// K17: one sentence the post-step rewrote (`addressee`): its place, the rewrite's kind, and
    /// the words before and after.
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeasuredRewrite {
        pub index: usize,
        pub kind: &'static str,
        pub before: String,
        pub after: String,
    }

    /// One summary sentence: its words, the quote the model wrote, and whether that quote was
    /// found in the pages read (the app shows "No source found" when it was not).
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeasuredSentence {
        pub text: String,
        pub quote: String,
        pub located: bool,
    }

    /// What a summary is made under in this build, for telling measurements apart: the system
    /// text, the summary request and grammar for `lang`, the caps, and a SHA-256 over all of them.
    pub fn summary_build(lang: &str) -> Result<serde_json::Value, String> {
        let language =
            model_helper::language_name(lang).ok_or_else(|| format!("unknown language {lang}"))?;
        let prompt = model_helper::summary_prompt(language, model_helper::MAX_SENTENCES);
        let grammar = model_helper::summary_grammar(model_helper::MAX_SENTENCES);
        let caps = serde_json::json!({
            "maxSentences": model_helper::MAX_SENTENCES,
            "summaryTokens": model_helper::SUMMARY_TOKENS,
            "contextTokens": model_helper::CONTEXT_TOKENS,
            "maxTextChars": model_helper::MAX_TEXT_CHARS,
            "maxQuoteChars": model_helper::MAX_QUOTE_CHARS,
        });
        let caps_text = caps.to_string();
        let mut hash = Sha256::new();
        for part in [model_helper::SYSTEM_PROMPT, &prompt, &grammar, &caps_text] {
            hash.update((part.len() as u64).to_le_bytes());
            hash.update(part.as_bytes());
        }
        Ok(serde_json::json!({
            "fingerprint": format!("{:x}", hash.finalize()),
            "systemPrompt": model_helper::SYSTEM_PROMPT,
            "summaryPrompt": prompt,
            "grammar": grammar,
            "caps": caps,
        }))
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
            let model_sha256 = sha256.clone();
            let verified = Verified {
                file,
                path: path.to_owned(),
                info: ModelInfo {
                    name: "FAKE test model".to_owned(),
                    sha256,
                },
                size_bytes,
                chat_format,
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
                model_sha256,
                model_bytes: size_bytes,
            })
        }

        /// The model file's SHA-256, taken while it was read for the helper, and its size.
        pub fn model_file(&self) -> (String, u64) {
            (self.model_sha256.clone(), self.model_bytes)
        }

        /// A summary of `pages` (index, text) in `lang`, as the app asks for one, with each
        /// sentence's own quote (also one that was not found), the fit, the stats and the limit.
        pub fn summarize_measured(
            &self,
            lang: &str,
            pages: &[(u32, &str)],
        ) -> Result<Measured, String> {
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
            };
            let text_bytes = pages.iter().map(|(_, text)| text.len()).sum();
            let (prompt, answer) = crate::local_runner::summary_request_size(text_bytes);
            let answer_limit_ms = ANSWER_LIMIT.for_request(prompt, answer).as_millis() as u64;
            let summary = self
                .runner
                .summarize(self.runner.ticket(), &request)
                .map_err(|error| format!("{error:?}"))?;
            let fallbacks = summary
                .fallbacks
                .into_iter()
                .map(|f| MeasuredFallback {
                    check: f.check,
                    index: f.index,
                    before: f.before,
                    after: f.after,
                })
                .collect();
            let explained = summary
                .explained
                .into_iter()
                .map(|e| MeasuredExplained {
                    index: e.index,
                    before: e.before,
                    after: e.after,
                    terms: e.terms,
                })
                .collect();
            let rewrites = summary
                .rewrites
                .into_iter()
                .map(|rewrite| MeasuredRewrite {
                    index: rewrite.index,
                    kind: rewrite.kind.name(),
                    before: rewrite.before,
                    after: rewrite.after,
                })
                .collect();
            // Post-steps can repair an unfound model quote. Original missing quotes stay
            // keyed to their sentence, so a repair cannot shift the next sentence's quote.
            let missing = summary.unlocated_quotes;
            let sentences = summary
                .sentences
                .into_iter()
                .enumerate()
                .map(|(index, sentence)| {
                    let (quote, located) = missing.for_measurement(index, sentence.quote);
                    MeasuredSentence {
                        text: sentence.text,
                        quote,
                        located,
                    }
                })
                .collect();
            Ok(Measured {
                sentences,
                last_page: summary.last_page,
                last_page_cut: summary.last_page_cut,
                tail_page: summary.tail_page,
                stats: self
                    .runner
                    .last_stats()
                    .and_then(|stats| serde_json::to_value(stats).ok()),
                answer_limit_ms,
                post_step: crate::addressee::NAME,
                rewrites,
                glossary: crate::glossary::NAME,
                explained,
                safety: crate::safety::NAME,
                fallbacks,
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
            };
            self.runner
                .summarize(self.runner.ticket(), &request)
                .map(|summary| {
                    *self.unlocated.lock().unwrap() = summary.unlocated_quotes.into_quotes();
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

        /// Original rejected model quotes, including any source later repaired.
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
