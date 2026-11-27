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
//! - **File.** Magic, a version, the payload's length, the payload (JSON, with the number of the name
//!   normalisation it was made under), then random padding up to a power of two of at least 2 KiB.
//!   Readable by this user only (0600, the folder 0700); a symbolic link or other non-file in its place
//!   is refused. Every read-modify-write holds a device lock file ([`Registry::update`]). A damaged file
//!   is **never overwritten**: it is set aside under another name ([`set_aside_damaged`]) and recovered
//!   from by trying the passphrase against the slot folders.
//! - **Duplicates.** At most [`DUPLICATE_NAME_CAP`] vaults share a name, so an unlock always makes that
//!   many passphrase attempts (real ones and decoys): the timing never says how many share it. An
//!   unknown name must run the same decoy attempts (the unlock path's job, a later step).
//! - **Damaged and unsupported.** A file that is not exactly what this version writes, or whose
//!   payload is not consistent, is `Damaged`: it is never read as an empty registry, never repaired by
//!   guessing and never overwritten. A file with a NEWER file version or name-normalisation number than
//!   this version knows is `Unsupported` instead (a downgrade must not mistake a good registry for a
//!   broken one): it is refused the same way and never set aside. Written with an atomic replace, so
//!   a power loss leaves the old file or the new one.
#![cfg_attr(not(test), allow(dead_code))]

use argon2::{Algorithm, Argon2, Params, Version};
use atomicwrites::{AllowOverwrite, AtomicFile};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;
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

/// How a name is made comparable (see [`normalise_name`]). It is part of the stored file: a name hash
/// is only comparable under the rules it was made with, so a file with another number is `Damaged`
/// here, and a later version that changes the rules reads the old number and rehashes at unlock.
pub(crate) const NORMALISATION_VERSION: u32 = 1;
/// At most this many vaults may share one name. A lookup then costs a FIXED number of passphrase
/// attempts (this many, the real ones and decoys), so the timing of an unlock never says how many
/// vaults share a name. A tampered file with more is cut to this many.
pub(crate) const DUPLICATE_NAME_CAP: usize = 4;
/// The work of one unlock attempt by name, from [`Registry::plan_for`]: the vaults to try the
/// passphrase against, in registry order, and how many decoy derivations to add so the attempt does
/// the same number whatever the name matched. `unlock_plan::run_plan` carries it out.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UnlockPlan {
    /// Vaults the name matched (never more than [`DUPLICATE_NAME_CAP`]).
    pub(crate) real: Vec<SlotId>,
    /// Derivations to run against a decoy.
    pub(crate) decoys: usize,
}

impl UnlockPlan {
    /// How many passphrase derivations the attempt makes: the same for every named attempt.
    pub(crate) fn derivations(&self) -> usize {
        self.real.len() + self.decoys
    }
}

#[cfg(test)]
thread_local! {
    /// Name hashes made on this thread, for the tests that count the work of an attempt.
    pub(crate) static NAME_HASHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// The registry's lock file, beside it: every read-modify-write of the registry holds it.
const LOCK_NAME: &str = "vaults.v1.lock";

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
    pub(crate) fn text(self) -> String {
        match self {
            SlotId::Main => "main".to_owned(),
            SlotId::Extra(id) => id.hyphenated().to_string(),
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        if text == "main" {
            return Some(SlotId::Main);
        }
        let id = Uuid::parse_str(text).ok()?;
        // Only the canonical lower-case form, so one slot has one spelling.
        (id.hyphenated().to_string() == text).then_some(SlotId::Extra(id))
    }
}

/// What the registry cannot do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RegistryError {
    /// The file is not a registry this version wrote, or is not consistent: no registry.
    Damaged,
    Io,
    /// A name that cannot be a name (empty, too long, or with characters that cannot be typed).
    Name(NameError),
    /// No such slot in the registry.
    UnknownSlot,
    /// A hashing cost outside what a phone can bear.
    Cost,
    /// [`DUPLICATE_NAME_CAP`] vaults already have this name.
    NameTaken,
    /// The file was written by a NEWER version of the app (a later file version or name
    /// normalisation). It is good, only not readable here: never replaced, never set aside.
    Unsupported,
    /// `set_aside_damaged` found nothing damaged to set aside.
    NotDamaged,
}

