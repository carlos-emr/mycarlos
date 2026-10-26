//! The vault's history (#71): one entry per event, hash-chained, kept inside
//! the vault in encrypted segments that look like documents. The app only
//! ever appends to it, and never shows it in its screens.
//!
//! An entry's canonical form is the UTF-8 JSON `serde_json` writes for
//! [`HistoryEntry`]: its fields in the order declared here, absent optional
//! fields left out, no whitespace, integers as integers, strings escaped as
//! JSON requires (and nothing else escaped). Its hash is
//! SHA-256(`HASH_DOMAIN` ‖ that JSON), written in lower-case hex. Each entry
//! names the hash of the one before it; the first names the genesis value,
//! SHA-256(`GENESIS_DOMAIN` ‖ the vault id's 16 bytes). VAULT_FORMAT.md
//! states the same rules, with test vectors, so that the chain can be checked
//! without the app.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const HASH_DOMAIN: &[u8] = b"mycarlos/history/v1\0";
pub const GENESIS_DOMAIN: &[u8] = b"mycarlos/history/genesis/v1";

/// Each segment's plaintext is exactly this long: entries, one per line,
/// then spaces. A segment is closed when the next entry would not fit.
pub const SEGMENT_PLAINTEXT_BYTES: usize = 64 * 1024;

/// A place (where a readable copy was saved) is kept up to this many
/// characters; a longer one is cut, and the SHA-256 of the whole is kept
/// beside it, so that no entry can outgrow a segment.
pub const MAX_PLACE_CHARS: usize = 256;

/// A move names at most this many folders on each side; when there were
/// more, it says how many in all. With every other cap (names of 120 and 240
/// characters, a place of 256) no entry can outgrow a segment.
pub const MAX_FOLDERS_RECORDED: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryEvent {
    /// The vault was made. The first entry of a new vault.
    Created,
    /// A vault made by an earlier build began keeping a history here.
    HistoryStarted,
    /// Opened, with the passphrase or the recovery key. Says how the session
    /// before it ended, when this run of the app knows.
    Unlocked,
    Imported,
    Renamed,
    Moved,
    Hidden,
    Restored,
    /// A readable copy saved outside the vault.
    CopySaved,
    RecoveryKeySet,
    BackupSaved,
    /// This vault was put in place from a backup.
    BackupRestored,
    /// The passphrase was replaced: in Security (`how` "passphrase"), or
    /// with the recovery key when it was forgotten ("recoveryKey").
    PassphraseChanged,
    /// A patient profile was added.
    ProfileCreated,
    /// Identity details changed; only the profile id is recorded.
    ProfileDetailsChanged,
    /// A folder was made; `to` says in which folder ("My records" is none).
    FolderCreated,
    FolderRenamed,
    /// A folder moved; `from` and `to` are the folder it was in and the one
    /// it is in now.
    FolderMoved,
    /// This vault was set aside (#71's third part): moved, whole and still
    /// encrypted, into `set-aside/`, never erased.
    SetAside,
    PortalLinkStarted,
    PortalLinked,
    DeviceApprovalRequested,
    DeviceApprovalVerified,
    DeviceApprovalStatusChanged,
    DeviceApprovalRequestRestarted,
    DeliveryFiled,
    DeliveryReceiptSettled,
}

/// A folder as it was named at the time of the event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FolderAtTheTime {
    pub id: Uuid,
    pub name: String,
}

/// One event. The field order is the canonical order: do not reorder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryEntry {
    pub seq: u64,
    pub at_ms: u64,
    /// The app version that wrote it.
    pub app: String,
    pub event: HistoryEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<Uuid>,
    /// For a profile's event, a folder's owner, shared intake's source profile,
    /// or a document move's destination person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<Uuid>,
    /// For a folder's event.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<Uuid>,
    /// The document's, folder's or profile's name at that moment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_name: Option<String>,
    /// For a move: the folders before and after ("My records" is none).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<Vec<FolderAtTheTime>>,
    /// How many folders there were before, when `from` names only the first
    /// `MAX_FOLDERS_RECORDED`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<Vec<FolderAtTheTime>>,
    /// As `from_total`, for after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_total: Option<u64>,
    /// How: for an import, where it came from ("picked"); for an unlock or a
    /// passphrase change, the secret ("passphrase" or "recoveryKey"); for a
    /// hidden document, why ("patient" or "damaged").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how: Option<String>,
    /// Where a readable copy or a backup was saved, cut to
    /// `MAX_PLACE_CHARS`; for a vault set aside, and for the vault created
    /// after it in the same run of the app, the folder it was set aside in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    /// The SHA-256 of the whole place, when it was cut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place_sha256: Option<String>,
    /// For an unlock: how the previous session ended, as far as this run of
    /// the app knows ("lockedAt:<ms>:<by>"), or "notRecorded".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub portal_link_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clinic_key_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ciphertext_sha256: Option<String>,
    /// The hash of the entry before this one.
    pub prev: String,
}

