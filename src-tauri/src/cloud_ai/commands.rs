//! The Tauri commands for the patient's own cloud AI key and the per-document send (#72, THREAT_MODEL
//! AI-11 and NET-05). Compiled only with the `cloud-ai` Cargo feature, which no build may have on
//! until the live contract check (see `mod.rs`). Thin on purpose: every decision is in `send`,
//! `keytest`, `exchanges` and the vault, each tested with fakes; the commands only carry the page's
//! requests in, check the unlocked session, and put the native dialog and the real transport in.
//!
//! What the page never gets: the key (only its masked entry), a provider address, a model outside
//! the allow-list, or any say in what the confirmation dialog shows (it is worked out here from
//! the vault and the re-checked text).

use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroize;

use super::client::HttpsTransport;
use super::exchanges::{Exchanges, TakeError};
use super::keytest::{test_key, KeyTest};
use super::request::DEFAULT_MODEL;
use super::response::Failure;
use super::restore::Removed;
use super::send::{
    prepare, send, Confirmation, Confirmer, PrepareError, PrepareRequest, Prepared, SendError,
};
use crate::idle::AnswerOrigin;
use crate::ui_text::UiLocale;
use crate::ui_text_ids::MessageId;
use crate::vault::{CloudKeyError, CloudKeyInfo, VaultError, VaultStore};
use crate::{confirmed_natively, now_ms, text_recheck, CommandResult, PublicError};

/// This device's consent for this unlocked session, and the one prepared send. Memory only: a
/// lock or a restart starts again with cloud AI off, so the patient turns it on each time.
#[derive(Default)]
pub(crate) struct CloudSession {
    consent: Mutex<Option<AnswerOrigin>>,
    exchanges: Exchanges<Prepared, AnswerOrigin>,
}

impl CloudSession {
    fn enabled(&self, origin: AnswerOrigin) -> bool {
        *self.consent.lock().unwrap_or_else(|e| e.into_inner()) == Some(origin)
    }
    fn set_enabled(&self, origin: AnswerOrigin, on: bool) {
        *self.consent.lock().unwrap_or_else(|e| e.into_inner()) = on.then_some(origin);
    }
}

/// A refusal the page shows in words (every one uses the one generic message; the `code` says
/// which).
fn refuse(code: &'static str) -> PublicError {
    PublicError {
        code,
        message_key: "cloudAi.sendFailed",
        record_id: None,
        note_key: None,
        retry_after_ms: None,
    }
}

fn key_error(error: CloudKeyError) -> PublicError {
    match error {
        CloudKeyError::Vault(error) => error.into(),
        other => refuse(other.kind()),
    }
}

fn origin_of(store: &VaultStore) -> Result<AnswerOrigin, PublicError> {
    store.answer_origin().ok_or_else(|| refuse("locked"))
}

async fn blocking<T, F>(store: &Arc<VaultStore>, work: F) -> Result<T, PublicError>
where
    T: Send + 'static,
    F: FnOnce(&VaultStore) -> Result<T, PublicError> + Send + 'static,
{
    store.idle().touch(Instant::now());
    let store = Arc::clone(store);
    tauri::async_runtime::spawn_blocking(move || work(&store))
        .await
        .map_err(|_| PublicError::from(VaultError::Storage))?
}

#[tauri::command]
pub(crate) async fn cloud_ai_enabled(
    store: State<'_, Arc<VaultStore>>,
    session: State<'_, Arc<CloudSession>>,
) -> CommandResult<bool> {
    Ok(store
        .answer_origin()
        .is_some_and(|origin| session.enabled(origin)))
}

/// Turns cloud AI on for this unlocked session (the patient has read the notice and ticked "I
/// understand": the page's step) or off.
#[tauri::command]
pub(crate) async fn cloud_ai_set_enabled(
    store: State<'_, Arc<VaultStore>>,
    session: State<'_, Arc<CloudSession>>,
    on: bool,
) -> CommandResult<()> {
    // The consent comes first and a key after it (the screen adds one only while it is on); a send
    // still needs a key, and removing the last key turns this off again.
    let origin = origin_of(&store)?;
    session.set_enabled(origin, on);
    Ok(())
}