impl From<io::Error> for RegistryError {
    fn from(_: io::Error) -> Self {
        RegistryError::Io
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum NameError {
    /// Nothing left after normalising.
    Empty,
    /// More than [`MAX_NAME_CHARS`] characters after normalising.
    TooLong,
    /// A control character, a private-use code point or a non-character: not something to type.
    Invalid,
}

/// How a typed name is made comparable, the same way at set-up and at unlock ([`NORMALISATION_VERSION`]
/// 1): Unicode NFKC; default-ignorable code points dropped (zero-width spaces and joiners, the soft
/// hyphen, the combining grapheme joiner, variation selectors, bidi controls, tag characters); then
/// the **full default case fold** (so "Weiß", "WEISS" and "weiss" are one name, and a final sigma "ς"
/// is "σ"; `to_lowercase` is not a case fold); NFKC again, since folding can leave a form NFKC
/// changes; any run of white space (no-break and ideographic spaces too) one space, trimmed. Accents
/// are **kept** ("José" is not "Jose"): folding them would merge unrelated names, so the set-up page
/// tells the owner to type it the same way. The intermediate strings are zeroed when dropped.
pub(crate) fn normalise_name(typed: &str) -> Zeroizing<String> {
    let visible = Zeroizing::new(
        typed
            .nfkc()
            .filter(|c| !is_default_ignorable(*c))
            .collect::<String>(),
    );
    let folded = Zeroizing::new(caseless::default_case_fold_str(&visible));
    let composed = Zeroizing::new(folded.nfkc().collect::<String>());
    Zeroizing::new(composed.split_whitespace().collect::<Vec<_>>().join(" "))
}

/// The Unicode `Default_Ignorable_Code_Point` property (DerivedCoreProperties): code points that show
/// nothing and could make two names look the same.
fn is_default_ignorable(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{034F}'
            | '\u{061C}'
            | '\u{115F}'..='\u{1160}'
            | '\u{17B4}'..='\u{17B5}'
            | '\u{180B}'..='\u{180F}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}'
            | '\u{3164}'
            | '\u{FE00}'..='\u{FE0F}'
            | '\u{FEFF}'
            | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFF8}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0000}'..='\u{E0FFF}'
    )
}

/// Characters a name may not hold at set-up: controls, private use and non-characters. (Unassigned
/// code points are not rejected: `std` has no assignment table, and adding one is out of this step.)
fn is_untypeable(c: char) -> bool {
    c.is_control()
        || matches!(c, '\u{E000}'..='\u{F8FF}' | '\u{FDD0}'..='\u{FDEF}' | '\u{F0000}'..='\u{10FFFF}')
        || (u32::from(c) & 0xFFFE) == 0xFFFE
}

/// A name checked for storing: normalised, 1 to [`MAX_NAME_CHARS`] characters.
fn checked_name(typed: &str) -> Result<Zeroizing<String>, NameError> {
    let name = normalise_name(typed);
    if name.chars().any(is_untypeable) {
        return Err(NameError::Invalid);
    }
    match name.chars().count() {
        0 => Err(NameError::Empty),
        n if n > MAX_NAME_CHARS => Err(NameError::TooLong),
        _ => Ok(name),
    }
}

/// Whether a typed name can be a vault's name (normalised, 1 to [`MAX_NAME_CHARS`] characters, no
/// private-use or non-character code points): asked before anything is locked or written, so a name
/// that would be refused costs the owner nothing.
pub(crate) fn name_is_valid(typed: &str) -> bool {
    checked_name(typed).is_ok()
}

/// The Argon2id cost of one name hash. It is stored in the registry, so it can be raised later and
/// an old file still checks with the cost it was made with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HashCost {
    pub(crate) memory_kib: u32,
    pub(crate) passes: u32,
    pub(crate) lanes: u32,
}

