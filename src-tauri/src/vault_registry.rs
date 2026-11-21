//! The device's vault registry (#357, step 1 of the "vault slots" design): which vaults this device
//! holds, which one is the default, and a way to find the one a typed name stands for. Nothing here
//! opens, creates or moves a vault, and nothing in the app calls it yet: the swappable `VaultStore`
//! and the unlock screen come in later steps.
//!
//! - **Slots.** The vault the device has today is `Main` and stays at `<data>/vault-home`. Every
//!   other vault is a complete vault of its own at `<data>/vaults/<random uuid>/vault-home`, so a folder
//!   name says nothing about its owner. A vault's format is unchanged: no format number.
//! - **The registry** is `vaults.v1` beside `vault-home`: a device file, not part of any vault or any
//!   backup. For each slot it holds the slot id, whether it is the default, and a **name hash**: the
//!   typed name, normalised (see [`normalise_name`]) and hashed with Argon2id under one random per-device
//!   salt, so one hash is computed per attempt and compared in constant time against every entry. No
//!   readable name, label or timestamp is stored.
//! - **Honest limits** (the design's section 8): a name is a short, guessable identifier, not a second
//!   password; a copy of this file lets someone test guesses offline at the hash's cost. The file is
//!   padded up to a power of two so its size tells only a bucket, but that a second vault exists is
//!   visible anyway (the `vaults/` folders). No claim of hidden existence is made.
//! - **File.** Magic, a version, the payload's length, the payload (JSON), then random padding up to
//!   a power of two of at least 2 KiB. A file that is not exactly that, or whose payload is not
//!   consistent, is `Damaged` and treated as no registry by the caller (fail closed, never repaired
//!   by guessing). Written with an atomic replace, so a power loss leaves the old file or the new one.
#![cfg_attr(not(test), allow(dead_code))]

use argon2::{Algorithm, Argon2, Params, Version};
use atomicwrites::{AllowOverwrite, AtomicFile};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zeroize::Zeroizing;

/// The registry's file name, beside `vault-home`.
pub(crate) const FILE_NAME: &str = "vaults.v1";
/// The folder of the extra vaults, beside `vault-home`.
pub(crate) const SLOTS_FOLDER: &str = "vaults";
/// The folder each vault's own files live in, as `lib.rs` roots the main vault.
const VAULT_HOME: &str = "vault-home";
/// The vault itself, inside its `vault-home`.
const VAULT_DIR: &str = "vault-v1";

const MAGIC: &[u8; 8] = b"MCVAULTS";
const FILE_VERSION: u16 = 1;
const HEADER_BYTES: usize = MAGIC.len() + 2 + 4;
/// The smallest file; larger ones are the next power of two.
const MIN_FILE_BYTES: usize = 2048;
/// A bound on what is read, so a hostile file cannot ask for memory.
const MAX_FILE_BYTES: usize = 1 << 24;
/// The longest name, in characters, after normalising (the design: 1 to 64).
pub(crate) const MAX_NAME_CHARS: usize = 64;
/// A typed name longer than this is cut before it is hashed: it can match no stored name anyway.
const MAX_PROBE_CHARS: usize = 1024;
const SALT_BYTES: usize = 16;
const NAME_HASH_BYTES: usize = 32;

/// Which vault: the one the device has today, or an extra one by its random id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SlotId {
    Main,
    Extra(Uuid),
}

impl SlotId {
    fn text(self) -> String {
        match self {
            SlotId::Main => "main".to_owned(),
            SlotId::Extra(id) => id.hyphenated().to_string(),
        }
    }

    fn parse(text: &str) -> Option<Self> {
        if text == "main" {
            return Some(SlotId::Main);
        }
        let id = Uuid::parse_str(text).ok()?;
        // Only the canonical lower-case form, so one slot has one spelling.
        (id.hyphenated().to_string() == text).then_some(SlotId::Extra(id))
    }
}

/// What the registry cannot do.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RegistryError {
    /// The file is not a registry this version wrote, or is not consistent: no registry.
    Damaged,
    Io,
    /// A name that cannot be a name (empty, or longer than [`MAX_NAME_CHARS`]).
    Name(NameError),
    /// No such slot in the registry.
    UnknownSlot,
}

