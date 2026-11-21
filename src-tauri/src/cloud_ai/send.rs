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
use super::response::{interpret, Failure, ProviderResponse};
use super::restore::{restore, Removed};
use crate::history::{HistoryEntry, HistoryEvent};
use crate::text_recheck::{self, Hit};
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
    Vault(VaultError),
}

/// One text ready to send, after its re-check. Consumed by `send`, so one prepared text is one
/// send; dropped, it is zeroed. It never prints its text.
pub(crate) struct Prepared {
    record_id: Uuid,
    key_id: Uuid,
    model_id: &'static str,
    model_label: &'static str,
    language: String,
    text: Zeroizing<String>,
    removed: Vec<Removed>,
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
}

/// Re-checks `text` and keeps it for one send. The checks are a save's: a hit refuses.
pub(crate) fn prepare(
    vault: &impl SendVault,
    record_id: Uuid,
    key_id: Uuid,
    model_id: &str,
    language: &str,
    text: &str,
    removed: Vec<Removed>,
) -> Result<Prepared, PrepareError> {
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
    // The key must exist (and be readable) now, so that a send does not fail late.
    vault.key_label(key_id).map_err(PrepareError::Vault)?;
    Ok(Prepared {
        record_id,
        key_id,
        model_id: model.id,
        model_label: model.label,
        language: language.to_owned(),
        text: Zeroizing::new(text.to_owned()),
        removed,
        estimate: request::estimate(text, model),
    })
}

/// A sentence of the answer, with the real details put back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RestoredSentence {
    pub text: String,
    pub quote: String,
}

#[derive(Debug)]
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
    Failed(Failure),
}

fn event(kind: HistoryEvent, record: Uuid, at_ms: u64) -> HistoryEntry {
    let mut entry = HistoryEntry::new(kind, at_ms);
    entry.record_id = Some(record);
    entry.how = Some("anthropic".to_owned());
    entry
}

/// Confirms, records, sends, validates, restores and records the answer. `now_ms` is the clock
/// (a fake in tests). `labels` are the placeholder words of the export (for the restore).
pub(crate) fn send(
    vault: &impl SendVault,
    transport: &impl Transport,
    confirmer: &impl Confirmer,
    prepared: Prepared,
    cancel: &AtomicBool,
    now_ms: impl Fn() -> u64,
    labels: &[&str],
) -> Result<Sent, SendError> {
    if cancel.load(Ordering::Acquire) {
        return Err(SendError::Failed(Failure::Cancelled));
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
    let secret = vault
        .key_secret(prepared.key_id)
        .map_err(SendError::Vault)?;
    let provider_request = build_summary_request(
        &secret,
        prepared.model_id,
        &prepared.language,
        &prepared.text,
    )
    .map_err(SendError::Request)?;
    drop(secret);
    // The record that text may leave the device comes BEFORE the send: if it cannot be written,
    // nothing is sent; if the app dies after this, the vault says the text may have gone.
    let mut sent = event(HistoryEvent::AiCloudSent, prepared.record_id, now_ms());
    sent.detail = Some(prepared.model_id.to_owned());
    vault.record(sent).map_err(SendError::History)?;

    let outcome = match transport.send(&provider_request, cancel) {
        Ok(response) => interpret(&response).map(|answer| (answer, response.request_id.clone())),
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
        Err(failure) => answered.detail = Some(failure.name().to_owned()),
    }
    // The answer is not lost for want of a second entry.
    let _ = vault.record(answered);

    let (answer, _) = outcome.map_err(SendError::Failed)?;
    let mut flagged = Vec::new();
    let mut put_back = |text: &str| {
        let restored = restore(text, &prepared.removed, labels);
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
        }]
    }

    fn prepared(vault: &FakeVault, text: &str) -> Result<Prepared, PrepareError> {
        prepare(
            vault,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "claude-opus-5-5",
            "English",
            text,
            removed(),
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
            &["NAME", "DATE"],
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
                Uuid::new_v4(),
                Uuid::new_v4(),
                "gpt-4",
                "English",
                "x",
                vec![]
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
            let Err(SendError::Failed(failure)) = result else {
                panic!("{expected}: {result:?}");
            };
            assert_eq!(failure.name(), expected);
            // The send was recorded before, and the outcome after.
            let history = vault.history.borrow();
            assert_eq!(history.len(), 2);
            assert_eq!(history[1].detail.as_deref(), Some(expected));
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
            send(
                &vault,
                &transport,
                &yes(),
                prepared,
                &cancelled,
                || 5,
                &["NAME"]
            ),
            Err(SendError::Failed(Failure::Cancelled))
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
}