/// The most memory (KiB) a name hash may ask for: 128 MiB.
const MAX_MEMORY_KIB: u32 = 128 * 1024;

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
        // At most 128 MiB: a tampered file must not be able to make a phone run out of memory.
        (8..=MAX_MEMORY_KIB).contains(&self.memory_kib)
            && (1..=8).contains(&self.passes)
            && (1..=4).contains(&self.lanes)
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
    pub(crate) fn new(cost: HashCost) -> Result<Registry, RegistryError> {
        if !cost.acceptable() {
            return Err(RegistryError::Cost);
        }
        let mut salt = [0u8; SALT_BYTES];
        OsRng.fill_bytes(&mut salt);
        Ok(Registry {
            cost,
            salt,
            entries: Vec::new(),
        })
    }

    /// The registry of a device that has only the vault it has today: `Main`, the default, no name.
    pub(crate) fn with_main(cost: HashCost) -> Result<Registry, RegistryError> {
        let mut registry = Registry::new(cost)?;
        registry.entries.push(Entry {
            slot: SlotId::Main,
            default: true,
            name_hash: None,
        });
        Ok(registry)
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
        #[cfg(test)]
        NAME_HASHES.with(|count| count.set(count.get() + 1));
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
        self.refuse_a_name_taken_too_often(&hash, None)?;
        self.entries.push(Entry {
            slot,
            default: self.entries.is_empty(),
            name_hash: Some(hash),
        });
        Ok(slot)
    }

    /// Whether a vault could be added under `name` now, without adding it: the same checks as
    /// [`Registry::add_extra`] (a name that can be a name, and not already taken by
    /// [`DUPLICATE_NAME_CAP`] vaults), so an owner can be refused BEFORE their vault is locked.
    pub(crate) fn name_has_room(&self, name: &str) -> Result<(), RegistryError> {
        let name = checked_name(name).map_err(RegistryError::Name)?;
        let hash = self.hash_name(&name);
        self.refuse_a_name_taken_too_often(&hash, None)
    }

    /// Lists a vault that already exists on disk under `slot` (its folder was found, and opened by
    /// the owner's passphrase) with the name the owner now gives it (#357 4c-2). Never the default
    /// unless the registry was empty. `slot` must be an extra one the registry does not list yet
    /// (`UnknownSlot` otherwise), and the name follows the same cap as any other.
    pub(crate) fn add_recovered(&mut self, slot: SlotId, name: &str) -> Result<(), RegistryError> {
        if !matches!(slot, SlotId::Extra(_)) || self.contains(slot) {
            return Err(RegistryError::UnknownSlot);
        }
        let name = checked_name(name).map_err(RegistryError::Name)?;
        let hash = self.hash_name(&name);
        self.refuse_a_name_taken_too_often(&hash, None)?;
        self.entries.push(Entry {
            slot,
            default: self.entries.is_empty(),
            name_hash: Some(hash),
        });
        Ok(())
    }

    /// A name may be shared (a check at the unlock screen would tell anyone there which names exist),
    /// but by at most [`DUPLICATE_NAME_CAP`] vaults, so an unlock tries a fixed number.
    fn refuse_a_name_taken_too_often(
        &self,
        hash: &[u8; NAME_HASH_BYTES],
        except: Option<SlotId>,
    ) -> Result<(), RegistryError> {
        let sharing = self
            .entries
            .iter()
            .filter(|entry| Some(entry.slot) != except)
            .filter(|entry| {
                entry
                    .name_hash
                    .as_ref()
                    .is_some_and(|stored| constant_time_eq(stored, hash))
            })
            .count();
        if sharing >= DUPLICATE_NAME_CAP {
            return Err(RegistryError::NameTaken);
        }
        Ok(())
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
                let hash = self.hash_name(&name);
                self.refuse_a_name_taken_too_often(&hash, Some(slot))?;
                Some(hash)
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
        let probe = Zeroizing::new(
            normalise_name(typed)
                .chars()
                .take(MAX_PROBE_CHARS)
                .collect::<String>(),
        );
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
        // The cap holds for what this version wrote; a tampered file cannot widen it.
        found.truncate(DUPLICATE_NAME_CAP);
        found
    }

    /// What one unlock attempt with a typed name must do (#357, PR 4a). **A named attempt always
    /// makes [`DUPLICATE_NAME_CAP`] derivations**: the vaults the name matched (0 to the cap), then
    /// decoys up to the cap, so 0, 1 or 4 matches cost the same and no one learns from the time how
    /// many vaults share a name, or whether it names any. An empty name is the default vault alone,
    /// ONE derivation as today (a known default reveals nothing). Costs one name hash for a named
    /// attempt, none for an empty one.
    pub(crate) fn plan_for(&self, typed: &str) -> UnlockPlan {
        let named = !normalise_name(typed).is_empty();
        let real = self.slots_named(typed);
        let total = if named { DUPLICATE_NAME_CAP } else { 1 };
        UnlockPlan {
            decoys: total.saturating_sub(real.len()),
            real,
        }
    }

    // ---- the file ---------------------------------------------------------------------------

    /// The registry as the bytes `vaults.v1` holds: header, payload, then random padding to a power
    /// of two of at least [`MIN_FILE_BYTES`].
    pub(crate) fn to_bytes(&self) -> Vec<u8> {
        let stored = Stored {
            normalisation: NORMALISATION_VERSION,
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
        // A newer file's layout is not known, so nothing else of it is read.
        if version > FILE_VERSION {
            return Err(RegistryError::Unsupported);
        }
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
        // The normalisation number is read before the rest of the payload: a newer one means the
        // names were hashed under rules this version does not have, whatever else the file holds.
        let numbers: NumbersOnly = serde_json::from_slice(&bytes[HEADER_BYTES..end])
            .map_err(|_| RegistryError::Damaged)?;
        if numbers.normalisation > NORMALISATION_VERSION {
            return Err(RegistryError::Unsupported);
        }
        let stored: Stored = serde_json::from_slice(&bytes[HEADER_BYTES..end])
            .map_err(|_| RegistryError::Damaged)?;
        if stored.normalisation != NORMALISATION_VERSION || !stored.cost.acceptable() {
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

    /// The registry of a device, or `None` when it has none yet (the file is absent). A symbolic link,
    /// a folder or another non-file at its place, a file over the size bound (checked before it is
    /// read) and a file that is not a registry are errors: **never an empty registry**.
    pub(crate) fn load(data_dir: &Path) -> Result<Option<Registry>, RegistryError> {
        let path = data_dir.join(FILE_NAME);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(RegistryError::Io),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RegistryError::Damaged);
        }
        if metadata.len() > MAX_FILE_BYTES as u64 {
            return Err(RegistryError::Damaged);
        }
        let bytes = fs::read(&path).map_err(|_| RegistryError::Io)?;
        Registry::from_bytes(&bytes).map(Some)
    }

    /// Writes the registry, replacing the file atomically, readable by this user only (0600; the
    /// folder it is made in 0700) because the salt and the name hashes are what someone could test
    /// guesses against. **Refuses to replace a file that is not a registry** (a damaged one is set
    /// aside first, [`set_aside_damaged`], never overwritten), and refuses a symbolic link or another
    /// non-file at its place or as its folder. Callers that read, change and write hold
    /// [`Registry::update`]'s lock instead of calling this directly.
    pub(crate) fn save(&self, data_dir: &Path) -> Result<(), RegistryError> {
        create_private_dir_all(data_dir)?;
        let folder = fs::symlink_metadata(data_dir)?;
        if !folder.is_dir() || folder.file_type().is_symlink() {
            return Err(RegistryError::Io);
        }
        let path = data_dir.join(FILE_NAME);
        if fs::symlink_metadata(&path).is_ok() {
            // Whatever is there must be a registry this version reads: load says Damaged otherwise.
            Registry::load(data_dir)?;
        }
        let bytes = self.to_bytes();
        AtomicFile::new(&path, AllowOverwrite)
            .write(|file| {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(fs::Permissions::from_mode(0o600))?;
                }
                file.write_all(&bytes)
            })
            .map_err(|_| RegistryError::Io)
    }

    /// Reads the registry under the device lock, lets `change` change it, and writes it back, so two
    /// writers (two windows, a second instance) can never lose each other's change. `create` makes the
    /// registry when the device has none yet. Not called by the app yet.
    pub(crate) fn update<T>(
        data_dir: &Path,
        create: impl FnOnce() -> Result<Registry, RegistryError>,
        change: impl FnOnce(&mut Registry) -> Result<T, RegistryError>,
    ) -> Result<T, RegistryError> {
        create_private_dir_all(data_dir)?;
        let _lock = RegistryLock::take(data_dir)?;
        let mut registry = match Registry::load(data_dir)? {
            Some(registry) => registry,
            None => create()?,
        };
        let value = change(&mut registry)?;
        registry.save(data_dir)?;
        Ok(value)
    }
}

