//! The order of events for one send (design 5.3), against a `Transport`, a `Confirmer` and the
//! vault, each a trait so that a test supplies fakes: no network, no real key, no dialog.
//!
//! 1. `prepare`: the text is re-checked in Rust (the same checks that guard a save: forbidden code
//!    points, the vault's own identifiers, dates). A hit refuses it and sends nothing.
//! 2. `send`: the native confirmation names the provider, the key, the model, the size and the cost.
//!    Only then is the history entry written, BEFORE the send; if that write fails, nothing is
//!    sent. Then the request, the validation, the restore, and a history entry for the answer.
//!
//! The history holds the provider, the model, the document, the outcome, the provider's request id
//! and the token counts. Never the text, the answer, the removed list or the key.

use std::sync::atomic::{AtomicBool, Ordering};

use uuid::Uuid;
use zeroize::Zeroizing;

use super::request::{self, build_summary_request, Estimate, ProviderRequest, RequestError};
use super::response::{clean_request_id, interpret, Failure, ProviderResponse};
use super::restore::{self, restore_with, Removed, RemovedError, Restorable};
use crate::history::{HistoryEntry, HistoryEvent};
use crate::text_recheck::{self, Hit};
use crate::ui_text::UiLocale;
use crate::vault::{KnownIdentifiers, VaultError, VaultStore};

/// Why a request got no response at all.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TransportFailure {
    /// No response: offline, DNS, TLS, a reset or a timeout. `maybe_arrived` is true when the
    /// failure came after the request was sent, so the text may have reached the provider.
    Unreachable {
        maybe_arrived: bool,
    },
    Cancelled,
}

/// The only thing that touches a network. A real one reaches `api.anthropic.com` (client.rs); the
/// tests supply a fake. It must stop soon after `cancel` is set.
pub(crate) trait Transport {
    fn send(
        &self,
        request: &ProviderRequest,
        cancel: &AtomicBool,
    ) -> Result<ProviderResponse, TransportFailure>;
}

/// What the native confirmation says (the title and the numbers come from the vault and from the
/// re-checked text, never from the page).
pub(crate) struct Confirmation {
    pub provider: &'static str,
    pub host: &'static str,
    pub model_label: &'static str,
    pub key_label: String,
    pub document_title: String,
    pub characters: usize,
    pub tokens: u64,
    pub cost_usd: f64,
}

/// A native dialog in the real thing: "Send to Anthropic?". `false` for Cancel, Escape and a
/// closed window. One confirmation covers one send of one text.
pub(crate) trait Confirmer {
    fn confirm(&self, what: &Confirmation) -> bool;
}

/// The vault as a send uses it.
pub(crate) trait SendVault {
    fn known_identifiers(&self, record: Uuid) -> Result<KnownIdentifiers, VaultError>;
    fn key_label(&self, key: Uuid) -> Result<String, VaultError>;
    fn key_secret(&self, key: Uuid) -> Result<Zeroizing<String>, VaultError>;
    fn document_title(&self, record: Uuid) -> Result<String, VaultError>;
    fn record(&self, entry: HistoryEntry) -> Result<(), VaultError>;
}

impl SendVault for VaultStore {
    fn known_identifiers(&self, record: Uuid) -> Result<KnownIdentifiers, VaultError> {
        VaultStore::known_identifiers(self, record)
    }
    fn key_label(&self, key: Uuid) -> Result<String, VaultError> {
        self.cloud_keys()?
            .into_iter()
            .find(|info| info.id == key)
            .map(|info| info.label)
            .ok_or(VaultError::NotFound)
    }
    fn key_secret(&self, key: Uuid) -> Result<Zeroizing<String>, VaultError> {
        self.cloud_key_secret(key)
    }
    fn document_title(&self, record: Uuid) -> Result<String, VaultError> {
        self.snapshot()?
            .records
            .into_iter()
            .find(|candidate| candidate.id == record && candidate.hidden.is_none())
            .map(|candidate| candidate.display_name)
            .ok_or(VaultError::NotFound)
    }
    fn record(&self, entry: HistoryEntry) -> Result<(), VaultError> {
        self.cloud_record_event(entry)
    }
}

