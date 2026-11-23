//! A model's limits, as the patient's AI helper settings show them (model limits, slice 1).
//!
//! The app process never parses a model file: it reads only the file's size, its first bytes
//! and its SHA-256, as before. The model helper already loads the whole file with llama.cpp, in
//! its sandbox; once it has, it says what it found in a bounded **card** on its hello line
//! (`model_helper::hello_line`): the architecture, the context the file says it was trained
//! for, the context the helper actually made, the parameters, layers and vocabulary, and
//! whether the model is recurrent or hybrid. The parent checks every field's range here
//! (`ModelCard::checked`) before it keeps the card, and trusts only the context the helper
//! **made**, never more than it asked for; the trained context is the maker's claim and is shown
//! as one at most.
//!
//! [`limits`] gives the settings, per catalogue model: the context and the room left for a
//! document (PR 302's `Capacity`, from the confirmed context once the helper has run the
//! model), the file's size, and the free memory a start needs by today's rule
//! (`model_runtime::needed_bytes`). Memory from the card's own numbers, a speed check and the
//! limits for added models come in later slices.

use serde::{Deserialize, Serialize};

use crate::local_model::{Accepted, Capacity};

/// The longest architecture name a card may carry.
pub(crate) const MAX_ARCHITECTURE_CHARS: usize = 32;
/// The trained context a card may claim: below it the model is for short texts only; above it,
/// no model on the market today.
pub(crate) const TRAINED_CONTEXT: std::ops::RangeInclusive<u32> = 4_096..=1_048_576;
/// Parameters, 0.1 to 40 billion.
pub(crate) const PARAMETERS: std::ops::RangeInclusive<u64> = 100_000_000..=40_000_000_000;
/// Layers, as llama.cpp counts them.
pub(crate) const LAYERS: std::ops::RangeInclusive<u32> = 1..=1_024;
/// Vocabulary size: the logits buffer grows with it.
pub(crate) const VOCABULARY: std::ops::RangeInclusive<u32> = 1..=524_288;

/// What the model helper says about the model it loaded, after llama.cpp has read the file.
/// Built in the helper from llama.cpp's own accessors (`engine::Engine::card`); checked in the
/// app (`checked`) before it is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModelCard {
    /// `general.architecture`, cut to [`MAX_ARCHITECTURE_CHARS`] of `[a-z0-9._-]`.
    pub(crate) architecture: String,
    /// `<arch>.context_length`: what the maker says the model was trained for. A claim.
    pub(crate) trained_context: u32,
    /// The context llama.cpp made for the helper (`llama_n_ctx`): what it can read at a time.
    pub(crate) context_made: u32,
    pub(crate) parameters: u64,
    pub(crate) layers: u32,
    pub(crate) vocabulary: u32,
    /// Recurrent, or a hybrid of recurrent and attention layers (its cache grows less with
    /// the context).
    pub(crate) recurrent: bool,
    pub(crate) hybrid: bool,
}

/// Why a card was not kept. The model still runs as before; its limits stay the catalogue's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CardRejected {
    Architecture,
    TrainedContext,
    /// The helper made no context, a larger one than it was asked for, or one larger than the
    /// model's own.
    ContextMade,
    Parameters,
    Layers,
    Vocabulary,
}

/// Keeps the characters an architecture name may have, at most [`MAX_ARCHITECTURE_CHARS`].
#[cfg_attr(mobile, allow(dead_code))] // The helper's: computers only.
pub(crate) fn clean_architecture(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
        .take(MAX_ARCHITECTURE_CHARS)
        .collect()
}

impl ModelCard {
    /// The card, when every field is in range and the helper made at most the context it was
    /// asked for (`requested`), and no more than the model's own.
    pub(crate) fn checked(self, requested: u32) -> Result<Self, CardRejected> {
        if self.architecture.is_empty()
            || clean_architecture(&self.architecture) != self.architecture
        {
            return Err(CardRejected::Architecture);
        }
        if !TRAINED_CONTEXT.contains(&self.trained_context) {
            return Err(CardRejected::TrainedContext);
        }
        if self.context_made == 0
            || self.context_made > requested
            || self.context_made > self.trained_context
        {
            return Err(CardRejected::ContextMade);
        }
        if !PARAMETERS.contains(&self.parameters) {
            return Err(CardRejected::Parameters);
        }
        if !LAYERS.contains(&self.layers) {
            return Err(CardRejected::Layers);
        }
        if !VOCABULARY.contains(&self.vocabulary) {
            return Err(CardRejected::Vocabulary);
        }
        Ok(self)
    }
}