/// The device lock of the registry: a file beside it, never removed or renamed (so no one can lock a
/// new file while the old is held), opened without following a symbolic link. Held until dropped.
struct RegistryLock {
    _file: fs::File,
}

impl RegistryLock {
    fn take(data_dir: &Path) -> Result<RegistryLock, RegistryError> {
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(data_dir.join(LOCK_NAME))?;
        if !file.metadata()?.is_file() {
            return Err(RegistryError::Io);
        }
        file.lock()?;
        Ok(RegistryLock { _file: file })
    }
}

/// Moves a registry file that is damaged (or is not a file this version reads) out of the way to
/// `vaults.v1.damaged-<seconds>-<uuid>` beside it, and gives that path. **Never deletes it**: it holds
/// the only record of which slot folders belong to a vault, and recovery from it is by the owner (try
/// the passphrase against the slot folders listed by [`unregistered_slot_folders`] with an empty
/// registry). Whoever does that writes a new registry afterwards; until then `save` refuses.
///
/// Under the device lock it reads the file again, and moves it only if it is still `Damaged`: a good
/// one (another writer repaired it meanwhile) is `NotDamaged`, a newer one is `Unsupported`, and
/// neither is touched. **It takes the device lock itself, so it must not be called from inside
/// [`Registry::update`]** (the lock is not re-entrant: it would wait for itself); `update` refuses a
/// damaged file with `Damaged`, and the caller then calls this.
pub(crate) fn set_aside_damaged(data_dir: &Path) -> Result<PathBuf, RegistryError> {
    let _lock = RegistryLock::take(data_dir)?;
    match Registry::load(data_dir) {
        Err(RegistryError::Damaged) => {}
        Ok(_) => return Err(RegistryError::NotDamaged),
        Err(other) => return Err(other),
    }
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let target = data_dir.join(format!("{FILE_NAME}.damaged-{seconds}-{}", Uuid::new_v4()));
    fs::rename(data_dir.join(FILE_NAME), &target)?;
    Ok(target)
}