impl HistoryEntry {
    /// An event to append, before it has its place in the chain.
    pub fn new(event: HistoryEvent, at_ms: u64) -> Self {
        Self {
            seq: 0,
            at_ms,
            app: env!("CARGO_PKG_VERSION").to_owned(),
            event,
            record_id: None,
            profile_id: None,
            folder_id: None,
            name: None,
            old_name: None,
            from: None,
            from_total: None,
            to: None,
            to_total: None,
            how: None,
            place: None,
            place_sha256: None,
            previous_session: None,
            portal_link_id: None,
            clinic_key_ids: None,
            delivery_id: None,
            ciphertext_sha256: None,
            prev: String::new(),
        }
    }

    /// Sets where a copy was saved, cut to `MAX_PLACE_CHARS` with the hash of
    /// the whole when it is longer.
    pub fn with_place(mut self, place: &str) -> Self {
        if place.chars().count() > MAX_PLACE_CHARS {
            self.place = Some(place.chars().take(MAX_PLACE_CHARS).collect());
            self.place_sha256 = Some(hex(&Sha256::digest(place.as_bytes())));
        } else {
            self.place = Some(place.to_owned());
        }
        self
    }

    /// Sets the folders before and after a move, each cut to
    /// `MAX_FOLDERS_RECORDED` with the number there were.
    pub fn with_move(mut self, from: Vec<FolderAtTheTime>, to: Vec<FolderAtTheTime>) -> Self {
        let cut = |mut folders: Vec<FolderAtTheTime>| {
            let total = folders.len();
            folders.truncate(MAX_FOLDERS_RECORDED);
            (
                folders,
                (total > MAX_FOLDERS_RECORDED).then_some(total as u64),
            )
        };
        (self.from, self.from_total) = {
            let (folders, total) = cut(from);
            (Some(folders), total)
        };
        (self.to, self.to_total) = {
            let (folders, total) = cut(to);
            (Some(folders), total)
        };
        self
    }

    pub fn canonical(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("a history entry always serializes")
    }

    pub fn hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(HASH_DOMAIN);
        hasher.update(Zeroizing::new(self.canonical()).as_slice());
        hex(&hasher.finalize())
    }
}