#[tauri::command]
pub(crate) async fn cloud_key_list(
    store: State<'_, Arc<VaultStore>>,
) -> CommandResult<Vec<CloudKeyInfo>> {
    blocking(store.inner(), |store| {
        store.cloud_keys().map_err(PublicError::from)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloudKeyAddRequest {
    provider: String,
    label: String,
    key: String,
}

#[tauri::command]
pub(crate) async fn cloud_key_add(
    store: State<'_, Arc<VaultStore>>,
    request: CloudKeyAddRequest,
) -> CommandResult<CloudKeyInfo> {
    let CloudKeyAddRequest {
        provider,
        label,
        mut key,
    } = request;
    blocking(store.inner(), move |store| {
        let result = store.cloud_key_add(&provider, &label, &key, now_ms());
        key.zeroize();
        result.map_err(key_error)
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_key_remove(
    store: State<'_, Arc<VaultStore>>,
    session: State<'_, Arc<CloudSession>>,
    id: Uuid,
) -> CommandResult<()> {
    let origin = origin_of(&store)?;
    let left = blocking(store.inner(), move |store| {
        store.cloud_key_remove(id, now_ms())?;
        Ok(store.cloud_keys()?.len())
    })
    .await?;
    // Removing the last key turns cloud AI off.
    if left == 0 {
        session.set_enabled(origin, false);
    }
    Ok(())
}

/// The key test: one `GET /v1/models` with this key, only when the patient asks. No document.
#[tauri::command]
pub(crate) async fn cloud_key_test(
    store: State<'_, Arc<VaultStore>>,
    session: State<'_, Arc<CloudSession>>,
    id: Uuid,
) -> CommandResult<KeyTest> {
    let origin = origin_of(&store)?;
    if !session.enabled(origin) {
        return Err(refuse("off"));
    }
    let session = Arc::clone(session.inner());
    blocking(store.inner(), move |store| {
        let (running, cancel) = session.exchanges.start_running();
        let outcome = test_key(store, &HttpsTransport, id, &cancel);
        session.exchanges.finish(running);
        outcome.map_err(PublicError::from)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemovedPart {
    replacement: String,
    original: String,
    #[serde(default)]
    manual: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrepareSendRequest {
    key_id: Uuid,
    record_id: Uuid,
    /// The app's language, mapped natively to the name the answer is asked for in.
    language: UiLocale,
    /// A model id from the allow-list; the default when absent.
    model: Option<String>,
    text: String,
    /// The document's own text, for the paste-back's ambiguous-marker rule (capped natively).
    source: String,
    labels: Vec<String>,
    removed: Vec<RemovedPart>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSendPrepared {
    exchange_id: Uuid,
    characters: usize,
    estimated_tokens: u64,
    estimated_cost_usd: Option<f64>,
    model_label: &'static str,
}

/// How a prepare ended: ready to send, or refused with the ranges that still hold something the
/// re-check will not let leave (nothing was prepared).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrepareOutcome {
    prepared: Option<CloudSendPrepared>,
    hits: Vec<text_recheck::Hit>,
}

#[tauri::command]
pub(crate) async fn cloud_send_prepare(
    store: State<'_, Arc<VaultStore>>,
    session: State<'_, Arc<CloudSession>>,
    request: PrepareSendRequest,
) -> CommandResult<PrepareOutcome> {
    let origin = origin_of(&store)?;
    if !session.enabled(origin) {
        return Err(refuse("off"));
    }
    let session = Arc::clone(session.inner());
    blocking(store.inner(), move |store| {
        let removed = request
            .removed
            .iter()
            .map(|part| Removed {
                replacement: part.replacement.clone(),
                original: part.original.clone(),
                manual: part.manual,
            })
            .collect();
        let prepared = prepare(
            store,
            PrepareRequest {
                record_id: request.record_id,
                key_id: request.key_id,
                model_id: request.model.as_deref().unwrap_or(DEFAULT_MODEL),
                language: request.language,
                text: &request.text,
                source: &request.source,
                labels: request.labels.clone(),
                removed,
            },
        );
        match prepared {
            Ok(prepared) => {
                let estimate = prepared.estimate();
                let shown = CloudSendPrepared {
                    exchange_id: Uuid::nil(),
                    characters: estimate.characters,
                    estimated_tokens: estimate.tokens,
                    estimated_cost_usd: Some(estimate.cost_usd),
                    model_label: prepared.model_label(),
                };
                let exchange_id = session.exchanges.put(origin, prepared, Instant::now());
                Ok(PrepareOutcome {
                    prepared: Some(CloudSendPrepared {
                        exchange_id,
                        ..shown
                    }),
                    hits: Vec::new(),
                })
            }
            Err(PrepareError::Recheck(hits)) => Ok(PrepareOutcome {
                prepared: None,
                hits,
            }),
            Err(PrepareError::UnknownModel) => Err(refuse("unknownModel")),
            Err(PrepareError::BadText) => Err(refuse("badText")),
            Err(PrepareError::BadRemoved(_)) => Err(refuse("badRemoved")),
            Err(PrepareError::Vault(error)) => Err(error.into()),
        }
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnswerSentence {
    text: String,
    quote: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudSendAnswer {
    sentences: Vec<AnswerSentence>,
    /// Placeholder-shaped text that was not put back, as written, for the screen to mark.
    flagged: Vec<String>,
    request_id: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

/// The native confirmation: provider, key, model, document, size and cost, worked out here. Only
/// the button that goes ahead counts.
struct NativeConfirmer {
    app: AppHandle,
    locale: UiLocale,
}

impl Confirmer for NativeConfirmer {
    fn confirm(&self, what: &Confirmation) -> bool {
        let words =
            || -> Result<(String, String, String, String, String), crate::ui_text::UiTextError> {
                let locale = self.locale;
                let cost = format!("US${:.2}", what.cost_usd.max(0.01));
                let body = locale.render(
                    MessageId::NativeCloudSendBody,
                    &[
                        ("provider", what.provider),
                        ("host", what.host),
                        ("model", what.model_label),
                        ("key", &what.key_label),
                        ("document", &what.document_title),
                        ("characters", &what.characters.to_string()),
                        ("tokens", &what.tokens.to_string()),
                        ("cost", &cost),
                    ],
                )?;
                Ok((
                    locale.render(
                        MessageId::NativeCloudSendTitle,
                        &[("provider", what.provider)],
                    )?,
                    body,
                    locale.text(MessageId::NativeCloudSendKeep)?,
                    locale.text(MessageId::NativeCloudSendGo)?,
                    locale.text(MessageId::NativeCancel)?,
                ))
            };
        match words() {
            Ok((title, body, keep, go, cancel)) => {
                confirmed_natively(&self.app, &title, body, &keep, &go, &cancel)
            }
            // A dialog that cannot be worded is no consent.
            Err(_) => false,
        }
    }
}

fn send_error(error: SendError) -> PublicError {
    match error {
        SendError::Declined => refuse("declined"),
        SendError::History(error) | SendError::Vault(error) => error.into(),
        SendError::Request(_) => refuse("badRequest"),
        SendError::Failed(failure, _request_id) => {
            let mut refusal = refuse(failure.name());
            if let Failure::RateLimited {
                retry_after_secs: Some(seconds),
            } = failure
            {
                refusal.retry_after_ms = Some(seconds.saturating_mul(1000));
            }
            refusal
        }
    }
}

/// Sends the prepared text: native confirmation, the history entry before the send, the request,
/// the checks and the restore. A new prepare, a cancel, a lock or an expiry ends the prepared text
/// before this.
#[tauri::command]
pub(crate) async fn cloud_send(
    app: AppHandle,
    store: State<'_, Arc<VaultStore>>,
    session: State<'_, Arc<CloudSession>>,
    exchange_id: Uuid,
    locale: Option<UiLocale>,
) -> CommandResult<CloudSendAnswer> {
    let origin = origin_of(&store)?;
    if !session.enabled(origin) {
        return Err(refuse("off"));
    }
    let session = Arc::clone(session.inner());
    let locale = locale.unwrap_or_default();
    blocking(store.inner(), move |store| {
        let (prepared, cancel) = session
            .exchanges
            .take(exchange_id, origin, Instant::now())
            .map_err(|error| match error {
                TakeError::Expired => refuse("expired"),
                TakeError::Unknown => refuse("unknown"),
            })?;
        let outcome = send(
            store,
            &HttpsTransport,
            &NativeConfirmer { app, locale },
            prepared,
            &cancel,
            now_ms,
        );
        session.exchanges.finish(exchange_id);
        let sent = outcome.map_err(send_error)?;
        Ok(CloudSendAnswer {
            sentences: sent
                .sentences
                .iter()
                .map(|sentence| AnswerSentence {
                    text: sentence.text.clone(),
                    quote: sentence.quote.clone(),
                })
                .collect(),
            flagged: sent.flagged.clone(),
            request_id: sent.request_id.clone(),
            input_tokens: sent.input_tokens,
            output_tokens: sent.output_tokens,
        })
    })
    .await
}

/// Drops a prepared send, or asks a running one to stop.
#[tauri::command]
pub(crate) async fn cloud_send_cancel(
    session: State<'_, Arc<CloudSession>>,
    exchange_id: Uuid,
) -> CommandResult<()> {
    session.exchanges.cancel(exchange_id);
    Ok(())
}
