//! What the AI helper wrote about a document (#72 part D, threat model
//! AI-06): a plain-words summary, or the explanation of a term. Each answer
//! is an encrypted object of its own beside the document's, under a random
//! key wrapped with the vault's object-wrap key, so it is backed up,
//! restored, hidden and kept with the document and never written anywhere
//! else. Manifest format 10 names them; an older build refuses the vault
//! rather than drop them as orphans.
//!
//! The vault keeps one answer per tool, language and term: a new summary in
//! the same language replaces the old one, whose object is removed once the
//! manifest commit names only the new one. Nothing about the document's
//! contents is written to the history: the entry names the document and the
//! tool only.

use super::*;

/// The most answers a document keeps, counting every tool and language.
pub(super) const MAX_AI_RESULTS_PER_RECORD: usize = 32;
/// The most an answer's bytes may be: a few sentences and their quotes.
pub(super) const MAX_AI_RESULT_BYTES: u64 = 64 * 1024;
const MAX_LANG_LEN: usize = 16;
const MAX_TERM_CHARS: usize = 200;
const MAX_MODEL_NAME_CHARS: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiTool {
    Summary,
    Explain,
}

impl AiTool {
    fn history_how(self) -> &'static str {
        match self {
            AiTool::Summary => "summary",
            AiTool::Explain => "explain",
        }
    }
}

/// One answer as the manifest names it. Its bytes are the renderer's own
/// JSON, which the vault stores and returns as they are.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredAiResult {
    pub(super) id: Uuid,
    pub(super) tool: AiTool,
    /// The language the answer is written in, as the app names it ("pt-BR").
    pub(super) lang: String,
    /// The term explained; none for a summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) term: Option<String>,
    pub(super) model_name: String,
    pub(super) model_sha256: String,
    pub(super) created_at_ms: u64,
    pub(super) object_name: String,
    pub(super) plaintext_size: u64,
    pub(super) wrapped_object_key: WrappedSecret,
}

impl StoredAiResult {
    pub(super) fn object(&self) -> RecordObject<'_> {
        RecordObject {
            id: self.id,
            object_name: &self.object_name,
            plaintext_size: self.plaintext_size,
            wrapped_key: &self.wrapped_object_key,
            sha256: None,
        }
    }

    /// Whether two answers stand for the same question: the same tool, in
    /// the same language, about the same term.
    fn same_question(&self, other: &Self) -> bool {
        self.tool == other.tool && self.lang == other.lang && self.term == other.term
    }
}

/// What the renderer asks the vault to keep.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiResultInput {
    pub tool: AiTool,
    pub lang: String,
    #[serde(default)]
    pub term: Option<String>,
    pub model_name: String,
    pub model_sha256: String,
}

/// An answer as the renderer lists it: everything but the bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiResultInfo {
    pub id: Uuid,
    pub tool: AiTool,
    pub lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub term: Option<String>,
    pub model_name: String,
    pub model_sha256: String,
    pub created_at_ms: u64,
    pub size: u64,
}

impl From<&StoredAiResult> for AiResultInfo {
    fn from(stored: &StoredAiResult) -> Self {
        Self {
            id: stored.id,
            tool: stored.tool,
            lang: stored.lang.clone(),
            term: stored.term.clone(),
            model_name: stored.model_name.clone(),
            model_sha256: stored.model_sha256.clone(),
            created_at_ms: stored.created_at_ms,
            size: stored.plaintext_size,
        }
    }
}