pub fn genesis(vault_id: Uuid) -> String {
    let mut hasher = Sha256::new();
    hasher.update(GENESIS_DOMAIN);
    hasher.update(vault_id.as_bytes());
    hex(&hasher.finalize())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Gives each new entry its place: the next sequence number, and the hash of
/// the entry before it. Returns the new head.
pub fn chain(entries: &mut [HistoryEntry], mut next_seq: u64, mut head: String) -> String {
    for entry in entries {
        entry.seq = next_seq;
        entry.prev = std::mem::take(&mut head);
        head = entry.hash();
        next_seq += 1;
    }
    head
}

/// Where a chain first goes wrong.
// The history stays on the device with no save step (Ben, 19 October), so
// only the tests check the chain with this and `verify`; VAULT_FORMAT.md
// states the same rules for checking a copy without the app.
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
pub enum ChainBreak {
    /// The entry at this position does not follow the one before it: its
    /// number or its `prev` is not what the chain says.
    At(u64),
    /// Every entry follows the one before, but the chain does not end where
    /// the manifest says: entries are missing at the end, or extra.
    End,
}

/// Checks that `entries` are the whole chain the manifest pins: from the
/// genesis value, each in turn, ending at `count` entries and `head`.
#[cfg_attr(not(test), allow(dead_code))]
pub fn verify(
    vault_id: Uuid,
    entries: &[HistoryEntry],
    count: u64,
    head: &str,
) -> Result<(), ChainBreak> {
    let mut expected = genesis(vault_id);
    for (index, entry) in entries.iter().enumerate() {
        let index = index as u64;
        if entry.seq != index || entry.prev != expected {
            return Err(ChainBreak::At(index));
        }
        expected = entry.hash();
    }
    if entries.len() as u64 != count || expected != head {
        return Err(ChainBreak::End);
    }
    Ok(())
}

/// One segment's plaintext: its entries, one per line, then spaces to
/// exactly `SEGMENT_PLAINTEXT_BYTES`. None if they do not fit. Built in a
/// buffer of that size, wiped when dropped, so that no copy of the names in
/// it is left behind.
pub fn pack(entries: &[HistoryEntry]) -> Option<Zeroizing<Vec<u8>>> {
    let mut plaintext = Zeroizing::new(Vec::with_capacity(SEGMENT_PLAINTEXT_BYTES));
    for entry in entries {
        let line = Zeroizing::new(entry.canonical());
        if plaintext.len() + line.len() + 1 > SEGMENT_PLAINTEXT_BYTES {
            return None;
        }
        plaintext.extend_from_slice(&line);
        plaintext.push(b'\n');
    }
    plaintext.resize(SEGMENT_PLAINTEXT_BYTES, b' ');
    Some(plaintext)
}

/// The entries in a segment's plaintext.
pub fn unpack(plaintext: &[u8]) -> Option<Vec<HistoryEntry>> {
    if plaintext.len() != SEGMENT_PLAINTEXT_BYTES {
        return None;
    }
    let text = std::str::from_utf8(plaintext).ok()?;
    let body = text.trim_end_matches(' ');
    if body.is_empty() {
        return Some(Vec::new());
    }
    body.strip_suffix('\n')?
        .split('\n')
        .map(|line| serde_json::from_str(line).ok())
        .collect()
}

/// Splits entries, in order, into segments that each fit, closing a segment
/// whenever the next entry would not fit. The caller passes the entries of
/// the last segment, which is rewritten, before the new ones.
pub fn into_segments(entries: Vec<HistoryEntry>) -> Vec<Vec<HistoryEntry>> {
    let mut segments: Vec<Vec<HistoryEntry>> = Vec::new();
    let mut used = 0;
    for entry in entries {
        let size = Zeroizing::new(entry.canonical()).len() + 1;
        match segments.last_mut() {
            Some(last) if used + size <= SEGMENT_PLAINTEXT_BYTES => last.push(entry),
            _ => {
                segments.push(vec![entry]);
                used = 0;
            }
        }
        used += size;
    }
    segments
}

/// How many segment objects a history of `data` segments keeps on disk: the
/// next power of two, so that the number of objects shows only about log₂ of
/// the history's length. The rest are filler segments, holding no entry.
pub fn padded_segment_count(data: usize) -> usize {
    if data == 0 {
        0
    } else {
        data.next_power_of_two()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(event: HistoryEvent, at_ms: u64) -> HistoryEntry {
        let mut entry = HistoryEntry::new(event, at_ms);
        entry.app = "0.1.0".to_owned();
        entry
    }

    #[test]
    fn the_chain_is_checked_from_the_genesis_value_to_the_pinned_head() {
        let vault = Uuid::from_u128(0x0123_4567_89ab_cdef_0123_4567_89ab_cdef);
        let mut entries = vec![
            entry(HistoryEvent::Created, 1),
            entry(HistoryEvent::Unlocked, 2),
            entry(HistoryEvent::Imported, 3),
        ];
        let head = chain(&mut entries, 0, genesis(vault));
        assert_eq!(verify(vault, &entries, 3, &head), Ok(()));

        // Changed, removed, reordered or cut off: each shows where.
        let mut changed = entries.clone();
        changed[1].at_ms = 99;
        assert_eq!(verify(vault, &changed, 3, &head), Err(ChainBreak::At(2)));
        let mut removed = entries.clone();
        removed.remove(1);
        assert_eq!(verify(vault, &removed, 3, &head), Err(ChainBreak::At(1)));
        let mut reordered = entries.clone();
        reordered.swap(1, 2);
        assert_eq!(verify(vault, &reordered, 3, &head), Err(ChainBreak::At(1)));
        assert_eq!(verify(vault, &entries[..2], 3, &head), Err(ChainBreak::End));
        // Another vault's genesis value does not start this chain.
        assert_eq!(
            verify(Uuid::nil(), &entries, 3, &head),
            Err(ChainBreak::At(0))
        );
    }

    #[test]
    fn a_long_place_is_cut_and_its_whole_is_kept_as_a_hash() {
        let long = "C:\\Users\\FAKE\\".to_owned() + &"x".repeat(400);
        let entry = entry(HistoryEvent::CopySaved, 1).with_place(&long);
        assert_eq!(
            entry.place.as_ref().unwrap().chars().count(),
            MAX_PLACE_CHARS
        );
        assert_eq!(
            entry.place_sha256.as_deref(),
            Some(hex(&Sha256::digest(long.as_bytes()))).as_deref()
        );
        let short = HistoryEntry::new(HistoryEvent::CopySaved, 1).with_place("/home/fake/copy.pdf");
        assert_eq!(short.place.as_deref(), Some("/home/fake/copy.pdf"));
        assert!(short.place_sha256.is_none());
    }

    #[test]
    fn segments_are_closed_by_size_and_padded_to_the_same_length() {
        let mut entries: Vec<HistoryEntry> = (0..400)
            .map(|at| {
                let mut entry = entry(HistoryEvent::Renamed, at);
                entry.name = Some("n".repeat(240));
                entry.old_name = Some("o".repeat(240));
                entry
            })
            .collect();
        chain(&mut entries, 0, genesis(Uuid::nil()));
        let segments = into_segments(entries.clone());
        assert!(segments.len() > 1);
        let mut back = Vec::new();
        for segment in &segments {
            let plaintext = pack(segment).unwrap();
            assert_eq!(plaintext.len(), SEGMENT_PLAINTEXT_BYTES);
            back.extend(unpack(&plaintext).unwrap());
        }
        assert_eq!(back, entries);
        assert_eq!(unpack(&pack(&[]).unwrap()).unwrap(), Vec::new());
    }

    #[test]
    fn the_largest_entry_the_app_can_make_fits_in_one_segment() {
        // Every string at its longest, in four-byte characters, and a
        // control character in the place, which JSON writes as six bytes.
        let wide = |chars: usize| "𝄞".repeat(chars);
        let folders = |count: usize| {
            (0..count)
                .map(|index| FolderAtTheTime {
                    id: Uuid::from_u128(index as u128),
                    name: wide(120),
                })
                .collect::<Vec<_>>()
        };
        let mut entry = entry(HistoryEvent::Moved, u64::MAX)
            .with_move(folders(1_000), folders(1_000))
            .with_place(&"\u{1}".repeat(300));
        entry.seq = u64::MAX;
        entry.record_id = Some(Uuid::nil());
        entry.name = Some(wide(240));
        entry.old_name = Some(wide(240));
        entry.how = Some("recoveryKey".to_owned());
        entry.previous_session = Some(format!("lockedAt:{}:nativeDeadline", u64::MAX));
        entry.prev = "f".repeat(64);
        assert_eq!(entry.from.as_ref().unwrap().len(), MAX_FOLDERS_RECORDED);
        assert_eq!(
            (entry.from_total, entry.to_total),
            (Some(1_000), Some(1_000))
        );
        assert!(entry.canonical().len() < SEGMENT_PLAINTEXT_BYTES);
        assert!(pack(&[entry]).is_some());
    }

    #[test]
    fn a_move_within_the_cap_names_every_folder_and_no_total() {
        let one = vec![FolderAtTheTime {
            id: Uuid::nil(),
            name: "Heart".to_owned(),
        }];
        let entry = entry(HistoryEvent::Moved, 1).with_move(Vec::new(), one.clone());
        assert_eq!((entry.from, entry.to), (Some(Vec::new()), Some(one)));
        assert_eq!((entry.from_total, entry.to_total), (None, None));
        assert!(into_segments(Vec::new()).is_empty());
    }

    #[test]
    fn segment_objects_come_in_powers_of_two() {
        let counts: Vec<usize> = (0..10).map(padded_segment_count).collect();
        assert_eq!(counts, [0, 1, 2, 4, 4, 8, 8, 8, 8, 16]);
    }
}