#[derive(Debug)]
pub(crate) enum PrepareError {
    /// Text that still holds a vault identifier, a date or a forbidden code point: the ranges for
    /// the preview to mark. Nothing was sent.
    Recheck(Vec<Hit>),
    UnknownModel,
    BadText,
    /// The list of what was removed, or the placeholder words, failed the native check.
    BadRemoved(RemovedError),
    Vault(VaultError),
}

/// One text ready to send, after its re-check. Consumed by `send`, so one prepared text is one
/// send; dropped, it is zeroed. It never prints its text.
pub(crate) struct Prepared {
    record_id: Uuid,
    key_id: Uuid,
    model_id: &'static str,
    model_label: &'static str,
    language: UiLocale,
    labels: Vec<String>,
    text: Zeroizing<String>,
    /// What can be put back, worked out once here.
    restorable: Restorable,
    estimate: Estimate,
}

impl std::fmt::Debug for Prepared {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Prepared")
            .field("model", &self.model_id)
            .field("characters", &self.estimate.characters)
            .finish()
    }
}

impl Prepared {
    pub(crate) fn estimate(&self) -> &Estimate {
        &self.estimate
    }

    pub(crate) fn model_label(&self) -> &'static str {
        self.model_label
    }
}

/// What the page asks to send. Everything in it is checked by `prepare`; none is believed.
pub(crate) struct PrepareRequest<'a> {
    pub record_id: Uuid,
    pub key_id: Uuid,
    pub model_id: &'a str,
    pub language: UiLocale,
    pub text: &'a str,
    /// The document's own text, for the paste-back's ambiguous-marker rule.
    pub source: &'a str,
    pub labels: Vec<String>,
    pub removed: Vec<Removed>,
}

/// Re-checks `text` and keeps it for one send. The checks are a save's: a hit refuses.
pub(crate) fn prepare(
    vault: &impl SendVault,
    request: PrepareRequest<'_>,
) -> Result<Prepared, PrepareError> {
    let PrepareRequest {
        record_id,
        key_id,
        model_id,
        language,
        text,
        source,
        labels,
        removed,
    } = request;
    let model = request::model(model_id).ok_or(PrepareError::UnknownModel)?;
    if text.is_empty() || text.len() > request::MAX_TEXT_BYTES {
        return Err(PrepareError::BadText);
    }
    let hits = text_recheck::forbidden_ranges(text);
    if !hits.is_empty() {
        return Err(PrepareError::Recheck(hits));
    }
    let known = vault
        .known_identifiers(record_id)
        .map_err(PrepareError::Vault)?;
    let hits = text_recheck::identifier_hits(text, &known.names, &known.birth_dates);
    if !hits.is_empty() {
        return Err(PrepareError::Recheck(hits));
    }
    // The remover sends no date: each is a placeholder. One still standing means page code skipped it.
    let hits = text_recheck::date_hits(text);
    if !hits.is_empty() {
        return Err(PrepareError::Recheck(hits));
    }
    // The list the page sent is checked here: nothing else it says is believed.
    if source.len() > restore::MAX_SOURCE_BYTES {
        return Err(PrepareError::BadText);
    }
    restore::validate_removed(&removed, text, &labels).map_err(PrepareError::BadRemoved)?;
    let restorable = Restorable::new(&removed, source);
    drop(removed);
    // The key must exist (and be readable) now, so that a send does not fail late.
    vault.key_label(key_id).map_err(PrepareError::Vault)?;
    Ok(Prepared {
        record_id,
        key_id,
        model_id: model.id,
        model_label: model.label,
        language,
        labels,
        text: Zeroizing::new(text.to_owned()),
        restorable,
        estimate: request::estimate(text, model),
    })
}

/// A sentence of the answer, with the real details put back.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct RestoredSentence {
    pub text: String,
    pub quote: String,
}

impl Drop for RestoredSentence {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.text.zeroize();
        self.quote.zeroize();
    }
}

impl std::fmt::Debug for RestoredSentence {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RestoredSentence(..)")
    }
}