fn valid_lang(lang: &str) -> bool {
    !lang.is_empty()
        && lang.len() <= MAX_LANG_LEN
        && lang.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn valid_sha256(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A short text the renderer gave: trimmed as given, no control characters,
/// within its length in characters.
fn valid_text(text: &str, max_chars: usize) -> bool {
    !text.is_empty()
        && text == text.trim()
        && text.chars().count() <= max_chars
        && !text.chars().any(char::is_control)
}

fn valid_fields(
    tool: AiTool,
    lang: &str,
    term: Option<&str>,
    model_name: &str,
    model_sha256: &str,
) -> bool {
    valid_lang(lang)
        && valid_text(model_name, MAX_MODEL_NAME_CHARS)
        && valid_sha256(model_sha256)
        && match (tool, term) {
            (AiTool::Summary, None) => true,
            (AiTool::Explain, Some(term)) => valid_text(term, MAX_TERM_CHARS),
            _ => false,
        }
}

// What page code asks the vault to keep is checked natively before it is
// kept (#212, Agent 6's S1): it must have the shape of the reader's answers,
// within the model helper's own caps, and name the model that answered here.
// Until the runtime keeps its own last answer for the vault (a follow-up),
// this is the most native code can tell.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeptModel {
    name: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeptSpan {
    page: u32,
    start: u32,
    end: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeptSentence {
    text: String,
    quote: String,
    source: Option<KeptSpan>,
}

/// A summary as the reader keeps it (`SummaryResult` in src/ai/types.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeptSummary {
    tool: AiTool,
    sentences: Vec<KeptSentence>,
    model: KeptModel,
    lang: String,
    #[allow(dead_code)]
    created_at: u64,
    #[allow(dead_code)]
    partial: bool,
    last_page: u32,
    #[allow(dead_code)]
    pages_missing: bool,
}

/// An explanation as the reader keeps it (`ExplainResult`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeptExplanation {
    tool: AiTool,
    term: String,
    context: String,
    text: String,
    model: KeptModel,
    lang: String,
    #[allow(dead_code)]
    created_at: u64,
}

fn within(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars
}

/// Refuses an answer to keep unless its bytes are a summary or an
/// explanation as the reader writes them, within the helper's caps (six
/// sentences, 300 characters of text and 240 of quote each; an explanation of
/// at most 2,000 characters), for the same tool, language and term as `input`,
/// and from the model that last answered on this computer (`answered`: its
/// name and hash). Page code chooses the bytes, so none of this is trusted.
pub fn check_answer(
    input: &AiResultInput,
    content: &[u8],
    answered: Option<(&str, &str)>,
) -> Result<(), VaultError> {
    use crate::local_runner::MAX_SENTENCE_CHARS;
    use crate::model_helper::{MAX_QUOTE_CHARS, MAX_SENTENCES, MAX_TEXT_CHARS};
    use crate::model_runtime::{MAX_CONTEXT_CHARS, MAX_PAGES, MAX_PAGE_BYTES};
    let Some((name, sha256)) = answered else {
        return Err(VaultError::Invalid);
    };
    if input.model_name != name || input.model_sha256 != sha256 {
        return Err(VaultError::Invalid);
    }
    let same_model = |model: &KeptModel| model.name == name && model.sha256 == sha256;
    let ok = match input.tool {
        AiTool::Summary => {
            let Ok(summary) = serde_json::from_slice::<KeptSummary>(content) else {
                return Err(VaultError::Invalid);
            };
            input.term.is_none()
                && summary.tool == AiTool::Summary
                && summary.lang == input.lang
                && same_model(&summary.model)
                && (1..=MAX_SENTENCES).contains(&summary.sentences.len())
                && summary.last_page as usize <= MAX_PAGES
                && summary.sentences.iter().all(|sentence| {
                    !sentence.text.trim().is_empty()
                        && within(&sentence.text, MAX_TEXT_CHARS)
                        && within(&sentence.quote, MAX_QUOTE_CHARS)
                        && sentence.source.as_ref().is_none_or(|span| {
                            (span.page as usize) < MAX_PAGES
                                && span.start <= span.end
                                && span.end as usize <= MAX_PAGE_BYTES
                        })
                })
        }
        AiTool::Explain => {
            let Ok(explained) = serde_json::from_slice::<KeptExplanation>(content) else {
                return Err(VaultError::Invalid);
            };
            explained.tool == AiTool::Explain
                && input.term.as_deref() == Some(explained.term.as_str())
                && explained.lang == input.lang
                && same_model(&explained.model)
                && !explained.text.trim().is_empty()
                && within(&explained.text, MAX_SENTENCE_CHARS)
                && within(&explained.context, MAX_CONTEXT_CHARS)
        }
    };
    if ok {
        Ok(())
    } else {
        Err(VaultError::Invalid)
    }
}

/// The manifest's rules for one record's answers (`validate_manifest_structure`).
pub(super) fn validate<'a>(
    record: &'a StoredRecord,
    format_version: u32,
    object_ids: &mut HashSet<Uuid>,
    object_names: &mut HashSet<&'a str>,
) -> Result<(), VaultError> {
    if record.ai_results.is_empty() {
        return Ok(());
    }
    if format_version < MANIFEST_FORMAT_AI_RESULTS
        || record.ai_results.len() > MAX_AI_RESULTS_PER_RECORD
    {
        return Err(VaultError::Corrupt);
    }
    for (position, result) in record.ai_results.iter().enumerate() {
        if result.id.is_nil()
            || !object_ids.insert(result.id)
            || !valid_object_name(&result.object_name)
            || !object_names.insert(result.object_name.as_str())
            || !valid_wrapped_secret(&result.wrapped_object_key)
            || result.plaintext_size == 0
            || result.plaintext_size > MAX_AI_RESULT_BYTES
            || !valid_fields(
                result.tool,
                &result.lang,
                result.term.as_deref(),
                &result.model_name,
                &result.model_sha256,
            )
            || record.ai_results[..position]
                .iter()
                .any(|earlier| earlier.same_question(result))
        {
            return Err(VaultError::Corrupt);
        }
    }
    Ok(())
}