impl From<io::Error> for RegistryError {
    fn from(_: io::Error) -> Self {
        RegistryError::Io
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NameError {
    /// Nothing left after normalising.
    Empty,
    /// More than [`MAX_NAME_CHARS`] characters after normalising.
    TooLong,
}

/// How a typed name is made comparable, the same way at set-up and at unlock: Unicode NFKC, lower
/// case, zero-width and bidi control characters dropped, any run of white space (no-break and
/// ideographic spaces too) one space, trimmed. Accents are **kept** ("José" is not "Jose"): folding
/// them would merge unrelated names, so the set-up page tells the owner to type it the same way.
pub(crate) fn normalise_name(typed: &str) -> String {
    let joined: String = typed
        .nfkc()
        .filter(|c| !is_invisible(*c))
        .collect::<String>()
        .to_lowercase();
    // Lower-casing can leave a form NFKC would change (a final sigma, a ligature): once more.
    let folded: String = joined.nfkc().collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Characters that show nothing and could make two names look the same: zero-width spaces, joiners,
/// the word joiner and the byte order mark, and the bidirectional controls.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}' | '\u{00AD}' | '\u{061C}'
    )
}

/// A name checked for storing: normalised, 1 to [`MAX_NAME_CHARS`] characters.
fn checked_name(typed: &str) -> Result<Zeroizing<String>, NameError> {
    let name = Zeroizing::new(normalise_name(typed));
    match name.chars().count() {
        0 => Err(NameError::Empty),
        n if n > MAX_NAME_CHARS => Err(NameError::TooLong),
        _ => Ok(name),
    }
}

/// The Argon2id cost of one name hash. It is stored in the registry, so it can be raised later and
/// an old file still checks with the cost it was made with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HashCost {
    pub(crate) memory_kib: u32,
    pub(crate) passes: u32,
    pub(crate) lanes: u32,
}

impl HashCost {
    /// The device cost. The design asks for about 0.3 s on a phone: **tune on a phone before the
    /// unlock screen uses it**; the first value is the one `argon2` calls a sound interactive
    /// setting.
    pub(crate) const DEVICE: HashCost = HashCost {
        memory_kib: 32 * 1024,
        passes: 3,
        lanes: 1,
    };
    /// The smallest cost Argon2 accepts, for the tests.
    #[cfg(test)]
    pub(crate) const TEST: HashCost = HashCost {
        memory_kib: 8,
        passes: 1,
        lanes: 1,
    };

    /// A cost a file may carry: the bounds keep a hostile file from asking for gigabytes or minutes.
    fn acceptable(self) -> bool {
        (8..=1 << 20).contains(&self.memory_kib)
            && (1..=16).contains(&self.passes)
            && (1..=8).contains(&self.lanes)
            && self.memory_kib >= 8 * self.lanes
    }

    fn argon(self) -> Option<Argon2<'static>> {
        let params = Params::new(
            self.memory_kib,
            self.passes,
            self.lanes,
            Some(NAME_HASH_BYTES),
        )
        .ok()?;
        Some(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    slot: SlotId,
    default: bool,
    /// None: a vault with no name, reached only as the default.
    name_hash: Option<[u8; NAME_HASH_BYTES]>,
}

/// The vaults this device holds, in the order they were added (the first is the oldest).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Registry {
    cost: HashCost,
    salt: [u8; SALT_BYTES],
    entries: Vec<Entry>,
}

impl Registry {
    /// A registry with nothing in it and a new random salt.
    pub(crate) fn new(cost: HashCost) -> Registry {
        let mut salt = [0u8; SALT_BYTES];
        OsRng.fill_bytes(&mut salt);
        Registry {
            cost,
            salt,
            entries: Vec::new(),
        }
    }

    /// The registry of a device that has only the vault it has today: `Main`, the default, no name.
    pub(crate) fn with_main(cost: HashCost) -> Registry {
        let mut registry = Registry::new(cost);
        registry.entries.push(Entry {
            slot: SlotId::Main,
            default: true,
            name_hash: None,
        });
        registry
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The slots, oldest first.
    pub(crate) fn slots(&self) -> Vec<SlotId> {
        self.entries.iter().map(|entry| entry.slot).collect()
    }

    pub(crate) fn contains(&self, slot: SlotId) -> bool {
        self.entries.iter().any(|entry| entry.slot == slot)
    }

    /// The vault a locked screen starts on: the one marked, or none when the registry is empty.
    pub(crate) fn default_slot(&self) -> Option<SlotId> {
        self.entries
            .iter()
            .find(|entry| entry.default)
            .map(|entry| entry.slot)
    }

    /// One Argon2id hash of a normalised name under this device's salt and cost.
    fn hash_name(&self, normalised: &str) -> [u8; NAME_HASH_BYTES] {
        let mut out = [0u8; NAME_HASH_BYTES];
        let argon = self
            .cost
            .argon()
            .expect("a cost the registry holds was checked when it was made or read");
        argon
            .hash_password_into(normalised.as_bytes(), &self.salt, &mut out)
            .expect("the salt and output sizes are fixed");
        out
    }

    /// Adds a vault of its own, with the name it will be found by, and gives back its slot. The first
    /// vault in an empty registry is the default. A name may be shared with another vault (a check at
    /// the unlock screen would tell anyone there which names exist).
    pub(crate) fn add_extra(&mut self, name: &str) -> Result<SlotId, RegistryError> {
        let name = checked_name(name).map_err(RegistryError::Name)?;
        let slot = SlotId::Extra(Uuid::new_v4());
        let hash = self.hash_name(&name);
        self.entries.push(Entry {
            slot,
            default: self.entries.is_empty(),
            name_hash: Some(hash),
        });
        Ok(slot)
    }

    /// Gives a slot a name, or takes its name away (`None`): then it is reached only as the default.
    pub(crate) fn set_name(
        &mut self,
        slot: SlotId,
        name: Option<&str>,
    ) -> Result<(), RegistryError> {
        let hash = match name {
            Some(typed) => {
                let name = checked_name(typed).map_err(RegistryError::Name)?;
                Some(self.hash_name(&name))
            }
            None => None,
        };
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.slot == slot)
            .ok_or(RegistryError::UnknownSlot)?;
        entry.name_hash = hash;
        Ok(())
    }