/// A folder (and what is above it that is missing), made readable by this user only on Unix.
fn create_private_dir_all(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    // A folder that was already there (the app's data folder) is made private too, as the vault's
    // own folders are (`create_private_dir_all` in vault.rs).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Just the number a later version may change, to tell "newer" from "broken" before anything else.
#[derive(Deserialize)]
struct NumbersOnly {
    normalisation: u32,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    /// The rules the names were hashed under ([`NORMALISATION_VERSION`]).
    normalisation: u32,
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
    bool::from(a.ct_eq(b))
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

    fn norm(typed: &str) -> String {
        normalise_name(typed).to_string()
    }

    fn registry() -> Registry {
        Registry::with_main(HashCost::TEST).unwrap()
    }

    #[test]
    fn given_typed_names_that_differ_only_by_case_spacing_or_invisible_marks_when_normalised_then_they_are_one_name(
    ) {
        let one = norm("Ana  Lopez");
        assert_eq!(one, "ana lopez");
        assert_eq!(norm(" ANA LOPEZ "), one);
        assert_eq!(norm("ana\u{00A0}lopez"), one);
        assert_eq!(norm("ana\u{3000}\u{3000}lopez"), one);
        assert_eq!(norm("a\u{200B}na lo\u{FEFF}pez"), one);
        assert_eq!(norm("\u{202E}ana lopez\u{202C}"), one);
        // Compatibility forms: a full-width name and a ligature.
        assert_eq!(norm("ＡＮＡ ＬＯＰＥＺ"), one);
        assert_eq!(norm("ﬁnn"), "finn");
        // A combining accent and the precomposed letter are the same name.
        assert_eq!(norm("Jose\u{301}"), norm("Jos\u{E9}"));
    }

    #[test]
    fn given_accents_when_normalised_then_they_are_kept() {
        assert_ne!(norm("José"), norm("Jose"));
        assert_eq!(norm("José"), "josé");
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
        assert!(Registry::new(HashCost::TEST)
            .unwrap()
            .slots_named("")
            .is_empty());
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
        let mut registry = Registry::new(HashCost::TEST).unwrap();
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
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
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
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
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
        // Names long enough that random bytes cannot spell them. A 3-letter name ("ana", "mum") has a
        // real chance of appearing by luck among the random bytes of the salts, hashes and padding
        // (about 1 in 10^4 for a file of this size), and this test failed in CI on both. A name of
        // 12+ characters is a chance of about 2^-96. The whole file is searched, padding included:
        // the point is that no name is anywhere in it.
        let long_names = ["FAKE-Ana-Lopez-Example", "FAKE-Mumford-Household"];
        let mut registry = registry();
        for name in long_names {
            registry.add_extra(name).unwrap();
        }
        let first = registry.to_bytes();
        let second = registry.to_bytes();
        let text = String::from_utf8_lossy(&first).to_lowercase();
        for name in long_names {
            let lowered = name.to_lowercase();
            assert!(!text.contains(&lowered), "{name}");
            assert!(!text.contains(&lowered.replace('-', " ")), "{name}");
            // Each part of the name that is long enough not to be found by chance.
            for part in lowered.split('-').filter(|part| part.len() >= 7) {
                assert!(!text.contains(part), "{part}");
            }
        }
        // Same registry, same content, different padding: padding is not a pattern to read.
        assert_ne!(first, second);
        let end = HEADER_BYTES + u32::from_be_bytes(first[10..14].try_into().unwrap()) as usize;
        assert_eq!(first[..end], second[..end]);
    }

    #[test]
    fn given_two_devices_when_the_same_name_is_hashed_then_the_hashes_differ_by_the_device_salt() {
        let mut one = Registry::new(HashCost::TEST).unwrap();
        let mut two = Registry::new(HashCost::TEST).unwrap();
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
            // Version 0 never existed (a newer one is `Unsupported`, tested apart).
            mutated(&registry, |b| b[9] = 0),
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
            normalisation: NORMALISATION_VERSION,
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
                memory_kib: 128 * 1024 + 1,
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
                passes: 9,
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
                lanes: 5,
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
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
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
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
        let slot = registry.add_extra("Ana Lopez").unwrap();
        let path = slot_home(data, slot).to_string_lossy().to_lowercase();
        assert!(!path.contains("ana") && !path.contains("lopez"));
    }

    #[test]
    fn given_slot_folders_on_disk_when_the_registry_lacks_one_then_only_that_one_is_reported() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
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

    #[test]
    fn given_names_that_differ_only_by_a_case_fold_when_normalised_then_they_are_one_name() {
        // Full default case folding, not lower-casing.
        assert_eq!(norm("Weiß"), norm("WEISS"));
        assert_eq!(norm("Weiß"), norm("weiss"));
        assert_eq!(norm("STRAẞE"), norm("strasse"));
        // A final sigma and a medial one are one letter; so is the capital.
        assert_eq!(norm("ΟΔΥΣΣΕΥΣ"), norm("οδυσσευς"));
        assert_eq!(norm("σας"), norm("σασ"));
        assert_eq!(norm("ΣΑΣ"), norm("σας"));
        // A dotted capital I, a long s and the Kelvin sign.
        assert_eq!(norm("İ"), norm("i\u{307}"));
        assert_eq!(norm("ſun"), norm("SUN"));
        assert_eq!(norm("\u{212A}"), norm("k"));
        // Still not accents.
        assert_ne!(norm("Weiß"), norm("Weiss\u{301}"));
    }

    #[test]
    fn given_default_ignorable_code_points_when_normalised_then_they_are_dropped() {
        let plain = norm("ana lopez");
        for c in [
            '\u{00AD}',
            '\u{034F}',
            '\u{200B}',
            '\u{200D}',
            '\u{2060}',
            '\u{2064}',
            '\u{FE0F}',
            '\u{180E}',
            '\u{FEFF}',
            '\u{E0001}',
            '\u{E0100}',
        ] {
            assert_eq!(
                norm(&format!("ana{c} lopez")),
                plain,
                "{:04X}",
                u32::from(c)
            );
        }
    }

    #[test]
    fn given_characters_that_cannot_be_typed_when_a_name_is_checked_then_it_is_invalid() {
        for typed in [
            "ana\u{7}",
            "ana\u{E000}",
            "ana\u{FDD0}",
            "ana\u{10FFFF}",
            "ana\u{FFFE}",
            "ana\u{1FFFF}",
        ] {
            assert_eq!(
                checked_name(typed).err(),
                Some(NameError::Invalid),
                "{typed:?}"
            );
        }
        assert!(checked_name("ana lopez 北京").is_ok());
    }

    #[test]
    fn given_a_registry_when_written_then_it_names_the_normalisation_it_used_and_another_number_is_damaged(
    ) {
        let registry = registry();
        let text = String::from_utf8_lossy(&registry.to_bytes()).into_owned();
        assert!(text.contains(&format!("\"normalisation\":{NORMALISATION_VERSION}")));
        // A newer number is a good file this version cannot read; zero never existed.
        let mut other = stored(vec![]);
        other.normalisation = NORMALISATION_VERSION + 1;
        assert_eq!(
            Registry::from_bytes(&file_with(&other)),
            Err(RegistryError::Unsupported)
        );
        other.normalisation = 0;
        assert_eq!(
            Registry::from_bytes(&file_with(&other)),
            Err(RegistryError::Damaged)
        );
    }

    #[test]
    fn given_a_cost_a_phone_cannot_bear_when_a_registry_is_made_then_it_is_refused() {
        for cost in [
            HashCost {
                memory_kib: 128 * 1024 + 1,
                passes: 1,
                lanes: 1,
            },
            HashCost {
                memory_kib: 7,
                passes: 1,
                lanes: 1,
            },
            HashCost {
                memory_kib: 8,
                passes: 9,
                lanes: 1,
            },
            HashCost {
                memory_kib: 8,
                passes: 1,
                lanes: 5,
            },
        ] {
            assert_eq!(
                Registry::new(cost).err(),
                Some(RegistryError::Cost),
                "{cost:?}"
            );
            assert_eq!(Registry::with_main(cost).err(), Some(RegistryError::Cost));
        }
        assert!(Registry::new(HashCost {
            memory_kib: 128 * 1024,
            passes: 8,
            lanes: 4
        })
        .is_ok());
    }

    #[test]
    fn given_more_vaults_than_the_cap_with_one_name_when_added_or_renamed_then_it_is_refused() {
        let mut registry = registry();
        let mut slots = Vec::new();
        for _ in 0..DUPLICATE_NAME_CAP {
            slots.push(registry.add_extra("Sam").unwrap());
        }
        assert_eq!(registry.add_extra("sam"), Err(RegistryError::NameTaken));
        // A fifth vault with another name, renamed to the full name, is refused too.
        let other = registry.add_extra("Other").unwrap();
        assert_eq!(
            registry.set_name(other, Some("SAM")),
            Err(RegistryError::NameTaken)
        );
        // Renaming one of the four to the same name is not a new sharer.
        assert_eq!(registry.set_name(slots[0], Some("sam")), Ok(()));
        assert_eq!(registry.slots_named("sam").len(), DUPLICATE_NAME_CAP);
        // Taking one away makes room.
        registry.set_name(slots[1], None).unwrap();
        assert_eq!(registry.set_name(other, Some("SAM")), Ok(()));
    }

    #[test]
    fn given_a_tampered_file_with_too_many_sharers_when_looked_up_then_the_answer_is_cut_to_the_cap(
    ) {
        let mut registry = registry();
        for _ in 0..DUPLICATE_NAME_CAP {
            registry.add_extra("Sam").unwrap();
        }
        let hash = registry.entries[1].name_hash;
        for _ in 0..3 {
            registry.entries.push(Entry {
                slot: SlotId::Extra(Uuid::new_v4()),
                default: false,
                name_hash: hash,
            });
        }
        let read = Registry::from_bytes(&registry.to_bytes()).unwrap();
        assert_eq!(read.slots_named("sam").len(), DUPLICATE_NAME_CAP);
    }

    #[cfg(unix)]
    #[test]
    fn given_a_saved_registry_when_its_permissions_are_read_then_only_this_user_can_read_it() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("fresh").join("data");
        registry().save(&data).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&data.join(FILE_NAME)), 0o600);
        assert_eq!(mode(&data), 0o700);
        // Saving again keeps it.
        registry().save(&data).unwrap();
        assert_eq!(mode(&data.join(FILE_NAME)), 0o600);
        // The lock file too.
        Registry::update(&data, || Registry::new(HashCost::TEST), |_| Ok(())).unwrap();
        assert_eq!(mode(&data.join(LOCK_NAME)), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn given_a_symbolic_link_or_a_folder_where_the_file_goes_when_loaded_or_saved_then_it_is_refused(
    ) {
        // Each case in a folder of its own (nothing is removed in a test: #71).
        let linked = tempfile::tempdir().unwrap();
        let target = linked.path().join("elsewhere");
        fs::write(&target, registry().to_bytes()).unwrap();
        std::os::unix::fs::symlink(&target, linked.path().join(FILE_NAME)).unwrap();
        assert_eq!(Registry::load(linked.path()), Err(RegistryError::Damaged));
        assert_eq!(registry().save(linked.path()), Err(RegistryError::Damaged));
        // A folder at its place.
        let folder = tempfile::tempdir().unwrap();
        fs::create_dir(folder.path().join(FILE_NAME)).unwrap();
        assert_eq!(Registry::load(folder.path()), Err(RegistryError::Damaged));
        assert_eq!(registry().save(folder.path()), Err(RegistryError::Damaged));
        // The data directory itself a symbolic link.
        let real = tempfile::tempdir().unwrap();
        let link = real.path().join("link");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();
        assert_eq!(registry().save(&link), Err(RegistryError::Io));
        // And a registry made properly is read.
        let good = tempfile::tempdir().unwrap();
        registry().save(good.path()).unwrap();
        assert!(Registry::load(good.path()).unwrap().is_some());
    }

    #[test]
    fn given_a_file_over_the_size_bound_when_loaded_then_it_is_damaged_without_being_read() {
        let temp = tempfile::tempdir().unwrap();
        let file = fs::File::create(temp.path().join(FILE_NAME)).unwrap();
        // A sparse file one byte over the bound: reading it would take 16 MiB.
        file.set_len(MAX_FILE_BYTES as u64 + 1).unwrap();
        assert_eq!(Registry::load(temp.path()), Err(RegistryError::Damaged));
    }

    #[test]
    fn given_a_damaged_registry_when_saved_over_then_it_is_refused_and_set_aside_it_is_kept() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        fs::write(data.join(FILE_NAME), b"scribble").unwrap();
        assert_eq!(registry().save(data), Err(RegistryError::Damaged));
        assert_eq!(fs::read(data.join(FILE_NAME)).unwrap(), b"scribble");
        // update() refuses too, and changes nothing.
        let outcome = Registry::update(data, || Registry::new(HashCost::TEST), |_| Ok(()));
        assert_eq!(outcome, Err(RegistryError::Damaged));
        let aside = set_aside_damaged(data).unwrap();
        assert_eq!(fs::read(&aside).unwrap(), b"scribble");
        assert!(aside
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("vaults.v1.damaged-"));
        assert_eq!(Registry::load(data), Ok(None));
        // Now a new registry may be written; the set-aside file stays.
        registry().save(data).unwrap();
        assert!(aside.exists());
    }

    #[test]
    fn given_two_writers_when_they_update_at_once_then_neither_change_is_lost() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().to_path_buf();
        Registry::update(&data, || Registry::with_main(HashCost::TEST), |_| Ok(())).unwrap();
        let threads: Vec<_> = (0..8)
            .map(|index| {
                let data = data.clone();
                std::thread::spawn(move || {
                    Registry::update(
                        &data,
                        || Registry::with_main(HashCost::TEST),
                        |registry| registry.add_extra(&format!("writer {index}")).map(|_| ()),
                    )
                    .unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let registry = Registry::load(&data).unwrap().unwrap();
        assert_eq!(registry.len(), 9);
        for index in 0..8 {
            assert_eq!(registry.slots_named(&format!("writer {index}")).len(), 1);
        }
    }

    #[test]
    fn given_an_update_that_fails_when_it_returns_an_error_then_nothing_is_written() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        Registry::update(data, || Registry::with_main(HashCost::TEST), |_| Ok(())).unwrap();
        let before = fs::read(data.join(FILE_NAME)).unwrap();
        let outcome: Result<(), _> = Registry::update(
            data,
            || Registry::with_main(HashCost::TEST),
            |registry| registry.set_default(SlotId::Extra(Uuid::new_v4())),
        );
        assert_eq!(outcome, Err(RegistryError::UnknownSlot));
        assert_eq!(fs::read(data.join(FILE_NAME)).unwrap(), before);
    }

    #[test]
    fn given_a_newer_file_version_or_normalisation_when_read_then_it_is_unsupported_and_never_moved(
    ) {
        let mut newer_version = registry().to_bytes();
        newer_version[8..10].copy_from_slice(&(FILE_VERSION + 1).to_be_bytes());
        // Nothing past the version of a newer file is looked at, so even a garbled rest is "newer".
        newer_version[10..14].copy_from_slice(&u32::MAX.to_be_bytes());
        let mut newer_numbers = stored(vec![]);
        newer_numbers.normalisation = NORMALISATION_VERSION + 1;
        let newer_numbers = file_with(&newer_numbers);
        for bytes in [newer_version, newer_numbers] {
            assert_eq!(
                Registry::from_bytes(&bytes),
                Err(RegistryError::Unsupported)
            );
            let temp = tempfile::tempdir().unwrap();
            let data = temp.path();
            fs::write(data.join(FILE_NAME), &bytes).unwrap();
            assert_eq!(Registry::load(data), Err(RegistryError::Unsupported));
            assert_eq!(registry().save(data), Err(RegistryError::Unsupported));
            let outcome = Registry::update(data, || Registry::new(HashCost::TEST), |_| Ok(()));
            assert_eq!(outcome, Err(RegistryError::Unsupported));
            // Never set aside: a downgrade must not lose the names of a good registry.
            assert_eq!(set_aside_damaged(data), Err(RegistryError::Unsupported));
            assert_eq!(fs::read(data.join(FILE_NAME)).unwrap(), bytes);
        }
    }

    #[test]
    fn given_a_healthy_or_absent_registry_when_set_aside_is_asked_then_nothing_is_moved() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        assert_eq!(set_aside_damaged(data), Err(RegistryError::NotDamaged));
        registry().save(data).unwrap();
        let before = fs::read(data.join(FILE_NAME)).unwrap();
        assert_eq!(set_aside_damaged(data), Err(RegistryError::NotDamaged));
        assert_eq!(fs::read(data.join(FILE_NAME)).unwrap(), before);
    }

    #[cfg(unix)]
    #[test]
    fn given_a_data_folder_that_already_exists_when_saved_into_then_it_is_made_0700() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o755)).unwrap();
        registry().save(temp.path()).unwrap();
        assert_eq!(
            fs::metadata(temp.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    /// The stored format freezes with the first saved name, so these outputs are pinned: if a
    /// dependency bump (`caseless`, `unicode-normalization`) changes one, every name already saved
    /// would stop matching. Do not edit an expectation; raise `NORMALISATION_VERSION` and keep the
    /// old rules readable instead.
    #[test]
    fn given_the_pinned_rules_when_names_are_normalised_then_the_outputs_are_the_golden_ones() {
        let golden: [(&str, &str); 14] = [
            ("Weiß", "weiss"),
            ("STRAẞE", "strasse"),
            ("ΟΔΥΣΣΕΥΣ", "οδυσσευσ"),
            ("σας", "σασ"),
            ("İstanbul", "i\u{307}stanbul"),
            ("ﬁnance", "finance"),
            ("Ａna　Ｌopez", "ana lopez"),
            ("  Ana \t\n  López ", "ana lópez"),
            ("Jose\u{301}", "josé"),
            ("a\u{200B}b\u{00AD}c\u{2060}d\u{FEFF}e", "abcde"),
            // NFKC after the fold turns the single letter into two: pinned as it is.
            ("ǅ", "d\u{17E}"),
            ("ᾼ", "αι"),
            ("北京 Ａ", "北京 a"),
            ("\u{212A}elvin", "kelvin"),
        ];
        for (typed, expected) in golden {
            assert_eq!(norm(typed), expected, "{typed:?}");
        }
    }
}