// --- Persisted cards (#305 PR 2) --------------------------------------------------------------
//
// A checked card is kept on this computer, so that the settings and the reader's question know
// a model's confirmed context after a restart. It is device data (nothing about a patient), kept
// beside the models folder like the model choice, and never in the vault or a vault backup. It
// is read as untrusted: another program can write that folder.
//
// The one rule that makes a bad file harmless: a stored card can only ever make the limits
// MORE conservative than the catalogue's. A card's context is taken as `min(context_made,
// catalogue)` (`confirmed_capacity`), so the worst a forged file does is lower the room for a
// document, never raise it; its other fields are only shown. A missing, oversized, malformed or
// unknown-version file is no file: the catalogue's limits apply, as before the first run.

/// The file's name, beside the models folder.
pub(crate) const CARDS_FILE: &str = "model-limits-v1.json";
/// The largest file read: 32 entries are about 10 KiB.
pub(crate) const MAX_CARDS_FILE_BYTES: usize = 64 * 1024;
/// The most entries a file may hold (one per model and helper build).
pub(crate) const MAX_STORED_CARDS: usize = 32;
const MAX_HELPER_BUILD_CHARS: usize = 64;

/// What names the helper that made a card: the app's version and the helper's contract. A card
/// from another build is not used (it may have been made by other code): the model re-learns it.
pub(crate) fn helper_build() -> String {
    format!(
        "{}+{}",
        env!("CARGO_PKG_VERSION"),
        crate::model_helper::CONTRACT
    )
}

fn valid_sha256(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_build(text: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= MAX_HELPER_BUILD_CHARS
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-' | b'_' | b'/'))
}

/// One checked card, for one model file (its SHA-256) and one helper build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredCard {
    pub(crate) sha256: String,
    pub(crate) helper_build: String,
    pub(crate) card: ModelCard,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CardFile {
    v: u32,
    entries: Vec<StoredCard>,
}

/// The entries of a cards file that are all in range, or none: a file that is too large, not
/// JSON of exactly this shape, of another version or with more than [`MAX_STORED_CARDS`] entries is
/// refused whole; within a good file an entry with a bad hash, build or card is dropped on its own
/// (a card is run through `checked` again). A repeated model and build keeps the last.
pub(crate) fn parse_card_file(bytes: &[u8]) -> Vec<StoredCard> {
    if bytes.len() > MAX_CARDS_FILE_BYTES {
        return Vec::new();
    }
    let Ok(file) = serde_json::from_slice::<CardFile>(bytes) else {
        return Vec::new();
    };
    if file.v != 1 || file.entries.len() > MAX_STORED_CARDS {
        return Vec::new();
    }
    let mut kept: Vec<StoredCard> = Vec::new();
    for entry in file.entries {
        if !valid_sha256(&entry.sha256)
            || !valid_build(&entry.helper_build)
            || entry
                .card
                .clone()
                .checked(crate::model_helper::CONTEXT_TOKENS)
                .is_err()
        {
            continue;
        }
        kept.retain(|other| {
            !(other.sha256 == entry.sha256 && other.helper_build == entry.helper_build)
        });
        kept.push(entry);
    }
    kept
}

/// The file's bytes for `entries` (at most [`MAX_STORED_CARDS`], the newest last), or `None` if
/// they cannot be written within the limits.
pub(crate) fn card_file_bytes(entries: &[StoredCard]) -> Option<Vec<u8>> {
    let from = entries.len().saturating_sub(MAX_STORED_CARDS);
    let bytes = serde_json::to_vec(&CardFile {
        v: 1,
        entries: entries[from..].to_vec(),
    })
    .ok()?;
    (bytes.len() <= MAX_CARDS_FILE_BYTES).then_some(bytes)
}

/// One catalogue model's limits, for the AI helper settings (`ai_model_limits`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelLimits {
    /// The model's place in the catalog, as `ai_models` rows name it.
    pub(crate) index: usize,
    /// How much of a document it reads at a time: the context, and the room for the document.
    pub(crate) capacity: Capacity,
    /// Whether that context is the one the helper made for this model, in this session or in an
    /// earlier one of this build (the saved card); until then it is the catalogue's.
    pub(crate) confirmed: bool,
    /// What the file says it was trained for, once the helper has read it. A claim, never a
    /// promise: the helper reads at most `capacity.context_tokens`.
    pub(crate) trained_context: Option<u32>,
    /// Parameters, from the file, once the helper has read it.
    pub(crate) parameters: Option<u64>,
    /// The file's size.
    pub(crate) file_bytes: u64,
    /// The free memory a start needs, by today's rule (`model_runtime::needed_bytes`).
    pub(crate) needed_bytes: u64,
}