    /// Makes a slot the default (the one a locked screen starts on).
    pub(crate) fn set_default(&mut self, slot: SlotId) -> Result<(), RegistryError> {
        if !self.contains(slot) {
            return Err(RegistryError::UnknownSlot);
        }
        for entry in &mut self.entries {
            entry.default = entry.slot == slot;
        }
        Ok(())
    }

    /// Takes a slot out of the registry (the vault itself is set aside by the caller). When it was
    /// the default, the oldest vault left becomes the default.
    pub(crate) fn remove(&mut self, slot: SlotId) -> Result<(), RegistryError> {
        let index = self
            .entries
            .iter()
            .position(|entry| entry.slot == slot)
            .ok_or(RegistryError::UnknownSlot)?;
        let was_default = self.entries.remove(index).default;
        if was_default {
            if let Some(oldest) = self.entries.first_mut() {
                oldest.default = true;
            }
        }
        Ok(())
    }

    /// The vaults a typed name stands for, oldest first. An empty name (nothing left after
    /// normalising) is the default vault alone. Anything else costs ONE name hash, whatever it is
    /// and whatever the registry holds, and is compared with every stored hash with no early exit, so
    /// a name the registry does not know takes as long as one it does and no entry is skipped. A name
    /// of no vault is an empty list, never an error: the caller shows its one message for it.
    pub(crate) fn slots_named(&self, typed: &str) -> Vec<SlotId> {
        let probe: String = normalise_name(typed)
            .chars()
            .take(MAX_PROBE_CHARS)
            .collect();
        let probe = Zeroizing::new(probe);
        if probe.is_empty() {
            return self.default_slot().into_iter().collect();
        }
        let hash = self.hash_name(&probe);
        let mut found = Vec::new();
        for entry in &self.entries {
            // A vault with no name is compared against a fixed value (and never matches), so no
            // entry skips its work.
            let stored = entry.name_hash.unwrap_or([0u8; NAME_HASH_BYTES]);
            let same = constant_time_eq(&stored, &hash);
            if same && entry.name_hash.is_some() {
                found.push(entry.slot);
            }
        }
        found
    }

    // ---- the file ---------------------------------------------------------------------------