impl VaultStore {
    /// Keeps an answer with its document, replacing the one for the same
    /// question. The bytes are written and published before the manifest
    /// names them; the replaced answer's object goes once the commit holds.
    pub fn save_ai_result(
        &self,
        record_id: Uuid,
        input: AiResultInput,
        content: &[u8],
        now_ms: u64,
    ) -> Result<AiResultInfo, VaultError> {
        if content.is_empty()
            || content.len() as u64 > MAX_AI_RESULT_BYTES
            || !valid_fields(
                input.tool,
                &input.lang,
                input.term.as_deref(),
                &input.model_name,
                &input.model_sha256,
            )
        {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        if record.hidden.is_some() {
            return Err(VaultError::Invalid);
        }
        let vault_id = unlocked.manifest.vault_id;
        let keys = derive_keys(vault_id, &unlocked.master_key)?;

        let id = Uuid::new_v4();
        let object_name = format!("{}.mcobj", Uuid::new_v4());
        let mut object_key = Zeroizing::new([0_u8; 32]);
        OsRng.fill_bytes(object_key.as_mut());
        let objects = self.root.join("objects");
        let staged = objects.join(format!("{}.mcobj", Uuid::new_v4()));
        let written = encrypt_object(
            Box::new(io::Cursor::new(content.to_vec())),
            &staged,
            ObjectContext {
                vault_id,
                record_id: id,
                profile_id: record.profile_id,
            },
            &object_key,
            &keys.fingerprint,
        );
        let encrypted = match written {
            Ok(encrypted) => encrypted,
            Err(error) => {
                let _ = remove_owned_file(&staged, Removable::UncommittedObject);
                return Err(error);
            }
        };
        if let Err(error) = publish_object(&staged, &objects.join(&object_name)) {
            let _ = remove_owned_file(&staged, Removable::UncommittedObject);
            return Err(error.into());
        }
        terminate_at_test_boundary("ai-result.after-publication");
        let stored = StoredAiResult {
            id,
            tool: input.tool,
            lang: input.lang,
            term: input.term,
            model_name: input.model_name,
            model_sha256: input.model_sha256,
            created_at_ms: now_ms,
            object_name: object_name.clone(),
            plaintext_size: encrypted.plaintext_size,
            wrapped_object_key: wrap_secret(&keys.object_wrap, &object_key, id.as_bytes())?,
        };
        let info = AiResultInfo::from(&stored);

        let mut entry = record_entry(HistoryEvent::AiResultSaved, now_ms, record);
        entry.how = Some(stored.tool.history_how().to_owned());
        let mut next = unlocked.manifest.clone();
        let mut superseded = Vec::new();
        for next_record in &mut next.records {
            if next_record.id != record_id {
                continue;
            }
            next_record.ai_results.retain(|earlier| {
                let same = earlier.same_question(&stored);
                if same {
                    superseded.push(earlier.object_name.clone());
                }
                !same
            });
            if next_record.ai_results.len() >= MAX_AI_RESULTS_PER_RECORD {
                remove_objects(&self.root, &[object_name], Removable::UncommittedObject);
                return Err(VaultError::Invalid);
            }
            next_record.ai_results.push(stored.clone());
        }
        let committed = commit_with_history(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            vec![entry],
        );
        let redundant = match committed {
            Ok(redundant) => redundant,
            Err(error) => {
                remove_objects(&self.root, &[object_name], Removable::UncommittedObject);
                return Err(error);
            }
        };
        remove_objects(&self.root, &superseded, Removable::SupersededAiResult);
        unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
        Ok(info)
    }

    /// The answers kept with a document, newest first.
    pub fn ai_results(&self, record_id: Uuid) -> Result<Vec<AiResultInfo>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        let mut results: Vec<AiResultInfo> =
            record.ai_results.iter().map(AiResultInfo::from).collect();
        results.sort_by_key(|result| std::cmp::Reverse(result.created_at_ms));
        Ok(results)
    }