/// A model's capacity: `catalogue`'s until the helper has made its context (`card`, already
/// checked), then the room in that context, never more than the catalogue's. The settings
/// (`limits`) and the reader's question (`ai_model_status`) both take it from here, so they
/// never disagree.
pub(crate) fn confirmed_capacity(catalogue: Capacity, card: Option<&ModelCard>) -> Capacity {
    match card {
        Some(card) => Capacity::at(card.context_made.min(catalogue.context_tokens)),
        None => catalogue,
    }
}

/// The limits of catalogue model `index`: the catalogue's capacity until the helper has made
/// its context (`card`, already checked), then the room in that context.
pub(crate) fn limits(
    index: usize,
    model: &Accepted,
    card: Option<&ModelCard>,
    needed_bytes: u64,
) -> ModelLimits {
    let capacity = confirmed_capacity(model.capacity, card);
    ModelLimits {
        index,
        capacity,
        confirmed: card.is_some(),
        trained_context: card.map(|card| card.trained_context),
        parameters: card.map(|card| card.parameters),
        file_bytes: model.size_bytes,
        needed_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_model::CATALOG;

    /// The card a Qwen3.5 4B-like model gives (numbers from the file headers, FAKE otherwise).
    fn card() -> ModelCard {
        ModelCard {
            architecture: "qwen35".to_owned(),
            trained_context: 262_144,
            context_made: 8_192,
            parameters: 4_330_000_000,
            layers: 32,
            vocabulary: 248_320,
            recurrent: false,
            hybrid: true,
        }
    }

    #[test]
    fn a_card_in_range_is_kept_as_it_came() {
        assert_eq!(card().checked(8_192), Ok(card()));
        // The edges are in range.
        let edges = ModelCard {
            architecture: "a".repeat(MAX_ARCHITECTURE_CHARS),
            trained_context: 4_096,
            context_made: 4_096,
            parameters: 100_000_000,
            layers: 1,
            vocabulary: 1,
            ..card()
        };
        assert_eq!(edges.clone().checked(8_192), Ok(edges));
    }

    #[test]
    fn a_card_out_of_range_is_not_kept() {
        let with = |change: fn(&mut ModelCard)| {
            let mut card = card();
            change(&mut card);
            card.checked(8_192)
        };
        assert_eq!(
            with(|c| c.architecture.clear()),
            Err(CardRejected::Architecture)
        );
        assert_eq!(
            with(|c| c.architecture = "Qwen35".to_owned()),
            Err(CardRejected::Architecture)
        );
        assert_eq!(
            with(|c| c.architecture = "qwen\u{202E}35".to_owned()),
            Err(CardRejected::Architecture)
        );
        assert_eq!(
            with(|c| c.architecture = "a".repeat(MAX_ARCHITECTURE_CHARS + 1)),
            Err(CardRejected::Architecture)
        );
        assert_eq!(
            with(|c| c.trained_context = 4_095),
            Err(CardRejected::TrainedContext)
        );
        assert_eq!(
            with(|c| c.trained_context = 1_048_577),
            Err(CardRejected::TrainedContext)
        );
        assert_eq!(with(|c| c.context_made = 0), Err(CardRejected::ContextMade));
        // More than it was asked for, or than the model's own: never trusted.
        assert_eq!(
            with(|c| c.context_made = 8_193),
            Err(CardRejected::ContextMade)
        );
        assert_eq!(
            with(|c| {
                c.trained_context = 4_096;
                c.context_made = 6_000;
            }),
            Err(CardRejected::ContextMade)
        );
        assert_eq!(
            with(|c| c.parameters = 99_999_999),
            Err(CardRejected::Parameters)
        );
        assert_eq!(
            with(|c| c.parameters = 40_000_000_001),
            Err(CardRejected::Parameters)
        );
        assert_eq!(with(|c| c.layers = 0), Err(CardRejected::Layers));
        assert_eq!(with(|c| c.layers = 1_025), Err(CardRejected::Layers));
        assert_eq!(with(|c| c.vocabulary = 0), Err(CardRejected::Vocabulary));
        assert_eq!(
            with(|c| c.vocabulary = 524_289),
            Err(CardRejected::Vocabulary)
        );
    }

    #[test]
    fn an_architecture_keeps_only_its_plain_characters() {
        assert_eq!(clean_architecture("qwen35"), "qwen35");
        assert_eq!(clean_architecture("gemma4"), "gemma4");
        assert_eq!(clean_architecture("Qwen 3.5\u{202E}"), "wen3.5");
        assert_eq!(
            clean_architecture(&"x".repeat(100)).len(),
            MAX_ARCHITECTURE_CHARS
        );
    }

    #[test]
    fn the_card_reads_and_writes_as_the_hello_carries_it() {
        let json = serde_json::json!({
            "architecture": "qwen35",
            "trainedContext": 262_144,
            "contextMade": 8_192,
            "parameters": 4_330_000_000u64,
            "layers": 32,
            "vocabulary": 248_320,
            "recurrent": false,
            "hybrid": true
        });
        assert_eq!(serde_json::to_value(card()).unwrap(), json);
        assert_eq!(
            serde_json::from_value::<ModelCard>(json.clone()).unwrap(),
            card()
        );
        // A field the app does not know is refused, not ignored.
        let mut more = json;
        more["licence"] = serde_json::json!("FAKE");
        assert!(serde_json::from_value::<ModelCard>(more).is_err());
    }

    #[test]
    fn limits_are_the_catalogues_until_the_helper_confirms_its_context() {
        let model = &CATALOG[0];
        let unconfirmed = limits(0, model, None, 7_000_000_000);
        assert_eq!(
            unconfirmed,
            ModelLimits {
                index: 0,
                capacity: model.capacity,
                confirmed: false,
                trained_context: None,
                parameters: None,
                file_bytes: model.size_bytes,
                needed_bytes: 7_000_000_000,
            }
        );
        let confirmed = limits(0, model, Some(&card()), 7_000_000_000);
        assert!(confirmed.confirmed);
        assert_eq!(confirmed.capacity, Capacity::HELPER);
        assert_eq!(confirmed.trained_context, Some(262_144));
        assert_eq!(confirmed.parameters, Some(4_330_000_000));
        // A smaller context made: the room follows it, never the trained claim.
        let small = ModelCard {
            context_made: 4_096,
            ..card()
        };
        let limited = limits(0, model, Some(&small), 7_000_000_000);
        assert_eq!(limited.capacity, Capacity::at(4_096));
        assert!(limited.capacity.document_tokens < Capacity::HELPER.document_tokens);
        // Never more than the catalogue's own context, whatever the helper made.
        let large = ModelCard {
            context_made: 32_768,
            ..card()
        };
        assert_eq!(limits(0, model, Some(&large), 0).capacity, Capacity::HELPER);
    }

    #[test]
    fn the_settings_and_the_reader_take_the_same_capacity() {
        assert_eq!(confirmed_capacity(Capacity::HELPER, None), Capacity::HELPER);
        let small = ModelCard {
            context_made: 4_096,
            ..card()
        };
        assert_eq!(
            confirmed_capacity(Capacity::HELPER, Some(&small)),
            Capacity::at(4_096)
        );
        // 4,096 less the prompt's reserve (750), the summary (900) and the margin (32).
        assert_eq!(Capacity::at(4_096).document_tokens, 2_414);
        assert_eq!(
            limits(0, &CATALOG[0], Some(&small), 0).capacity,
            confirmed_capacity(CATALOG[0].capacity, Some(&small))
        );
    }

    #[test]
    fn limits_read_as_the_settings_take_them() {
        let model = &CATALOG[0];
        let value = serde_json::to_value(limits(0, model, Some(&card()), 1)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "index": 0,
                "capacity": { "contextTokens": 8192, "documentTokens": 6510 },
                "confirmed": true,
                "trainedContext": 262_144,
                "parameters": 4_330_000_000u64,
                "fileBytes": model.size_bytes,
                "neededBytes": 1
            })
        );
    }

    fn stored(sha: &str, build: &str) -> StoredCard {
        StoredCard {
            sha256: sha.to_owned(),
            helper_build: build.to_owned(),
            card: card(),
        }
    }

    const SHA_A: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SHA_B: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn a_saved_file_comes_back_as_it_was_written() {
        let entries = vec![
            stored(SHA_A, "1.2.3+mycarlos-model/1"),
            stored(SHA_B, "1.2.3+x"),
        ];
        let bytes = card_file_bytes(&entries).unwrap();
        assert_eq!(parse_card_file(&bytes), entries);
        assert!(bytes.len() < MAX_CARDS_FILE_BYTES);
        // The build this app names is one a file accepts.
        assert!(valid_build(&helper_build()), "{}", helper_build());
    }

    #[test]
    fn a_missing_oversized_or_malformed_file_is_no_file() {
        assert!(parse_card_file(b"").is_empty());
        assert!(parse_card_file(b"not json").is_empty());
        assert!(parse_card_file(&vec![b' '; MAX_CARDS_FILE_BYTES + 1]).is_empty());
        for bad in [
            r#"{"v":2,"entries":[]}"#,
            r#"{"entries":[]}"#,
            r#"{"v":1}"#,
            r#"{"v":1,"entries":[],"extra":1}"#,
            r#"{"v":1,"entries":[{"sha256":"a","helperBuild":"b","card":null}]}"#,
            "[]",
            "null",
        ] {
            assert!(parse_card_file(bad.as_bytes()).is_empty(), "{bad}");
        }
        // An unknown field inside an entry or its card refuses the whole file.
        let mut value: serde_json::Value =
            serde_json::from_slice(&card_file_bytes(&[stored(SHA_A, "b")]).unwrap()).unwrap();
        value["entries"][0]["card"]["mystery"] = serde_json::json!(1);
        assert!(parse_card_file(value.to_string().as_bytes()).is_empty());
    }

    #[test]
    fn too_many_entries_refuse_the_whole_file() {
        let many: Vec<StoredCard> = (0..=MAX_STORED_CARDS)
            .map(|n| stored(&format!("{n:064x}"), "b"))
            .collect();
        let bytes = serde_json::to_vec(&CardFile {
            v: 1,
            entries: many,
        })
        .unwrap();
        assert!(parse_card_file(&bytes).is_empty());
        // Writing more than the limit keeps the newest.
        let more: Vec<StoredCard> = (0..MAX_STORED_CARDS + 5)
            .map(|n| stored(&format!("{n:064x}"), "b"))
            .collect();
        let written = parse_card_file(&card_file_bytes(&more).unwrap());
        assert_eq!(written.len(), MAX_STORED_CARDS);
        assert_eq!(
            written.last().unwrap().sha256,
            format!("{:064x}", MAX_STORED_CARDS + 4)
        );
    }

    #[test]
    fn a_bad_entry_is_dropped_on_its_own_and_a_repeat_keeps_the_last() {
        let mut out_of_range = stored(SHA_B, "b");
        out_of_range.card.context_made = 9_000_000;
        let mut newer = stored(SHA_A, "b");
        newer.card.context_made = 4_096;
        let entries = vec![
            stored(SHA_A, "b"),
            stored("NOT-A-HASH", "b"),
            stored(SHA_A, "bad build!"),
            stored(SHA_A, ""),
            out_of_range,
            newer.clone(),
        ];
        let bytes = serde_json::to_vec(&CardFile { v: 1, entries }).unwrap();
        assert_eq!(parse_card_file(&bytes), vec![newer]);
    }

    #[test]
    fn a_stored_card_can_only_lower_the_room_never_raise_it() {
        let model = &CATALOG[0];
        let catalogue = model.capacity;
        // A forged card claiming a huge context is out of range: not kept at all.
        let mut forged = stored(SHA_A, "b");
        forged.card.context_made = 1_000_000;
        let bytes = serde_json::to_vec(&CardFile {
            v: 1,
            entries: vec![forged],
        })
        .unwrap();
        assert!(parse_card_file(&bytes).is_empty());
        // A card at the most the helper is asked for gives no more than the catalogue's room.
        let at_most = ModelCard {
            context_made: 8_192,
            ..card()
        };
        assert!(
            confirmed_capacity(catalogue, Some(&at_most)).context_tokens
                <= catalogue.context_tokens
        );
        // A smaller one lowers it.
        let small = ModelCard {
            context_made: 4_096,
            ..card()
        };
        assert!(
            confirmed_capacity(catalogue, Some(&small)).context_tokens < catalogue.context_tokens
        );
    }
}