    /// The registry as the bytes `vaults.v1` holds: header, payload, then random padding to a power
    /// of two of at least [`MIN_FILE_BYTES`].
    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let stored = Stored {
            cost: self.cost,
            salt: B64.encode(self.salt),
            entries: self
                .entries
                .iter()
                .map(|entry| StoredEntry {
                    slot: entry.slot.text(),
                    default: entry.default,
                    name: entry.name_hash.map(|hash| B64.encode(hash)),
                })
                .collect(),
        };
        let payload = serde_json::to_vec(&stored).expect("a registry always serialises");
        let total = bucket(HEADER_BYTES + payload.len());
        let mut bytes = Vec::with_capacity(total);
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&FILE_VERSION.to_be_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&payload);
        let padding_start = bytes.len();
        bytes.resize(total, 0);
        OsRng.fill_bytes(&mut bytes[padding_start..]);
        bytes
    }

    /// A registry from the bytes of a file; anything that is not exactly what [`Registry::to_bytes`]
    /// writes is `Damaged`.
    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Registry, RegistryError> {
        if bytes.len() < HEADER_BYTES
            || bytes.len() > MAX_FILE_BYTES
            || &bytes[..MAGIC.len()] != MAGIC
        {
            return Err(RegistryError::Damaged);
        }
        let version = u16::from_be_bytes([bytes[8], bytes[9]]);
        if version != FILE_VERSION {
            return Err(RegistryError::Damaged);
        }
        let length = u32::from_be_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]) as usize;
        let end = HEADER_BYTES
            .checked_add(length)
            .ok_or(RegistryError::Damaged)?;
        // The file is exactly the bucket of what it holds: no short, long or half-written file.
        if end > bytes.len() || bytes.len() != bucket(end) {
            return Err(RegistryError::Damaged);
        }
        let stored: Stored = serde_json::from_slice(&bytes[HEADER_BYTES..end])
            .map_err(|_| RegistryError::Damaged)?;
        if !stored.cost.acceptable() {
            return Err(RegistryError::Damaged);
        }
        let salt: [u8; SALT_BYTES] = decode_fixed(&stored.salt)?;
        let mut entries: Vec<Entry> = Vec::with_capacity(stored.entries.len());
        for stored_entry in &stored.entries {
            let slot = SlotId::parse(&stored_entry.slot).ok_or(RegistryError::Damaged)?;
            if entries.iter().any(|entry| entry.slot == slot) {
                return Err(RegistryError::Damaged);
            }
            let name_hash = match &stored_entry.name {
                Some(text) => Some(decode_fixed::<NAME_HASH_BYTES>(text)?),
                None => None,
            };
            entries.push(Entry {
                slot,
                default: stored_entry.default,
                name_hash,
            });
        }
        // A registry that holds vaults names exactly one of them the default.
        let defaults = entries.iter().filter(|entry| entry.default).count();
        if (entries.is_empty() && defaults != 0) || (!entries.is_empty() && defaults != 1) {
            return Err(RegistryError::Damaged);
        }
        Ok(Registry {
            cost: stored.cost,
            salt,
            entries,
        })
    }

    /// The registry of a device, or `None` when it has none yet (the file is absent).
    pub(crate) fn load(data_dir: &Path) -> Result<Option<Registry>, RegistryError> {
        let path = data_dir.join(FILE_NAME);
        match fs::read(&path) {
            Ok(bytes) => Registry::from_bytes(&bytes).map(Some),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(RegistryError::Io),
        }
    }

    /// Writes the registry, replacing the file atomically.
    pub(crate) fn save(&self, data_dir: &Path) -> Result<(), RegistryError> {
        fs::create_dir_all(data_dir)?;
        let bytes = self.to_bytes();
        AtomicFile::new(data_dir.join(FILE_NAME), AllowOverwrite)
            .write(|file| file.write_all(&bytes))
            .map_err(|_| RegistryError::Io)
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    cost: HashCost,
    salt: String,
    entries: Vec<StoredEntry>,
}

#[derive(Serialize, Deserialize)]
struct StoredEntry {
    slot: String,
    default: bool,
    name: Option<String>,
}

fn decode_fixed<const N: usize>(text: &str) -> Result<[u8; N], RegistryError> {
    let bytes = B64.decode(text).map_err(|_| RegistryError::Damaged)?;
    bytes.try_into().map_err(|_| RegistryError::Damaged)
}

/// The file size for `len` bytes of content: the next power of two, never under [`MIN_FILE_BYTES`].
fn bucket(len: usize) -> usize {
    len.max(MIN_FILE_BYTES).next_power_of_two()
}

/// Equal bytes, in time that does not depend on where they first differ.
fn constant_time_eq(a: &[u8; NAME_HASH_BYTES], b: &[u8; NAME_HASH_BYTES]) -> bool {
    let mut difference = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        difference |= x ^ y;
    }
    std::hint::black_box(difference) == 0
}

// ---- where each vault lives ---------------------------------------------------------------------

/// A slot's `vault-home`: the folder that holds the vault and what the vault manages beside it.
/// `Main` is where the device has always kept it, so nobody's data moves.
pub(crate) fn slot_home(data_dir: &Path, slot: SlotId) -> PathBuf {
    match slot {
        SlotId::Main => data_dir.join(VAULT_HOME),
        SlotId::Extra(id) => data_dir
            .join(SLOTS_FOLDER)
            .join(id.hyphenated().to_string())
            .join(VAULT_HOME),
    }
}

/// The root a `VaultStore` is made with for a slot (`<slot home>/vault-v1`).
pub(crate) fn slot_store_root(data_dir: &Path, slot: SlotId) -> PathBuf {
    slot_home(data_dir, slot).join(VAULT_DIR)
}