    /// One answer's bytes, checked as they are read.
    pub fn read_ai_result(&self, record_id: Uuid, result_id: Uuid) -> Result<Vec<u8>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let record = unlocked
            .manifest
            .records
            .iter()
            .find(|record| record.id == record_id)
            .ok_or(VaultError::NotFound)?;
        let stored = record
            .ai_results
            .iter()
            .find(|result| result.id == result_id)
            .ok_or(VaultError::NotFound)?;
        let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
        let mut content = Vec::with_capacity(stored.plaintext_size as usize);
        read_object_ref(
            &self.root.join("objects").join(&stored.object_name),
            unlocked.manifest.vault_id,
            &keys,
            stored.object(),
            &mut content,
        )?;
        Ok(content)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    fn fixture() -> (tempfile::TempDir, VaultStore, Uuid) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        let profile = store.snapshot().unwrap().profiles[0].id;
        let bytes = b"%PDF-1.7\r\nFAKE letter\r\n%%EOF".to_vec();
        let id = store
            .import(
                profile,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE letter.pdf".to_owned(),
                    reader: Box::new(Cursor::new(bytes)),
                }],
                2,
            )
            .unwrap()
            .imported[0];
        (temp, store, id)
    }

    fn summary(lang: &str) -> AiResultInput {
        AiResultInput {
            tool: AiTool::Summary,
            lang: lang.to_owned(),
            term: None,
            model_name: "FAKE model".to_owned(),
            model_sha256: "ab".repeat(32),
        }
    }

    fn explain(term: &str) -> AiResultInput {
        AiResultInput {
            tool: AiTool::Explain,
            lang: "en".to_owned(),
            term: Some(term.to_owned()),
            model_name: "FAKE model".to_owned(),
            model_sha256: "ab".repeat(32),
        }
    }

    // The model that answered, as the runtime names it, and an answer of
    // each kind as the reader writes them (FAKE).
    const ANSWERED: (&str, &str) = (
        "FAKE model",
        "abababababababababababababababababababababababababababababababab",
    );

    fn kept_summary() -> serde_json::Value {
        serde_json::json!({
            "tool": "summary",
            "sentences": [
                {"text": "FAKE: the potassium is a little high.", "quote": "Potassium 5.4", "source": {"page": 0, "start": 10, "end": 23}},
                {"text": "FAKE: a sentence with no source.", "quote": "", "source": null}
            ],
            "model": {"name": "FAKE model", "sha256": "ab".repeat(32)},
            "lang": "en",
            "createdAt": 1_760_000_000_000_u64,
            "partial": false,
            "lastPage": 2,
            "pagesMissing": false
        })
    }

    fn kept_explanation() -> serde_json::Value {
        serde_json::json!({
            "tool": "explain",
            "term": "potassium",
            "context": "Potassium 5.4 mmol/L.",
            "text": "FAKE: a salt in the blood.",
            "model": {"name": "FAKE model", "sha256": "ab".repeat(32)},
            "lang": "en",
            "createdAt": 1_760_000_000_000_u64
        })
    }

    fn checked(input: &AiResultInput, content: &serde_json::Value) -> Result<(), VaultError> {
        check_answer(input, content.to_string().as_bytes(), Some(ANSWERED))
    }

    #[test]
    fn an_answer_as_the_reader_writes_it_from_the_model_that_answered_is_kept() {
        assert!(checked(&summary("en"), &kept_summary()).is_ok());
        assert!(checked(&explain("potassium"), &kept_explanation()).is_ok());
    }

    #[test]
    fn an_answer_no_model_gave_here_or_another_model_gave_is_refused() {
        let content = kept_summary().to_string();
        // No model has answered on this computer.
        assert!(matches!(
            check_answer(&summary("en"), content.as_bytes(), None),
            Err(VaultError::Invalid)
        ));
        // Another model than the one that answered, by name or by hash.
        let other_hash = "cd".repeat(32);
        for answered in [
            ("FAKE other model", ANSWERED.1),
            (ANSWERED.0, other_hash.as_str()),
        ] {
            assert!(matches!(
                check_answer(&summary("en"), content.as_bytes(), Some(answered)),
                Err(VaultError::Invalid)
            ));
        }
        // The bytes name another model than the request.
        let mut forged = kept_summary();
        forged["model"]["name"] = "FAKE other model".into();
        assert!(matches!(
            checked(&summary("en"), &forged),
            Err(VaultError::Invalid)
        ));
    }

    #[test]
    fn an_answer_outside_the_helpers_shape_or_caps_is_refused() {
        let mut cases: Vec<(AiResultInput, serde_json::Value)> = Vec::new();
        let summary_with = |edit: &dyn Fn(&mut serde_json::Value)| {
            let mut value = kept_summary();
            edit(&mut value);
            (summary("en"), value)
        };
        let seven = serde_json::Value::Array(
            (0..7)
                .map(|_| serde_json::json!({"text": "FAKE.", "quote": "", "source": null}))
                .collect(),
        );
        cases.push(summary_with(&|v| v["sentences"] = seven.clone()));
        cases.push(summary_with(&|v| v["sentences"] = serde_json::json!([])));
        cases.push(summary_with(&|v| {
            v["sentences"][0]["text"] = "x".repeat(301).into()
        }));
        cases.push(summary_with(&|v| {
            v["sentences"][0]["quote"] = "x".repeat(241).into()
        }));
        cases.push(summary_with(&|v| v["sentences"][0]["text"] = " ".into()));
        cases.push(summary_with(&|v| {
            v["sentences"][0]["source"]["page"] = 50.into()
        }));
        cases.push(summary_with(&|v| {
            v["sentences"][0]["source"]["start"] = 30.into()
        }));
        cases.push(summary_with(&|v| v["lastPage"] = 51.into()));
        cases.push(summary_with(&|v| v["lang"] = "fr".into()));
        cases.push(summary_with(&|v| v["tool"] = "explain".into()));
        // Anything more than the reader writes.
        cases.push(summary_with(&|v| v["extra"] = "FAKE".into()));
        cases.push(summary_with(&|v| v["sentences"][0]["extra"] = 1.into()));
        let explain_with = |edit: &dyn Fn(&mut serde_json::Value)| {
            let mut value = kept_explanation();
            edit(&mut value);
            (explain("potassium"), value)
        };
        cases.push(explain_with(&|v| v["term"] = "sodium".into()));
        cases.push(explain_with(&|v| v["text"] = "x".repeat(2_001).into()));
        cases.push(explain_with(&|v| v["text"] = "".into()));
        cases.push(explain_with(&|v| v["context"] = "x".repeat(2_001).into()));
        for (input, content) in cases {
            assert!(
                matches!(checked(&input, &content), Err(VaultError::Invalid)),
                "kept: {content}"
            );
        }
        // Not JSON at all, or an answer of the other tool.
        assert!(matches!(
            check_answer(&summary("en"), b"FAKE: not JSON", Some(ANSWERED)),
            Err(VaultError::Invalid)
        ));
        assert!(matches!(
            checked(&summary("en"), &kept_explanation()),
            Err(VaultError::Invalid)
        ));
    }

    fn object_names(store: &VaultStore, record_id: Uuid) -> Vec<String> {
        let guard = store.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let record = manifest.records.iter().find(|r| r.id == record_id).unwrap();
        record
            .ai_results
            .iter()
            .map(|r| r.object_name.clone())
            .collect()
    }

    fn refused(result: Result<AiResultInfo, VaultError>, expected: &str) {
        match result {
            Err(error) => assert_eq!(format!("{error:?}"), expected),
            Ok(info) => panic!("saved {info:?}, expected {expected}"),
        }
    }

    #[test]
    fn an_answer_is_kept_encrypted_with_its_document_and_read_back_as_written() {
        let (_temp, store, id) = fixture();
        let content = br#"{"sentences":[{"text":"FAKE: all clear.","quote":"FAKE letter"}]}"#;
        let info = store
            .save_ai_result(id, summary("fr"), content, 10)
            .unwrap();
        assert_eq!(info.tool, AiTool::Summary);
        assert_eq!(info.lang, "fr");
        assert_eq!(info.created_at_ms, 10);
        assert_eq!(info.size, content.len() as u64);
        assert_eq!(store.ai_results(id).unwrap(), vec![info.clone()]);
        assert_eq!(store.read_ai_result(id, info.id).unwrap(), content);
        // Its own object, which does not hold the words in clear.
        let names = object_names(&store, id);
        assert_eq!(names.len(), 1);
        let on_disk = fs::read(store.root.join("objects").join(&names[0])).unwrap();
        assert!(!on_disk.windows(5).any(|w| w == b"clear"));
        // The history names the document and the tool, nothing of the text.
        let history = store.history_view().unwrap();
        let entry = history.entries.last().unwrap();
        assert_eq!(entry.event, HistoryEvent::AiResultSaved);
        assert_eq!(entry.record_id, Some(id));
        assert_eq!(entry.how.as_deref(), Some("summary"));
        assert_eq!(entry.name.as_deref(), Some("FAKE letter.pdf"));
        assert_eq!(entry.place, None);
    }

    #[test]
    fn a_new_answer_to_the_same_question_replaces_the_old_one_and_its_object() {
        let (_temp, store, id) = fixture();
        let first = store
            .save_ai_result(id, summary("fr"), b"{\"v\":1}", 10)
            .unwrap();
        let old_name = object_names(&store, id)[0].clone();
        let second = store
            .save_ai_result(id, summary("fr"), b"{\"v\":2}", 11)
            .unwrap();
        let other_lang = store
            .save_ai_result(id, summary("en"), b"{\"v\":3}", 12)
            .unwrap();
        let term = store
            .save_ai_result(id, explain("eGFR"), b"{\"v\":4}", 13)
            .unwrap();
        let kept = store.ai_results(id).unwrap();
        assert_eq!(
            kept.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![term.id, other_lang.id, second.id],
            "newest first, the replaced one gone"
        );
        assert!(matches!(
            store.read_ai_result(id, first.id),
            Err(VaultError::NotFound)
        ));
        assert!(
            !store.root.join("objects").join(&old_name).exists(),
            "the replaced answer's object is removed"
        );
        assert_eq!(store.read_ai_result(id, second.id).unwrap(), b"{\"v\":2}");
    }

    #[test]
    fn answers_are_refused_for_a_hidden_document_a_locked_vault_and_bad_input() {
        let (_temp, store, id) = fixture();
        let too_long = "x".repeat(MAX_AI_RESULT_BYTES as usize + 1);
        refused(
            store.save_ai_result(id, summary("fr"), too_long.as_bytes(), 1),
            "Invalid",
        );
        refused(store.save_ai_result(id, summary("fr"), b"", 1), "Invalid");
        refused(
            store.save_ai_result(id, summary("fr/../x"), b"{}", 1),
            "Invalid",
        );
        refused(
            store.save_ai_result(id, explain(" padded "), b"{}", 1),
            "Invalid",
        );
        let mut summary_with_term = summary("fr");
        summary_with_term.term = Some("eGFR".to_owned());
        refused(
            store.save_ai_result(id, summary_with_term, b"{}", 1),
            "Invalid",
        );
        let mut bad_hash = summary("fr");
        bad_hash.model_sha256 = "zz".repeat(32);
        refused(store.save_ai_result(id, bad_hash, b"{}", 1), "Invalid");
        refused(
            store.save_ai_result(Uuid::new_v4(), summary("fr"), b"{}", 1),
            "NotFound",
        );
        store.hide_record(id, 5).unwrap();
        refused(store.save_ai_result(id, summary("fr"), b"{}", 6), "Invalid");
        store.lock();
        refused(store.save_ai_result(id, summary("fr"), b"{}", 7), "Locked");
        assert!(matches!(store.ai_results(id), Err(VaultError::Locked)));
        store.unlock(PASSWORD).unwrap();
        assert!(
            object_names(&store, id).is_empty(),
            "nothing kept for refused answers"
        );
    }

    #[test]
    fn answers_survive_hide_unlock_backup_and_restore() {
        let (temp, store, id) = fixture();
        let info = store
            .save_ai_result(id, explain("TSH"), b"{\"t\":1}", 10)
            .unwrap();
        let name = object_names(&store, id)[0].clone();
        store.hide_record(id, 11).unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert!(
            store.root.join("objects").join(&name).is_file(),
            "unlock must not quarantine a referenced answer"
        );
        assert_eq!(store.read_ai_result(id, info.id).unwrap(), b"{\"t\":1}");
        let mut backup = Vec::new();
        store.backup(&mut backup, 12).unwrap();
        let restored = VaultStore::new(temp.path().join("restored"));
        restored
            .restore(
                Cursor::new(backup),
                RestoreCredential::Passphrase(PASSWORD),
                false,
            )
            .unwrap();
        restored.unlock(PASSWORD).unwrap();
        assert_eq!(restored.ai_results(id).unwrap(), vec![info.clone()]);
        assert_eq!(restored.read_ai_result(id, info.id).unwrap(), b"{\"t\":1}");
    }

    #[test]
    fn a_manifest_below_format_9_with_answers_or_a_repeated_question_is_corrupt() {
        let (_temp, store, id) = fixture();
        store.save_ai_result(id, summary("fr"), b"{}", 10).unwrap();
        let guard = store.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let vault_id = manifest.vault_id;
        assert!(validate_manifest_structure(manifest, vault_id).is_ok());
        let mut older = manifest.clone();
        older.format_version = MANIFEST_FORMAT_AI_RESULTS - 1;
        assert!(matches!(
            validate_manifest_structure(&older, vault_id),
            Err(VaultError::Corrupt)
        ));
        let mut repeated = manifest.clone();
        let twice = repeated.records[0].ai_results[0].clone();
        repeated.records[0].ai_results.push(StoredAiResult {
            id: Uuid::new_v4(),
            object_name: format!("{}.mcobj", Uuid::new_v4()),
            ..twice
        });
        assert!(matches!(
            validate_manifest_structure(&repeated, vault_id),
            Err(VaultError::Corrupt)
        ));
        let mut shared_object = manifest.clone();
        shared_object.records[0].ai_results[0].id = id;
        assert!(matches!(
            validate_manifest_structure(&shared_object, vault_id),
            Err(VaultError::Corrupt)
        ));
    }
}