impl std::fmt::Debug for Sent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Sent")
            .field("sentences", &self.sentences.len())
            .field("flagged", &self.flagged.len())
            .finish()
    }
}

pub(crate) struct Sent {
    pub sentences: Vec<RestoredSentence>,
    /// Placeholder-shaped text that was not put back, as written: for the screen to mark.
    pub flagged: Vec<String>,
    pub request_id: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

#[derive(Debug)]
pub(crate) enum SendError {
    /// Cancel, Escape or a closed dialog: nothing was recorded or sent.
    Declined,
    /// The history entry could not be written, so nothing was sent.
    History(VaultError),
    /// A locked vault, or a key that is gone.
    Vault(VaultError),
    Request(RequestError),
    /// The send ended without an answer: said in plain words by the screen.
    /// The failure, and the provider's request id when a response carried one.
    Failed(Failure, Option<String>),
}

fn event(kind: HistoryEvent, record: Uuid, at_ms: u64) -> HistoryEntry {
    let mut entry = HistoryEntry::new(kind, at_ms);
    entry.record_id = Some(record);
    entry.how = Some("anthropic".to_owned());
    entry
}

/// Confirms, records, sends, validates, restores and records the answer. `now_ms` is the clock
/// (a fake in tests).
pub(crate) fn send(
    vault: &impl SendVault,
    transport: &impl Transport,
    confirmer: &impl Confirmer,
    prepared: Prepared,
    cancel: &AtomicBool,
    now_ms: impl Fn() -> u64,
) -> Result<Sent, SendError> {
    if cancel.load(Ordering::Acquire) {
        return Err(SendError::Failed(Failure::Cancelled, None));
    }
    let confirmation = Confirmation {
        provider: "Anthropic",
        host: request::HOST,
        model_label: prepared.model_label,
        key_label: vault.key_label(prepared.key_id).map_err(SendError::Vault)?,
        document_title: vault
            .document_title(prepared.record_id)
            .map_err(SendError::Vault)?,
        characters: prepared.estimate.characters,
        tokens: prepared.estimate.tokens,
        cost_usd: prepared.estimate.cost_usd,
    };
    if !confirmer.confirm(&confirmation) {
        return Err(SendError::Declined);
    }
    // The dialog can stay open for a long time: a lock, a consent turned off or a cancel while it
    // was open ends this before anything is recorded or sent.
    if cancel.load(Ordering::Acquire) {
        return Err(SendError::Failed(Failure::Cancelled, None));
    }
    let secret = vault
        .key_secret(prepared.key_id)
        .map_err(SendError::Vault)?;
    let provider_request = build_summary_request(
        &secret,
        prepared.model_id,
        prepared.language,
        &prepared.text,
    )
    .map_err(SendError::Request)?;
    drop(secret);
    // The record that text may leave the device comes BEFORE the send: if it cannot be written,
    // nothing is sent; if the app dies after this, the vault says the text may have gone.
    let mut sent = event(HistoryEvent::AiCloudSent, prepared.record_id, now_ms());
    sent.detail = Some(prepared.model_id.to_owned());
    vault.record(sent).map_err(SendError::History)?;

    // The provider's request id is kept on failures too: it is how the patient quotes the call.
    let mut failed_request_id = None;
    let outcome = match transport.send(&provider_request, cancel) {
        Ok(response) => {
            failed_request_id = clean_request_id(response.request_id.as_deref());
            interpret(&response).map(|answer| (answer, response.request_id.clone()))
        }
        Err(TransportFailure::Cancelled) => Err(Failure::Cancelled),
        Err(TransportFailure::Unreachable { maybe_arrived }) => {
            Err(Failure::Unreachable { maybe_arrived })
        }
    };
    drop(provider_request);
    let mut answered = event(HistoryEvent::AiCloudAnswered, prepared.record_id, now_ms());
    match &outcome {
        Ok((answer, _)) => {
            answered.detail = Some(format!(
                "ok {} in={} out={}",
                answer.request_id.as_deref().unwrap_or("-"),
                answer
                    .input_tokens
                    .map_or("-".to_owned(), |n| n.to_string()),
                answer
                    .output_tokens
                    .map_or("-".to_owned(), |n| n.to_string()),
            ));
        }
        Err(failure) => {
            answered.detail = Some(match &failed_request_id {
                Some(id) => format!("{} {id}", failure.name()),
                None => failure.name().to_owned(),
            })
        }
    }
    // The answer is not lost for want of a second entry.
    let _ = vault.record(answered);

    let (answer, _) =
        outcome.map_err(|failure| SendError::Failed(failure, failed_request_id.clone()))?;
    let mut flagged = Vec::new();
    let mut put_back = |text: &str| {
        let words: Vec<&str> = prepared.labels.iter().map(String::as_str).collect();
        let restored = restore_with(text, &prepared.restorable, &words);
        flagged.extend(restored.flagged);
        restored.text
    };
    let sentences = answer
        .sentences
        .iter()
        .map(|sentence| RestoredSentence {
            text: put_back(&sentence.text),
            quote: put_back(&sentence.quote),
        })
        .collect();
    Ok(Sent {
        sentences,
        flagged,
        request_id: answer.request_id,
        input_tokens: answer.input_tokens,
        output_tokens: answer.output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const KEY: &str = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2";

    /// A fake vault that logs what the send did to it.
    struct FakeVault {
        history: RefCell<Vec<HistoryEntry>>,
        fail_history: bool,
        names: Vec<String>,
        events: RefCell<Vec<&'static str>>,
    }

    impl FakeVault {
        fn new() -> Self {
            Self {
                history: RefCell::new(Vec::new()),
                fail_history: false,
                names: vec!["FAKE Jamie Fakeson".to_owned()],
                events: RefCell::new(Vec::new()),
            }
        }
    }

    impl SendVault for FakeVault {
        fn known_identifiers(&self, _: Uuid) -> Result<KnownIdentifiers, VaultError> {
            Ok(KnownIdentifiers {
                names: self.names.clone(),
                birth_dates: vec!["1961-04-17".to_owned()],
                doctor_names: vec![],
                clinic_names: vec![],
            })
        }
        fn key_label(&self, _: Uuid) -> Result<String, VaultError> {
            Ok("Home laptop".to_owned())
        }
        fn key_secret(&self, _: Uuid) -> Result<Zeroizing<String>, VaultError> {
            Ok(Zeroizing::new(KEY.to_owned()))
        }
        fn document_title(&self, _: Uuid) -> Result<String, VaultError> {
            Ok("FAKE Letter.pdf".to_owned())
        }
        fn record(&self, entry: HistoryEntry) -> Result<(), VaultError> {
            if self.fail_history {
                return Err(VaultError::Storage);
            }
            self.events.borrow_mut().push(match entry.event {
                HistoryEvent::AiCloudSent => "history:sent",
                HistoryEvent::AiCloudAnswered => "history:answered",
                _ => "history:other",
            });
            self.history.borrow_mut().push(entry);
            Ok(())
        }
    }

    struct FakeTransport<'a> {
        vault: &'a FakeVault,
        calls: RefCell<Vec<String>>,
        reply: Result<(u16, String), TransportFailure>,
    }

    impl Transport for FakeTransport<'_> {
        fn send(
            &self,
            request: &ProviderRequest,
            _cancel: &AtomicBool,
        ) -> Result<ProviderResponse, TransportFailure> {
            self.vault.events.borrow_mut().push("transport");
            self.calls
                .borrow_mut()
                .push(String::from_utf8(request.body.clone()).unwrap());
            match &self.reply {
                Ok((status, body)) => Ok(ProviderResponse {
                    status: *status,
                    request_id: Some("req_FAKE1".into()),
                    retry_after_secs: None,
                    body: body.as_bytes().to_vec(),
                }),
                Err(TransportFailure::Cancelled) => Err(TransportFailure::Cancelled),
                Err(TransportFailure::Unreachable { maybe_arrived }) => {
                    Err(TransportFailure::Unreachable {
                        maybe_arrived: *maybe_arrived,
                    })
                }
            }
        }
    }

    struct Confirm {
        answer: bool,
        seen: RefCell<Vec<(String, String, String, &'static str)>>,
    }

    impl Confirmer for Confirm {
        fn confirm(&self, what: &Confirmation) -> bool {
            self.seen.borrow_mut().push((
                what.key_label.clone(),
                what.document_title.clone(),
                what.model_label.to_owned(),
                what.host,
            ));
            self.answer
        }
    }

    fn yes() -> Confirm {
        Confirm {
            answer: true,
            seen: RefCell::new(Vec::new()),
        }
    }

    fn good_body() -> String {
        serde_json::json!({
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text":
                r#"{"sentences":[{"text":"[NAME 1] has a fever.","quote":"Patient [NAME 1] presents with fever"}]}"#}],
            "usage": {"input_tokens": 2914, "output_tokens": 611}
        })
        .to_string()
    }

    fn removed() -> Vec<Removed> {
        vec![Removed {
            replacement: "[NAME 1]".into(),
            original: "FAKE Morgan Example".into(),
            manual: false,
        }]
    }

    fn prepared(vault: &FakeVault, text: &str) -> Result<Prepared, PrepareError> {
        prepare(
            vault,
            PrepareRequest {
                record_id: Uuid::new_v4(),
                key_id: Uuid::new_v4(),
                model_id: "claude-opus-5-5",
                language: UiLocale::En,
                text,
                source: "",
                labels: vec!["NAME".to_owned(), "DATE".to_owned()],
                removed: removed(),
            },
        )
    }

    fn run(
        vault: &FakeVault,
        transport: &FakeTransport,
        confirm: &Confirm,
    ) -> Result<Sent, SendError> {
        let prepared = prepared(vault, "Patient [NAME 1] presents with fever. [DATE 1].").unwrap();
        send(
            vault,
            transport,
            confirm,
            prepared,
            &AtomicBool::new(false),
            || 5,
        )
    }

    #[test]
    fn a_confirmed_send_records_first_then_sends_then_restores_and_records_the_answer() {
        let vault = FakeVault::new();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, good_body())),
        };
        let confirm = yes();
        let sent = run(&vault, &transport, &confirm).unwrap();
        // The order: the entry for the send BEFORE the request, then the answer's.
        assert_eq!(
            *vault.events.borrow(),
            ["history:sent", "transport", "history:answered"]
        );
        // The confirmation named the key, the document, the model and the one host.
        assert_eq!(
            confirm.seen.borrow()[0],
            (
                "Home laptop".to_owned(),
                "FAKE Letter.pdf".to_owned(),
                "Claude Opus 5.5".to_owned(),
                "api.anthropic.com"
            )
        );
        // The real name is back in the answer, in the sentence and in the quote.
        assert_eq!(sent.sentences[0].text, "FAKE Morgan Example has a fever.");
        assert_eq!(
            sent.sentences[0].quote,
            "Patient FAKE Morgan Example presents with fever"
        );
        assert!(sent.flagged.is_empty());
        assert_eq!(sent.request_id.as_deref(), Some("req_FAKE1"));
        assert_eq!(
            (sent.input_tokens, sent.output_tokens),
            (Some(2914), Some(611))
        );
        // What went out held the placeholder text, never the removed name.
        let body = transport.calls.borrow()[0].clone();
        assert!(body.contains("[NAME 1]") && !body.contains("Morgan Example"));
    }

    #[test]
    fn the_history_never_holds_the_text_the_answer_the_key_or_the_removed_list() {
        let vault = FakeVault::new();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, good_body())),
        };
        run(&vault, &transport, &yes()).unwrap();
        let history = serde_json::to_string(&*vault.history.borrow()).unwrap();
        for secret in [
            "FAKEFAKE",
            "sk-ant",
            "Morgan",
            "presents with fever",
            "fever",
            "Home laptop",
        ] {
            assert!(!history.contains(secret), "{secret}: {history}");
        }
        let entries = vault.history.borrow();
        assert_eq!(entries[0].detail.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(
            entries[1].detail.as_deref(),
            Some("ok req_FAKE1 in=2914 out=611")
        );
    }

    #[test]
    fn no_confirmation_means_nothing_is_recorded_and_nothing_is_sent() {
        let vault = FakeVault::new();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, good_body())),
        };
        let no = Confirm {
            answer: false,
            seen: RefCell::new(vec![]),
        };
        assert!(matches!(
            run(&vault, &transport, &no),
            Err(SendError::Declined)
        ));
        assert!(transport.calls.borrow().is_empty());
        assert!(vault.history.borrow().is_empty());
    }

    #[test]
    fn a_history_write_that_fails_sends_nothing() {
        let mut vault = FakeVault::new();
        vault.fail_history = true;
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, good_body())),
        };
        assert!(matches!(
            run(&vault, &transport, &yes()),
            Err(SendError::History(_))
        ));
        assert!(transport.calls.borrow().is_empty());
    }

    #[test]
    fn a_text_that_still_holds_an_identifier_a_date_or_a_forbidden_code_point_is_refused() {
        let vault = FakeVault::new();
        for text in [
            "Seen FAKE Jamie Fakeson today.",
            "Born 1961-04-17.",
            "Visit on 2026-01-10.",
            "Hidden \u{202e} text",
        ] {
            match prepared(&vault, text) {
                Err(PrepareError::Recheck(hits)) => assert!(!hits.is_empty(), "{text}"),
                other => panic!("{text}: {other:?}"),
            }
        }
        // Over the cap, empty, and an unlisted model.
        assert!(matches!(
            prepared(&vault, &"x".repeat(request::MAX_TEXT_BYTES + 1)),
            Err(PrepareError::BadText)
        ));
        assert!(matches!(prepared(&vault, ""), Err(PrepareError::BadText)));
        assert!(matches!(
            prepare(
                &vault,
                PrepareRequest {
                    record_id: Uuid::new_v4(),
                    key_id: Uuid::new_v4(),
                    model_id: "gpt-4",
                    language: UiLocale::En,
                    text: "x",
                    source: "",
                    labels: vec!["NAME".to_owned()],
                    removed: vec![]
                }
            ),
            Err(PrepareError::UnknownModel)
        ));
        assert!(vault.history.borrow().is_empty());
    }

    #[test]
    fn every_failure_keeps_nothing_says_why_and_records_the_outcome() {
        for (reply, expected) in [
            (Ok((401, "{}".to_owned())), "keyRejected"),
            (Ok((402, "{}".to_owned())), "billing"),
            (Ok((429, "{}".to_owned())), "rateLimited"),
            (Ok((529, "{}".to_owned())), "busy"),
            (Ok((200, "not json".to_owned())), "unusable"),
            (
                Err(TransportFailure::Unreachable {
                    maybe_arrived: true,
                }),
                "unreachable",
            ),
            (Err(TransportFailure::Cancelled), "cancelled"),
        ] {
            let vault = FakeVault::new();
            let transport = FakeTransport {
                vault: &vault,
                calls: RefCell::new(vec![]),
                reply,
            };
            let result = run(&vault, &transport, &yes());
            let Err(SendError::Failed(failure, _)) = result else {
                panic!("{expected}: {result:?}");
            };
            assert_eq!(failure.name(), expected);
            // The send was recorded before, and the outcome after.
            let history = vault.history.borrow();
            assert_eq!(history.len(), 2);
            // A call that got a response keeps the provider's request id after the name.
            let detail = history[1].detail.as_deref().unwrap();
            assert!(
                detail == expected || detail == format!("{expected} req_FAKE1"),
                "{detail}"
            );
        }
    }

    #[test]
    fn a_cancel_before_the_send_sends_nothing_and_a_foreign_placeholder_is_flagged() {
        let vault = FakeVault::new();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, good_body())),
        };
        let prepared = prepared(&vault, "Patient [NAME 1] presents with fever.").unwrap();
        let cancelled = AtomicBool::new(true);
        assert!(matches!(
            send(&vault, &transport, &yes(), prepared, &cancelled, || 5,),
            Err(SendError::Failed(Failure::Cancelled, None))
        ));
        assert!(transport.calls.borrow().is_empty());
        assert!(vault.history.borrow().is_empty());
        // An answer that writes a mark of its own is left as written and flagged.
        let body = serde_json::json!({
            "stop_reason": "end_turn",
            "content": [{"type": "text", "text":
                r#"{"sentences":[{"text":"[NAME 9] came.","quote":"Patient [NAME 1] presents"}]}"#}]
        })
        .to_string();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, body)),
        };
        let sent = run(&vault, &transport, &yes()).unwrap();
        assert_eq!(sent.sentences[0].text, "[NAME 9] came.");
        assert_eq!(sent.flagged, ["[NAME 9]"]);
    }

    #[test]
    fn a_prepared_text_never_prints_itself() {
        let vault = FakeVault::new();
        let prepared = prepared(&vault, "Patient [NAME 1] presents with fever.").unwrap();
        let shown = format!("{prepared:?}");
        assert!(
            !shown.contains("fever") && !shown.contains("NAME"),
            "{shown}"
        );
    }

    #[test]
    fn a_list_from_the_page_that_fails_the_native_check_refuses_the_prepare() {
        let vault = FakeVault::new();
        let go = |removed: Vec<Removed>| {
            prepare(
                &vault,
                PrepareRequest {
                    record_id: Uuid::new_v4(),
                    key_id: Uuid::new_v4(),
                    model_id: "claude-opus-5-5",
                    language: UiLocale::En,
                    text: "Patient [NAME 1] presents.",
                    source: "",
                    labels: vec!["NAME".to_owned()],
                    removed,
                },
            )
        };
        let part = |replacement: &str| Removed {
            replacement: replacement.to_owned(),
            original: "FAKE Morgan Example".to_owned(),
            manual: false,
        };
        // An empty mark (which once looped forever), a free word, and a mark not in the text.
        for bad in ["", "the", "[NAME 7]"] {
            assert!(
                matches!(go(vec![part(bad)]), Err(PrepareError::BadRemoved(_))),
                "{bad:?}"
            );
        }
        assert!(go(vec![part("[NAME 1]")]).is_ok());
        // The document's own text is capped at the text cap, so no hostile source burns CPU.
        let over = "x".repeat(restore::MAX_SOURCE_BYTES + 1);
        assert!(matches!(
            prepare(
                &vault,
                PrepareRequest {
                    record_id: Uuid::new_v4(),
                    key_id: Uuid::new_v4(),
                    model_id: "claude-opus-5-5",
                    language: UiLocale::En,
                    text: "Patient [NAME 1] presents.",
                    source: &over,
                    labels: vec!["NAME".to_owned()],
                    removed: vec![part("[NAME 1]")],
                },
            ),
            Err(PrepareError::BadText)
        ));
        assert!(vault.history.borrow().is_empty());
    }

    #[test]
    fn a_failed_call_keeps_the_providers_request_id_in_its_history_entry() {
        let vault = FakeVault::new();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((529, "{}".to_owned())),
        };
        let result = run(&vault, &transport, &yes());
        assert_eq!(
            vault.history.borrow()[1].detail.as_deref(),
            Some("busy req_FAKE1")
        );
        // The screens get the same id to show.
        assert!(matches!(
            result,
            Err(SendError::Failed(Failure::Busy, Some(ref id))) if id == "req_FAKE1"
        ));
    }

    #[test]
    fn a_cancel_or_lock_while_the_dialog_was_open_records_and_sends_nothing() {
        struct CancelsWhileOpen<'a>(&'a AtomicBool);
        impl Confirmer for CancelsWhileOpen<'_> {
            fn confirm(&self, _: &Confirmation) -> bool {
                self.0.store(true, Ordering::Release);
                true
            }
        }
        let vault = FakeVault::new();
        let transport = FakeTransport {
            vault: &vault,
            calls: RefCell::new(vec![]),
            reply: Ok((200, good_body())),
        };
        let prepared = prepared(&vault, "Patient [NAME 1] presents with fever.").unwrap();
        let cancel = AtomicBool::new(false);
        let result = send(
            &vault,
            &transport,
            &CancelsWhileOpen(&cancel),
            prepared,
            &cancel,
            || 5,
        );
        assert!(matches!(
            result,
            Err(SendError::Failed(Failure::Cancelled, None))
        ));
        assert!(transport.calls.borrow().is_empty());
        assert!(vault.history.borrow().is_empty());
    }
}