/// The slot folders on disk that the registry does not list: what a creation left half-made when the
/// device lost power (the folder exists, the registry entry was never written). Only folders under
/// `vaults/` named as a canonical slot id count; `Main` and anything else are never reported. This
/// only lists: whoever cleans up decides how.
pub(crate) fn unregistered_slot_folders(
    data_dir: &Path,
    registry: &Registry,
) -> io::Result<Vec<PathBuf>> {
    let folder = data_dir.join(SLOTS_FOLDER);
    let reader = match fs::read_dir(&folder) {
        Ok(reader) => reader,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut found = Vec::new();
    for item in reader {
        let item = item?;
        let Some(name) = item.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(slot @ SlotId::Extra(_)) = SlotId::parse(&name) else {
            continue;
        };
        if !registry.contains(slot) && item.file_type()?.is_dir() {
            found.push(item.path());
        }
    }
    found.sort();
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry() -> Registry {
        Registry::with_main(HashCost::TEST)
    }

    #[test]
    fn given_typed_names_that_differ_only_by_case_spacing_or_invisible_marks_when_normalised_then_they_are_one_name(
    ) {
        let one = normalise_name("Ana  Lopez");
        assert_eq!(one, "ana lopez");
        assert_eq!(normalise_name(" ANA LOPEZ "), one);
        assert_eq!(normalise_name("ana\u{00A0}lopez"), one);
        assert_eq!(normalise_name("ana\u{3000}\u{3000}lopez"), one);
        assert_eq!(normalise_name("a\u{200B}na lo\u{FEFF}pez"), one);
        assert_eq!(normalise_name("\u{202E}ana lopez\u{202C}"), one);
        // Compatibility forms: a full-width name and a ligature.
        assert_eq!(normalise_name("ＡＮＡ ＬＯＰＥＺ"), one);
        assert_eq!(normalise_name("ﬁnn"), "finn");
        // A combining accent and the precomposed letter are the same name.
        assert_eq!(normalise_name("Jose\u{301}"), normalise_name("Jos\u{E9}"));
    }

    #[test]
    fn given_accents_when_normalised_then_they_are_kept() {
        assert_ne!(normalise_name("José"), normalise_name("Jose"));
        assert_eq!(normalise_name("José"), "josé");
    }

    #[test]
    fn given_names_of_every_length_when_checked_then_only_one_to_sixty_four_characters_pass() {
        assert_eq!(checked_name("   ").err(), Some(NameError::Empty));
        assert_eq!(
            checked_name("\u{200B}\u{200B}").err(),
            Some(NameError::Empty)
        );
        assert!(checked_name("a").is_ok());
        assert!(checked_name(&"a".repeat(64)).is_ok());
        assert_eq!(
            checked_name(&"a".repeat(65)).err(),
            Some(NameError::TooLong)
        );
        // Counted after normalising: spaces collapse before the count.
        assert!(checked_name(&format!("{}{}", "a".repeat(32), " ".repeat(40))).is_ok());
    }

    #[test]
    fn given_a_name_when_the_vault_is_added_then_the_name_finds_it_however_it_is_typed() {
        let mut registry = registry();
        let ana = registry.add_extra("Ana Lopez").unwrap();
        let other = registry.add_extra("Ben Okafor").unwrap();
        assert_eq!(registry.slots_named("ana  LOPEZ"), vec![ana]);
        assert_eq!(registry.slots_named(" Ben\u{00A0}Okafor "), vec![other]);
        // Accents are kept, so a different spelling is another name.
        assert!(registry.slots_named("Ana López").is_empty());
        assert!(registry.slots_named("nobody").is_empty());
    }

    #[test]
    fn given_an_empty_name_when_looked_up_then_the_default_vault_alone_is_the_answer() {
        let mut registry = registry();
        registry.add_extra("Ana").unwrap();
        for empty in ["", "   ", "\u{200B}", "\u{00A0}\u{3000}"] {
            assert_eq!(registry.slots_named(empty), vec![SlotId::Main], "{empty:?}");
        }
        assert!(Registry::new(HashCost::TEST).slots_named("").is_empty());
    }

    #[test]
    fn given_two_vaults_with_one_name_when_looked_up_then_both_are_tried_oldest_first() {
        let mut registry = registry();
        let first = registry.add_extra("Sam").unwrap();
        let second = registry.add_extra("sam").unwrap();
        assert_eq!(registry.slots_named("SAM"), vec![first, second]);
    }

    #[test]
    fn given_a_name_too_long_to_be_one_when_looked_up_then_nothing_matches_and_nothing_fails() {
        let mut registry = registry();
        let name = "a".repeat(64);
        registry.add_extra(&name).unwrap();
        // A probe that starts like a stored name is not that name.
        assert!(registry.slots_named(&"a".repeat(65)).is_empty());
        assert!(registry.slots_named(&"a".repeat(100_000)).is_empty());
        assert_eq!(registry.slots_named(&name).len(), 1);
    }

    #[test]
    fn given_a_vault_with_no_name_when_looked_up_by_any_name_then_it_is_never_found() {
        let registry = registry();
        for typed in ["main", "default", "0", "ana"] {
            assert!(registry.slots_named(typed).is_empty(), "{typed}");
        }
    }

    #[test]
    fn given_the_first_vault_when_added_then_it_is_the_default_and_the_default_can_change() {
        let mut registry = Registry::new(HashCost::TEST);
        assert_eq!(registry.default_slot(), None);
        let first = registry.add_extra("one").unwrap();
        let second = registry.add_extra("two").unwrap();
        assert_eq!(registry.default_slot(), Some(first));
        assert_eq!(registry.slots(), vec![first, second]);
        registry.set_default(second).unwrap();
        assert_eq!(registry.default_slot(), Some(second));
        // The order is the order they were added, whatever the default is.
        assert_eq!(registry.slots(), vec![first, second]);
        assert_eq!(
            registry.set_default(SlotId::Extra(Uuid::new_v4())),
            Err(RegistryError::UnknownSlot)
        );
        // Still exactly one default.
        assert_eq!(registry.entries.iter().filter(|e| e.default).count(), 1);
    }

    #[test]
    fn given_the_default_vault_when_removed_then_the_oldest_left_becomes_the_default() {
        let mut registry = registry();
        let a = registry.add_extra("a").unwrap();
        let b = registry.add_extra("b").unwrap();
        registry.set_default(b).unwrap();
        registry.remove(b).unwrap();
        assert_eq!(registry.default_slot(), Some(SlotId::Main));
        registry.remove(SlotId::Main).unwrap();
        assert_eq!(registry.default_slot(), Some(a));
        registry.remove(a).unwrap();
        assert!(registry.is_empty());
        assert_eq!(registry.default_slot(), None);
        assert_eq!(registry.remove(a), Err(RegistryError::UnknownSlot));
        // Taking another vault out never changes the default.
        let mut registry = Registry::with_main(HashCost::TEST);
        let extra = registry.add_extra("x").unwrap();
        registry.remove(extra).unwrap();
        assert_eq!(registry.default_slot(), Some(SlotId::Main));
    }

    #[test]
    fn given_a_name_when_changed_or_taken_away_then_the_old_name_no_longer_finds_the_vault() {
        let mut registry = registry();
        let slot = registry.add_extra("old name").unwrap();
        registry.set_name(slot, Some("new name")).unwrap();
        assert!(registry.slots_named("old name").is_empty());
        assert_eq!(registry.slots_named("new name"), vec![slot]);
        registry.set_name(slot, None).unwrap();
        assert!(registry.slots_named("new name").is_empty());
        assert_eq!(
            registry.set_name(SlotId::Extra(Uuid::new_v4()), Some("x")),
            Err(RegistryError::UnknownSlot)
        );
        assert_eq!(
            registry.set_name(slot, Some("  ")),
            Err(RegistryError::Name(NameError::Empty))
        );
    }

    #[test]
    fn given_a_registry_when_written_and_read_back_then_it_is_the_same_registry() {
        let mut registry = registry();
        registry.add_extra("Ana").unwrap();
        registry.add_extra("Ben").unwrap();
        let read = Registry::from_bytes(&registry.to_bytes()).unwrap();
        assert_eq!(read, registry);
        assert_eq!(read.slots_named("ben").len(), 1);
    }

    #[test]
    fn given_registries_of_different_sizes_when_written_then_the_size_is_a_power_of_two_bucket() {
        let mut registry = Registry::with_main(HashCost::TEST);
        let one = registry.to_bytes().len();
        assert_eq!(one, MIN_FILE_BYTES);
        for index in 0..4 {
            registry.add_extra(&format!("name {index}")).unwrap();
        }
        // One and five vaults in one bucket: the size says nothing about the count.
        assert_eq!(registry.to_bytes().len(), one);
        for index in 0..40 {
            registry.add_extra(&format!("more {index}")).unwrap();
        }
        let big = registry.to_bytes().len();
        assert!(big > one && big.is_power_of_two());
        assert_eq!(
            Registry::from_bytes(&registry.to_bytes()).unwrap(),
            registry
        );
    }

    #[test]
    fn given_the_file_when_read_as_bytes_then_no_name_is_in_it_and_the_padding_is_random() {
        let mut registry = registry();
        registry.add_extra("Ana Lopez").unwrap();
        registry.add_extra("Mum").unwrap();
        let first = registry.to_bytes();
        let second = registry.to_bytes();
        let text = String::from_utf8_lossy(&first).to_lowercase();
        for name in ["ana", "lopez", "mum"] {
            assert!(!text.contains(name), "{name}");
        }
        // Same registry, same content, different padding: padding is not a pattern to read.
        assert_ne!(first, second);
        let end = HEADER_BYTES + u32::from_be_bytes(first[10..14].try_into().unwrap()) as usize;
        assert_eq!(first[..end], second[..end]);
    }

    #[test]
    fn given_two_devices_when_the_same_name_is_hashed_then_the_hashes_differ_by_the_device_salt() {
        let mut one = Registry::new(HashCost::TEST);
        let mut two = Registry::new(HashCost::TEST);
        one.add_extra("Ana").unwrap();
        two.add_extra("Ana").unwrap();
        assert_ne!(one.entries[0].name_hash, two.entries[0].name_hash);
        assert_ne!(one.salt, two.salt);
        // And one registry hashes two names to two values.
        one.add_extra("Ben").unwrap();
        assert_ne!(one.entries[0].name_hash, one.entries[1].name_hash);
    }

    fn mutated(registry: &Registry, change: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let mut bytes = registry.to_bytes();
        change(&mut bytes);
        bytes
    }

    #[test]
    fn given_a_file_that_is_not_exactly_what_is_written_when_read_then_it_is_damaged() {
        let mut registry = registry();
        registry.add_extra("Ana").unwrap();
        let good = registry.to_bytes();
        let damaged = [
            Vec::new(),
            good[..5].to_vec(),
            good[..good.len() - 1].to_vec(),
            [good.clone(), vec![0]].concat(),
            mutated(&registry, |b| b[0] ^= 1),
            mutated(&registry, |b| b[9] = 2),
            mutated(&registry, |b| {
                b[10..14].copy_from_slice(&u32::MAX.to_be_bytes())
            }),
            mutated(&registry, |b| {
                b[10..14].copy_from_slice(&0u32.to_be_bytes())
            }),
            mutated(&registry, |b| {
                let end = HEADER_BYTES + u32::from_be_bytes(b[10..14].try_into().unwrap()) as usize;
                b[HEADER_BYTES..end].fill(b'x');
            }),
            vec![0u8; MAX_FILE_BYTES + 1],
        ];
        for (index, bytes) in damaged.iter().enumerate() {
            assert_eq!(
                Registry::from_bytes(bytes),
                Err(RegistryError::Damaged),
                "case {index}"
            );
        }
        assert!(Registry::from_bytes(&good).is_ok());
    }

    fn file_with(stored: &Stored) -> Vec<u8> {
        let payload = serde_json::to_vec(stored).unwrap();
        let total = bucket(HEADER_BYTES + payload.len());
        let mut bytes = Vec::new();
        bytes.extend_from_slice(MAGIC);
        bytes.extend_from_slice(&FILE_VERSION.to_be_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&payload);
        bytes.resize(total, 0);
        bytes
    }

    fn stored_entry(slot: &str, default: bool) -> StoredEntry {
        StoredEntry {
            slot: slot.to_owned(),
            default,
            name: Some(B64.encode([7u8; NAME_HASH_BYTES])),
        }
    }

    fn stored(entries: Vec<StoredEntry>) -> Stored {
        Stored {
            cost: HashCost::TEST,
            salt: B64.encode([1u8; SALT_BYTES]),
            entries,
        }
    }

    #[test]
    fn given_an_inconsistent_payload_when_read_then_it_is_damaged() {
        let id = Uuid::new_v4().hyphenated().to_string();
        let other = Uuid::new_v4().hyphenated().to_string();
        // A consistent one is read, so the cases below fail for the reason they name.
        let fine = stored(vec![stored_entry("main", true), stored_entry(&id, false)]);
        assert!(Registry::from_bytes(&file_with(&fine)).is_ok());
        let cases: Vec<(&str, Stored)> = vec![
            ("no default", stored(vec![stored_entry("main", false)])),
            (
                "two defaults",
                stored(vec![stored_entry("main", true), stored_entry(&id, true)]),
            ),
            (
                "a duplicate slot",
                stored(vec![stored_entry(&id, true), stored_entry(&id, false)]),
            ),
            ("not a slot id", stored(vec![stored_entry("slot-1", true)])),
            (
                "an upper-case id",
                stored(vec![stored_entry(&other.to_uppercase(), true)]),
            ),
            (
                "an id without hyphens",
                stored(vec![stored_entry(&other.replace('-', ""), true)]),
            ),
            (
                "a short name hash",
                stored(vec![StoredEntry {
                    slot: "main".to_owned(),
                    default: true,
                    name: Some(B64.encode([1u8; 5])),
                }]),
            ),
            (
                "a name hash that is not base64",
                stored(vec![StoredEntry {
                    slot: "main".to_owned(),
                    default: true,
                    name: Some("***".to_owned()),
                }]),
            ),
        ];
        for (name, stored) in &cases {
            assert_eq!(
                Registry::from_bytes(&file_with(stored)),
                Err(RegistryError::Damaged),
                "{name}"
            );
        }
        // An empty registry is allowed (the last vault was removed).
        assert!(Registry::from_bytes(&file_with(&stored(vec![]))).is_ok());
        let mut short_salt = stored(vec![]);
        short_salt.salt = B64.encode([1u8; 4]);
        assert_eq!(
            Registry::from_bytes(&file_with(&short_salt)),
            Err(RegistryError::Damaged)
        );
    }

    #[test]
    fn given_a_cost_in_a_file_when_it_is_out_of_bounds_then_the_file_is_damaged() {
        for cost in [
            HashCost {
                memory_kib: 7,
                passes: 1,
                lanes: 1,
            },
            HashCost {
                memory_kib: 1 << 21,
                passes: 1,
                lanes: 1,
            },
            HashCost {
                memory_kib: 8,
                passes: 0,
                lanes: 1,
            },
            HashCost {
                memory_kib: 8,
                passes: 17,
                lanes: 1,
            },
            HashCost {
                memory_kib: 8,
                passes: 1,
                lanes: 0,
            },
            HashCost {
                memory_kib: 8,
                passes: 1,
                lanes: 9,
            },
            // Four lanes need at least 32 KiB.
            HashCost {
                memory_kib: 8,
                passes: 1,
                lanes: 4,
            },
        ] {
            let mut file = stored(vec![]);
            file.cost = cost;
            assert_eq!(
                Registry::from_bytes(&file_with(&file)),
                Err(RegistryError::Damaged),
                "{cost:?}"
            );
        }
        assert!(HashCost::DEVICE.acceptable());
        assert!(HashCost::TEST.acceptable());
    }

    #[test]
    fn given_a_data_directory_when_saved_and_loaded_then_the_registry_comes_back_and_absence_is_none(
    ) {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(Registry::load(temp.path()), Ok(None));
        let mut registry = Registry::with_main(HashCost::TEST);
        let slot = registry.add_extra("Ana").unwrap();
        registry.save(temp.path()).unwrap();
        let loaded = Registry::load(temp.path()).unwrap().unwrap();
        assert_eq!(loaded, registry);
        assert_eq!(loaded.slots_named("ana"), vec![slot]);
        // Saving again replaces the file (no temporary file is left beside it).
        registry.add_extra("Ben").unwrap();
        registry.save(temp.path()).unwrap();
        assert_eq!(Registry::load(temp.path()).unwrap().unwrap().len(), 3);
        let files: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files, vec![FILE_NAME.to_owned()]);
    }

    #[test]
    fn given_a_damaged_file_on_disk_when_loaded_then_it_is_an_error_not_an_empty_registry() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(FILE_NAME), b"not a registry").unwrap();
        assert_eq!(Registry::load(temp.path()), Err(RegistryError::Damaged));
    }

    #[test]
    fn given_the_main_vault_when_its_paths_are_made_then_they_are_where_the_device_always_kept_it()
    {
        let data = Path::new("/data");
        assert_eq!(slot_home(data, SlotId::Main), Path::new("/data/vault-home"));
        assert_eq!(
            slot_store_root(data, SlotId::Main),
            Path::new("/data/vault-home/vault-v1")
        );
    }

    #[test]
    fn given_an_extra_vault_when_its_paths_are_made_then_they_are_under_vaults_by_its_random_id() {
        let data = Path::new("/data");
        let id = Uuid::parse_str("0b6f1f1e-2d3c-4b5a-8c7d-9e0f1a2b3c4d").unwrap();
        assert_eq!(
            slot_home(data, SlotId::Extra(id)),
            Path::new("/data/vaults/0b6f1f1e-2d3c-4b5a-8c7d-9e0f1a2b3c4d/vault-home")
        );
        assert_eq!(
            slot_store_root(data, SlotId::Extra(id)),
            Path::new("/data/vaults/0b6f1f1e-2d3c-4b5a-8c7d-9e0f1a2b3c4d/vault-home/vault-v1")
        );
        // The folder says nothing about the owner: only the random id.
        let mut registry = Registry::with_main(HashCost::TEST);
        let slot = registry.add_extra("Ana Lopez").unwrap();
        let path = slot_home(data, slot).to_string_lossy().to_lowercase();
        assert!(!path.contains("ana") && !path.contains("lopez"));
    }

    #[test]
    fn given_slot_folders_on_disk_when_the_registry_lacks_one_then_only_that_one_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let mut registry = Registry::with_main(HashCost::TEST);
        assert!(unregistered_slot_folders(data, &registry)
            .unwrap()
            .is_empty());
        let listed = registry.add_extra("listed").unwrap();
        let half_made = SlotId::Extra(Uuid::new_v4());
        for slot in [listed, half_made] {
            fs::create_dir_all(slot_home(data, slot)).unwrap();
        }
        // Not slots: the main vault's folder, a file, a folder with another name.
        fs::create_dir_all(slot_home(data, SlotId::Main)).unwrap();
        fs::write(data.join(SLOTS_FOLDER).join("notes.txt"), b"x").unwrap();
        fs::create_dir_all(data.join(SLOTS_FOLDER).join("not-a-uuid")).unwrap();
        let SlotId::Extra(id) = half_made else {
            unreachable!()
        };
        assert_eq!(
            unregistered_slot_folders(data, &registry).unwrap(),
            vec![data.join(SLOTS_FOLDER).join(id.hyphenated().to_string())]
        );
    }

    #[test]
    fn given_two_hashes_when_compared_then_equal_ones_match_and_any_one_byte_difference_does_not() {
        let a = [9u8; NAME_HASH_BYTES];
        assert!(constant_time_eq(&a, &a));
        for index in 0..NAME_HASH_BYTES {
            let mut b = a;
            b[index] ^= 0x80;
            assert!(!constant_time_eq(&a, &b), "byte {index}");
        }
    }

    #[test]
    fn given_the_device_cost_when_checked_then_it_is_one_the_file_would_accept() {
        assert!(HashCost::DEVICE.acceptable());
        assert!(HashCost::DEVICE.argon().is_some());
    }
}
