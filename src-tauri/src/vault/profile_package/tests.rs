//! Tests of the profile handover package. FAKE data only: every name, label
//! and byte below is invented, and none is logged.

use super::*;
use std::io::Cursor;

const MARKER: &[u8] = b"FAKE-PLAINTEXT-MARKER-7f3a";
const PASSPHRASE: &str = "tiger-lamp-orbit-quartz-mellow-7391";

fn open() -> bool {
    true
}

/// Deterministic bytes that contain the marker, so that a scan of the file can
/// tell whether any plaintext reached it.
fn content(seed: u8, size: usize) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(size);
    let mut state = u32::from(seed).wrapping_mul(2_654_435_761).wrapping_add(1);
    while bytes.len() < size {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        bytes.push((state >> 24) as u8);
    }
    if size >= MARKER.len() {
        bytes[..MARKER.len()].copy_from_slice(MARKER);
    }
    bytes
}

fn object(size: usize) -> PackageObject {
    PackageObject {
        id: Uuid::new_v4(),
        size: size as u64,
    }
}

struct Fixture {
    manifest: PackageManifest,
    data: HashMap<Uuid, Vec<u8>>,
}

fn record(name: &str, folder: Option<Uuid>, display: PackageObject) -> PackageRecord {
    PackageRecord {
        id: Uuid::new_v4(),
        name: name.to_owned(),
        source_label: "Manual import — unverified".to_owned(),
        media_type: "application/octet-stream".to_owned(),
        imported_at_ms: 1_700_000_000_000,
        folder_ids: folder.into_iter().collect(),
        hidden_at_ms: None,
        display,
        original_pdf: None,
        ai_answers: Vec::new(),
        carried: None,
    }
}

/// A person with two folders (one inside the other) and records of the sizes
/// that matter to a chunked format.
fn fixture(sizes: &[usize]) -> Fixture {
    let outer = Uuid::new_v4();
    let inner = Uuid::new_v4();
    let mut data = HashMap::new();
    let mut records = Vec::new();
    for (index, size) in sizes.iter().enumerate() {
        let display = object(*size);
        data.insert(display.id, content(index as u8, *size));
        let folder = [None, Some(outer), Some(inner)][index % 3];
        records.push(record(&format!("FAKE Letter {index}.pdf"), folder, display));
    }
    // The first record also has a second copy and an AI answer.
    if let Some(first) = records.first_mut() {
        let original = object(300);
        let answer = object(40);
        data.insert(original.id, content(200, 300));
        data.insert(answer.id, content(201, 40));
        first.original_pdf = Some(original);
        first.ai_answers.push(PackageAiAnswer {
            object: answer,
            tool: "summary".to_owned(),
            lang: "en".to_owned(),
            term: None,
            model_name: "FAKE model".to_owned(),
            model_sha256: "00".repeat(32),
            created_at_ms: 1_700_000_100_000,
            superseded: false,
        });
        first.hidden_at_ms = Some(1_700_000_200_000);
    }
    Fixture {
        manifest: PackageManifest {
            format: PACKAGE_FORMAT,
            exported_at_ms: 1_700_000_300_000,
            profile: PackageProfile {
                display_name: "FAKE Child".to_owned(),
                full_name: Some("FAKE Child Example".to_owned()),
                birth_date: Some("2015-04-09".to_owned()),
                previous_full_names: vec!["FAKE Earlier Name".to_owned()],
                created_at_ms: 1_690_000_000_000,
            },
            folders: vec![
                PackageFolder {
                    id: outer,
                    parent_id: None,
                    name: "FAKE Letters".to_owned(),
                    created_at_ms: 1,
                },
                PackageFolder {
                    id: inner,
                    parent_id: Some(outer),
                    name: "FAKE Results".to_owned(),
                    created_at_ms: 2,
                },
            ],
            records,
            history: Some(vec![serde_json::json!({"event": "imported", "n": 1})]),
        },
        data,
    }
}

fn write_with(fixture: &Fixture, secret: PackageSecret<'_>) -> Result<Vec<u8>, PackageError> {
    let mut writer = PackageWriter::create(Vec::new(), secret, &["FAKE", "Child"])?;
    writer.write_manifest(&fixture.manifest)?;
    while let Some(next) = writer.next_object() {
        let mut source = Cursor::new(fixture.data[&next.id].clone());
        writer.write_object(next.id, &mut source, &open)?;
    }
    writer.finish()
}

fn key() -> Zeroizing<[u8; RECOVERY_KEY_BYTES]> {
    generate_package_key().0
}

fn write_package(fixture: &Fixture, key: &[u8; RECOVERY_KEY_BYTES]) -> Vec<u8> {
    write_with(fixture, PackageSecret::Key(key)).unwrap()
}

/// Everything a reader returns.
struct ReadBack {
    manifest: PackageManifest,
    objects: HashMap<Uuid, Vec<u8>>,
    reads: Vec<ObjectRead>,
}

fn read_all(bytes: &[u8], secret: PackageSecret<'_>) -> Result<ReadBack, PackageError> {
    let mut reader = PackageReader::open(Cursor::new(bytes), secret)?;
    let manifest = reader.manifest().clone();
    let mut objects = HashMap::new();
    while let Some(next) = reader.next_object() {
        let mut sink = Vec::new();
        reader.read_object(&mut sink, &open)?;
        objects.insert(next.id, sink);
    }
    let reads = reader.finish()?;
    Ok(ReadBack {
        manifest,
        objects,
        reads,
    })
}

/// Where each entry sits in the file: kind, name, and the byte range of the
/// whole entry (header and data).
fn spans(bytes: &[u8]) -> Vec<(u8, String, usize, usize)> {
    let header_length = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as usize;
    let mut at = 20 + header_length;
    let mut found = Vec::new();
    while bytes[at] != KIND_TRAILER {
        let start = at;
        let kind = bytes[at];
        let name_length = u16::from_be_bytes([bytes[at + 1], bytes[at + 2]]) as usize;
        let name = String::from_utf8(bytes[at + 3..at + 3 + name_length].to_vec()).unwrap();
        at += 3 + name_length;
        let length = u64::from_be_bytes(bytes[at..at + 8].try_into().unwrap()) as usize;
        at += 8 + length;
        found.push((kind, name, start, at));
    }
    found
}

#[test]
fn a_package_round_trips_with_a_generated_key() {
    let sizes = [
        0,
        1,
        10,
        CHUNK_SIZE - 1,
        CHUNK_SIZE,
        CHUNK_SIZE + 1,
        2 * CHUNK_SIZE + 5,
    ];
    let fixture = fixture(&sizes);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let read = read_all(&bytes, PackageSecret::Key(&key)).unwrap();
    assert_eq!(read.manifest, fixture.manifest);
    assert_eq!(read.objects, fixture.data);
    // The digests the reader hands back are each object's plaintext SHA-256.
    for item in &read.reads {
        assert_eq!(
            item.sha256.as_slice(),
            Sha256::digest(&fixture.data[&item.id]).as_slice()
        );
        assert_eq!(item.size, fixture.data[&item.id].len() as u64);
    }
    assert_eq!(read.reads.len(), fixture.manifest.objects().len());
}

#[test]
fn a_package_round_trips_with_a_passphrase() {
    let fixture = fixture(&[0, 77, 70_000]);
    let bytes = write_with(&fixture, PackageSecret::Passphrase(PASSPHRASE)).unwrap();
    let read = read_all(&bytes, PackageSecret::Passphrase(PASSPHRASE)).unwrap();
    assert_eq!(read.manifest, fixture.manifest);
    assert_eq!(read.objects, fixture.data);
    // Typed the way a keyboard may make it: the same visible text.
    assert!(read_all(
        &bytes,
        PackageSecret::Passphrase("tiger-lamp-orbit-quartz-mellow-7392")
    )
    .is_err());
}

#[test]
fn a_typed_passphrase_must_meet_the_vaults_rules_for_a_new_one() {
    let fixture = fixture(&[1]);
    for weak in [
        "short",
        "aaaaaaaaaaaaaaaaaaaa",
        "password12345678",
        // A word of the person's own name, though long and odd otherwise.
        "x-FAKE-orbit-quartz-mellow-7391-q",
    ] {
        assert!(
            matches!(
                write_with(&fixture, PackageSecret::Passphrase(weak)),
                Err(PackageError::WeakPassphrase | PackageError::Invalid)
            ),
            "{weak}"
        );
    }
}

#[test]
fn a_wrong_key_is_refused_before_anything_is_read() {
    let fixture = fixture(&[10]);
    let key = key();
    let other = self::key();
    let bytes = write_package(&fixture, &key);
    assert!(matches!(
        PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&other)),
        Err(PackageError::WrongKey)
    ));
    // A passphrase for a package that was made with a key, and the reverse.
    assert!(matches!(
        PackageReader::open(Cursor::new(&bytes), PackageSecret::Passphrase(PASSPHRASE)),
        Err(PackageError::WrongKey)
    ));
    let typed = write_with(&fixture, PackageSecret::Passphrase(PASSPHRASE)).unwrap();
    assert!(matches!(
        PackageReader::open(Cursor::new(&typed), PackageSecret::Key(&key)),
        Err(PackageError::WrongKey)
    ));
    assert!(matches!(
        PackageReader::open(
            Cursor::new(&typed),
            PackageSecret::Passphrase("a-different-passphrase-entirely-1")
        ),
        Err(PackageError::WrongKey)
    ));
}

#[test]
fn the_generated_key_is_shown_as_seven_groups_and_reads_back_as_typed() {
    let (key, text) = generate_package_key();
    assert_eq!(text.split('-').count(), 7);
    assert!(text.split('-').all(|group| group.len() == 4));
    // Lower case, spaces for dashes and the letters Crockford folds together.
    let typed = text.to_lowercase().replace('-', " ").replace('0', "o");
    assert_eq!(*parse_package_key(&typed).unwrap(), *key);
    // A one-character slip is caught as a typo, before any unwrapping.
    let mut slipped: Vec<char> = text.chars().collect();
    slipped[0] = if slipped[0] == '2' { '3' } else { '2' };
    assert_eq!(
        parse_package_key(&slipped.into_iter().collect::<String>()).err(),
        Some(PackageError::KeyTypo)
    );
}

#[test]
fn inspecting_reads_the_header_and_the_manifest_and_nothing_else() {
    let fixture = fixture(&[CHUNK_SIZE, 100]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let first_object = spans(&bytes)
        .into_iter()
        .find(|(kind, ..)| *kind == KIND_OBJECT)
        .unwrap();
    // Cut off right after the manifest: opening still works.
    let reader = PackageReader::open(
        Cursor::new(&bytes[..first_object.2]),
        PackageSecret::Key(&key),
    )
    .unwrap();
    assert_eq!(reader.manifest(), &fixture.manifest);
    assert_eq!(
        reader.next_object(),
        Some(fixture.manifest.records[0].display)
    );
}

#[test]
fn two_exports_of_the_same_person_differ_everywhere() {
    let key = key();
    // Exported twice, each export makes its own ids for what it holds.
    let a = write_package(&fixture(&[100, 70_000]), &key);
    let b = write_package(&fixture(&[100, 70_000]), &key);
    assert_eq!(a.len(), b.len());
    // Not one 48-byte window of one is in the other, past the magic.
    let windows: HashSet<&[u8]> = a[16..].windows(48).step_by(48).collect();
    assert!(!b[16..].windows(48).any(|window| windows.contains(window)));

    // Even the very same manifest and data, written twice with the same key,
    // gives different ciphertext for every entry: a new package id, a new
    // wrapped key and new nonces.
    let same = fixture(&[100, 70_000]);
    let first = write_package(&same, &key);
    let second = write_package(&same, &key);
    let (first_spans, second_spans) = (spans(&first), spans(&second));
    assert_eq!(first_spans.len(), second_spans.len());
    for (one, two) in first_spans.iter().zip(&second_spans) {
        let data = |bytes: &'_ [u8], span: &(u8, String, usize, usize)| {
            bytes[span.2 + 3 + span.1.len() + 8..span.3].to_vec()
        };
        assert_ne!(data(&first, one), data(&second, two), "{}", one.1);
    }
}

#[test]
fn the_file_holds_no_name_no_plaintext_and_no_clinic_or_vault_word() {
    let mut fixture = fixture(&[2_000, 90_000]);
    fixture.manifest.records[0].carried = Some(serde_json::json!({"clinic": "FAKE Clinic"}));
    let key = key();
    let bytes = write_package(&fixture, &key);
    let mut forbidden: Vec<&[u8]> = vec![MARKER, b"FAKE"];
    forbidden.extend([
        b"Letter".as_slice(),
        b"Child",
        b"Results",
        b"2015-04-09",
        b"application/octet-stream",
        b"Manual import",
        b"vault",
        b"clinic",
        b"profileId",
        b"displayName",
        b"summary",
    ]);
    for needle in forbidden {
        assert!(
            !bytes.windows(needle.len()).any(|window| window == needle),
            "{}",
            String::from_utf8_lossy(needle)
        );
    }
    // What is in the clear is the package's own id, never a record's or a folder's.
    for record in &fixture.manifest.records {
        let id = record.id.as_bytes();
        assert!(!bytes.windows(16).any(|window| window == id));
        assert!(!bytes
            .windows(32)
            .any(|window| window == record.id.simple().to_string().as_bytes()));
    }
}

#[test]
fn an_object_entry_is_a_vault_object_under_the_package_id() {
    // The chunk format is the vault's own, so the vault's reader opens an
    // entry, with the package id where a vault id would be.
    let fixture = fixture(&[2 * CHUNK_SIZE + 17]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    let object = fixture.manifest.records[0].display;
    let span = spans(&bytes)
        .into_iter()
        .find(|(kind, name, ..)| *kind == KIND_OBJECT && *name == object_name(object.id))
        .unwrap();
    let data_start = span.2 + 3 + span.1.len() + 8;
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("entry.mcobj");
    std::fs::write(&path, &bytes[data_start..span.3]).unwrap();
    let object_key = object_key(&reader.keys, object.id).unwrap();
    let mut out = Vec::new();
    super::super::verify_object(
        &path,
        &mut out,
        reader.package_id(),
        object.id,
        &object_key,
        object.size,
    )
    .unwrap();
    assert_eq!(out, fixture.data[&object.id]);
    // Under another id it does not open: the id is bound into every chunk.
    assert!(super::super::verify_object(
        &path,
        &mut Vec::new(),
        Uuid::new_v4(),
        object.id,
        &object_key,
        object.size,
    )
    .is_err());
}

#[test]
fn the_stored_length_of_an_object_is_the_one_computed_from_its_size() {
    let sizes = [
        0,
        1,
        CHUNK_SIZE - 1,
        CHUNK_SIZE,
        CHUNK_SIZE + 1,
        2 * CHUNK_SIZE,
    ];
    let fixture = fixture(&sizes);
    let key = key();
    let bytes = write_package(&fixture, &key);
    for record in &fixture.manifest.records {
        let object = record.display;
        let span = spans(&bytes)
            .into_iter()
            .find(|(kind, name, ..)| *kind == KIND_OBJECT && *name == object_name(object.id))
            .unwrap();
        let stored = span.3 - span.2 - (3 + span.1.len() + 8);
        assert_eq!(Some(stored as u64), encrypted_object_len(object.size));
    }
}

#[test]
fn manifests_of_different_lengths_in_one_size_class_look_alike() {
    let key = key();
    let small = fixture(&[1]);
    let mut larger = fixture(&[1, 2, 3, 4, 5]);
    larger.manifest.profile.display_name = "FAKE Child with a longer name than the other".into();
    let length = |fixture: &Fixture| {
        let bytes = write_package(fixture, &key);
        spans(&bytes)
            .into_iter()
            .find(|(kind, ..)| *kind == KIND_MANIFEST)
            .map(|(_, _, start, end)| end - start)
            .unwrap()
    };
    assert_eq!(length(&small), length(&larger));
    assert_eq!(
        length(&small),
        3 + NAME_MANIFEST.len() + 8 + 24 + MIN_MANIFEST_CLASS + 16
    );
}

// --- Hostile files ---------------------------------------------------------

fn small_package() -> (Fixture, Zeroizing<[u8; RECOVERY_KEY_BYTES]>, Vec<u8>) {
    let fixture = fixture(&[0, 100, 70_000]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    (fixture, key, bytes)
}

fn refused(bytes: &[u8], key: &[u8; RECOVERY_KEY_BYTES]) -> bool {
    read_all(bytes, PackageSecret::Key(key)).is_err()
}

#[test]
fn a_flipped_bit_anywhere_is_refused() {
    let (_, key, bytes) = small_package();
    assert!(!refused(&bytes, &key));
    let mut positions: Vec<usize> = (0..400).collect();
    positions.extend((400..bytes.len()).step_by(997));
    positions.extend(bytes.len() - 300..bytes.len());
    for position in positions {
        let mut damaged = bytes.clone();
        damaged[position] ^= 0x01;
        assert!(refused(&damaged, &key), "a flip at {position} was accepted");
    }
}

#[test]
fn a_package_cut_short_anywhere_is_refused() {
    let (_, key, bytes) = small_package();
    let mut lengths: Vec<usize> = (0..300).collect();
    lengths.extend((300..bytes.len()).step_by(1_999));
    lengths.extend(bytes.len() - 150..bytes.len());
    for length in lengths {
        assert!(
            refused(&bytes[..length], &key),
            "cut at {length} was accepted"
        );
    }
}

#[test]
fn bytes_after_the_trailer_are_refused() {
    let (_, key, mut bytes) = small_package();
    bytes.push(0);
    assert!(refused(&bytes, &key));
}

#[test]
fn entries_swapped_repeated_or_missing_are_refused() {
    let fixture = fixture(&[50, 50, 50]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let all = spans(&bytes);
    let objects: Vec<_> = all
        .iter()
        .filter(|(kind, ..)| *kind == KIND_OBJECT)
        .collect();
    let (a, b) = (objects[0], objects[1]);
    let slice = |span: &(u8, String, usize, usize)| bytes[span.2..span.3].to_vec();

    // Swapped.
    let mut swapped = bytes[..a.2].to_vec();
    swapped.extend(slice(b));
    swapped.extend(slice(a));
    swapped.extend(&bytes[b.3..]);
    assert!(refused(&swapped, &key));
    // The second replaced by a copy of the first.
    let mut repeated = bytes[..b.2].to_vec();
    repeated.extend(slice(a));
    repeated.extend(&bytes[b.3..]);
    assert!(refused(&repeated, &key));
    // One missing.
    let mut missing = bytes[..a.2].to_vec();
    missing.extend(&bytes[a.3..]);
    assert!(refused(&missing, &key));
    // The manifest twice.
    let manifest = all
        .iter()
        .find(|(kind, ..)| *kind == KIND_MANIFEST)
        .unwrap();
    let mut doubled = bytes[..manifest.3].to_vec();
    doubled.extend(slice(manifest));
    doubled.extend(&bytes[manifest.3..]);
    assert!(refused(&doubled, &key));
}

/// A package whose trailer was changed and re-signed with the real tag key:
/// what a forger who held the key could make, and the reader must still
/// compare the trailer with what it read.
fn resigned(
    bytes: &[u8],
    key: &[u8; RECOVERY_KEY_BYTES],
    edit: impl FnOnce(&mut Trailer),
) -> Vec<u8> {
    let reader = PackageReader::open(Cursor::new(bytes), PackageSecret::Key(key)).unwrap();
    let header_length = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as usize;
    let header = &bytes[20..20 + header_length];
    let all = spans(bytes);
    let trailer_start = all.last().unwrap().3;
    let trailer_length = u32::from_be_bytes(
        bytes[trailer_start + 1..trailer_start + 5]
            .try_into()
            .unwrap(),
    ) as usize;
    let mut trailer: Trailer =
        serde_json::from_slice(&bytes[trailer_start + 5..trailer_start + 5 + trailer_length])
            .unwrap();
    edit(&mut trailer);
    let json = serde_json::to_vec(&trailer).unwrap();
    let tag = tag_mac(&reader.keys.tag, header, &json)
        .unwrap()
        .finalize()
        .into_bytes();
    let mut out = bytes[..trailer_start].to_vec();
    out.push(KIND_TRAILER);
    out.extend((json.len() as u32).to_be_bytes());
    out.extend(&json);
    out.extend(tag);
    out
}

#[test]
fn a_trailer_that_lists_what_the_file_does_not_hold_is_refused_even_when_signed() {
    let (_, key, bytes) = small_package();
    // Unchanged and re-signed: accepted (the helper itself is sound).
    assert!(!refused(&resigned(&bytes, &key, |_| {}), &key));
    assert!(refused(
        &resigned(&bytes, &key, |trailer| {
            let extra = trailer.entries[1].clone();
            trailer.entries.push(extra);
        }),
        &key
    ));
    assert!(refused(
        &resigned(&bytes, &key, |trailer| {
            trailer.entries.remove(1);
        }),
        &key
    ));
    assert!(refused(
        &resigned(&bytes, &key, |trailer| trailer.entries[2].sha256 =
            "AAAA".into()),
        &key
    ));
    assert!(refused(
        &resigned(&bytes, &key, |trailer| trailer.package_id = Uuid::new_v4()),
        &key
    ));
    assert!(refused(
        &resigned(&bytes, &key, |trailer| trailer.format = 2),
        &key
    ));
}

#[test]
fn a_newer_package_format_and_a_file_that_is_not_a_package_are_told_apart() {
    let (_, key, bytes) = small_package();
    let header_length = u32::from_be_bytes(bytes[16..20].try_into().unwrap()) as usize;
    let mut newer = bytes.clone();
    let header = String::from_utf8(bytes[20..20 + header_length].to_vec()).unwrap();
    let edited = header.replace("\"format\":1", "\"format\":2");
    assert_eq!(edited.len(), header.len());
    newer[20..20 + header_length].copy_from_slice(edited.as_bytes());
    assert!(matches!(
        PackageReader::open(Cursor::new(&newer), PackageSecret::Key(&key)),
        Err(PackageError::NewerFormat)
    ));
    for notes in [
        Vec::new(),
        b"MYCARLOS-BACKUP\n".to_vec(),
        vec![0_u8; 5_000],
        b"MYCARLOS-PROFILE".to_vec(),
    ] {
        assert!(matches!(
            PackageReader::open(Cursor::new(&notes), PackageSecret::Key(&key)),
            Err(PackageError::Unreadable)
        ));
    }
}

#[test]
fn a_declared_length_past_the_limit_is_refused_without_allocating_it() {
    let (_, key, bytes) = small_package();
    let manifest = spans(&bytes)
        .into_iter()
        .find(|(kind, ..)| *kind == KIND_MANIFEST)
        .unwrap();
    let length_at = manifest.2 + 3 + NAME_MANIFEST.len();
    let mut huge = bytes[..manifest.3].to_vec();
    huge[length_at..length_at + 8].copy_from_slice(&(1_u64 << 50).to_be_bytes());
    assert!(matches!(
        PackageReader::open(Cursor::new(&huge), PackageSecret::Key(&key)),
        Err(PackageError::Unreadable)
    ));
}

// --- Manifest rules ----------------------------------------------------------

fn invalid(change: impl FnOnce(&mut PackageManifest)) -> PackageError {
    let mut manifest = fixture(&[1, 2, 3]).manifest;
    change(&mut manifest);
    manifest.validate().unwrap_err()
}

#[test]
fn a_manifest_that_breaks_a_rule_is_refused() {
    assert!(fixture(&[1, 2, 3]).manifest.validate().is_ok());
    let existing = Uuid::new_v4();
    assert_eq!(
        invalid(|m| m.folders[1].id = m.folders[0].id),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.folders[1].parent_id = Some(existing)),
        PackageError::Invalid,
        "a parent that is not there"
    );
    assert_eq!(
        invalid(|m| {
            let (a, b) = (m.folders[0].id, m.folders[1].id);
            m.folders[0].parent_id = Some(b);
            m.folders[1].parent_id = Some(a);
        }),
        PackageError::Invalid,
        "two folders each inside the other"
    );
    assert_eq!(
        invalid(|m| m.folders[0].parent_id = Some(m.folders[0].id)),
        PackageError::Invalid,
        "a folder inside itself"
    );
    assert_eq!(
        invalid(|m| m.records[0].folder_ids = vec![existing]),
        PackageError::Invalid,
        "a record in a folder that is not there"
    );
    assert_eq!(
        invalid(|m| {
            let id = m.folders[0].id;
            m.records[0].folder_ids = vec![id, id];
        }),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[1].id = m.records[0].id),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[1].display.id = m.records[0].display.id),
        PackageError::Invalid,
        "one object used twice"
    );
    assert_eq!(
        invalid(|m| m.records[0].name = "a/b".into()),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[0].name = "a\\b".into()),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[0].name = "line\nbreak".into()),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[0].name = "  ".into()),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[0].name = "x".repeat(300)),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.profile.display_name = String::new()),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.profile.birth_date = Some("2015-13-40".into())),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.profile.previous_full_names = vec!["n".into(); MAX_PREVIOUS_NAMES + 1]),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[0].media_type = "text\u{0}plain".into()),
        PackageError::Invalid
    );
    assert_eq!(
        invalid(|m| m.records[0].display.size = MAX_OBJECT_BYTES + 1),
        PackageError::TooLarge
    );
    assert_eq!(invalid(|m| m.format = 2), PackageError::NewerFormat);
    assert_eq!(invalid(|m| m.format = 0), PackageError::Unreadable);
    assert_eq!(
        invalid(|m| m.records[0].carried = Some(serde_json::json!("x".repeat(MAX_CARRIED_BYTES)))),
        PackageError::TooLarge
    );
}

#[test]
fn counts_past_the_limits_are_refused() {
    assert_eq!(
        invalid(|m| {
            let template = m.records[0].clone();
            m.records = (0..=MAX_PACKAGE_RECORDS)
                .map(|_| PackageRecord {
                    id: Uuid::new_v4(),
                    display: object(0),
                    ..template.clone()
                })
                .collect();
        }),
        PackageError::TooLarge
    );
    assert_eq!(
        invalid(|m| {
            m.folders = (0..=MAX_PACKAGE_FOLDERS)
                .map(|n| PackageFolder {
                    id: Uuid::new_v4(),
                    parent_id: None,
                    name: format!("FAKE {n}"),
                    created_at_ms: 0,
                })
                .collect();
            m.records.clear();
        }),
        PackageError::TooLarge
    );
    assert_eq!(
        invalid(|m| m.history = Some(vec![serde_json::Value::Null; MAX_HISTORY_ENTRIES + 1])),
        PackageError::TooLarge
    );
}

#[test]
fn folders_nested_too_deep_are_refused_and_the_deepest_allowed_is_not() {
    let chain = |depth: usize| -> PackageManifest {
        let mut manifest = fixture(&[1]).manifest;
        manifest.records[0].folder_ids.clear();
        manifest.folders = Vec::new();
        let mut parent = None;
        for n in 0..depth {
            let id = Uuid::new_v4();
            manifest.folders.push(PackageFolder {
                id,
                parent_id: parent,
                name: format!("FAKE {n}"),
                created_at_ms: 0,
            });
            parent = Some(id);
        }
        manifest
    };
    assert!(chain(MAX_FOLDER_DEPTH).validate().is_ok());
    assert_eq!(
        chain(MAX_FOLDER_DEPTH + 1).validate(),
        Err(PackageError::Invalid)
    );
}

#[test]
fn the_writer_refuses_a_manifest_that_breaks_a_rule_before_writing_it() {
    let mut fixture = fixture(&[1]);
    fixture.manifest.folders[1].parent_id = Some(Uuid::new_v4());
    let key = key();
    let mut writer = PackageWriter::create(Vec::new(), PackageSecret::Key(&key), &[]).unwrap();
    assert_eq!(
        writer.write_manifest(&fixture.manifest),
        Err(PackageError::Invalid)
    );
}

// --- The writer's own rules ----------------------------------------------------

fn started(fixture: &Fixture, key: &[u8; RECOVERY_KEY_BYTES]) -> PackageWriter<Vec<u8>> {
    let mut writer = PackageWriter::create(Vec::new(), PackageSecret::Key(key), &[]).unwrap();
    writer.write_manifest(&fixture.manifest).unwrap();
    writer
}

#[test]
fn a_source_of_the_wrong_size_or_the_wrong_object_is_refused() {
    let fixture = fixture(&[100, 200]);
    let key = key();
    let first = fixture.manifest.records[0].display;

    let mut short = started(&fixture, &key);
    assert_eq!(
        short.write_object(first.id, &mut Cursor::new(vec![0_u8; 99]), &open),
        Err(PackageError::Invalid)
    );
    let mut long = started(&fixture, &key);
    assert_eq!(
        long.write_object(first.id, &mut Cursor::new(vec![0_u8; 101]), &open),
        Err(PackageError::Invalid)
    );
    let mut wrong = started(&fixture, &key);
    assert_eq!(
        wrong.write_object(Uuid::new_v4(), &mut Cursor::new(vec![0_u8; 100]), &open),
        Err(PackageError::Invalid)
    );
    // The second before the first.
    let second = fixture.manifest.records[1].display;
    let mut order = started(&fixture, &key);
    assert_eq!(
        order.write_object(second.id, &mut Cursor::new(vec![0_u8; 200]), &open),
        Err(PackageError::Invalid)
    );
}

#[test]
fn a_package_cannot_be_finished_before_every_object_is_written() {
    let fixture = fixture(&[100]);
    let key = key();
    let writer = started(&fixture, &key);
    assert!(writer.next_object().is_some());
    assert!(matches!(writer.finish(), Err(PackageError::Invalid)));
    // Nor the manifest written twice, nor an object before it.
    let mut twice = started(&fixture, &key);
    assert_eq!(
        twice.write_manifest(&fixture.manifest),
        Err(PackageError::Invalid)
    );
    let mut none = PackageWriter::create(Vec::new(), PackageSecret::Key(&key), &[]).unwrap();
    assert_eq!(
        none.write_object(Uuid::new_v4(), &mut Cursor::new(Vec::new()), &open),
        Err(PackageError::Invalid)
    );
}

#[test]
fn a_lock_or_a_cancel_stops_the_write_and_the_read_between_chunks() {
    let fixture = fixture(&[3 * CHUNK_SIZE]);
    let key = key();
    let first = fixture.manifest.records[0].display;

    let mut writer = started(&fixture, &key);
    let mut source = Cursor::new(fixture.data[&first.id].clone());
    assert_eq!(
        writer.write_object(first.id, &mut source, &|| false),
        Err(PackageError::Cancelled)
    );

    let bytes = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    assert_eq!(
        reader.read_object(&mut Vec::new(), &|| false),
        Err(PackageError::Cancelled)
    );
}

#[test]
fn a_reader_refuses_to_finish_before_every_object_is_read() {
    let (_, key, bytes) = small_package();
    let reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    assert!(matches!(reader.finish(), Err(PackageError::Invalid)));
}

#[test]
fn an_object_streamed_through_a_failing_sink_reports_the_failure() {
    struct Full;
    impl Write for Full {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::StorageFull, "no room"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let (_, key, bytes) = small_package();
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    // The first object is empty, so it writes nothing; the second does.
    reader.read_object(&mut Full, &open).unwrap();
    assert_eq!(
        reader.read_object(&mut Full, &open),
        Err(PackageError::Storage)
    );
}

#[test]
fn the_package_id_and_the_key_wrap_are_new_for_every_export() {
    let fixture = fixture(&[1]);
    let key = key();
    let a = write_package(&fixture, &key);
    let b = write_package(&fixture, &key);
    let id = |bytes: &[u8]| {
        let reader = PackageReader::open(Cursor::new(bytes), PackageSecret::Key(&key)).unwrap();
        reader.package_id()
    };
    assert_ne!(id(&a), id(&b));
    // The writer reports the id it put in the header.
    let mut writer = PackageWriter::create(Vec::new(), PackageSecret::Key(&key), &[]).unwrap();
    writer.write_manifest(&fixture.manifest).unwrap();
    let written = writer.package_id();
    while let Some(next) = writer.next_object() {
        let mut source = Cursor::new(fixture.data[&next.id].clone());
        writer.write_object(next.id, &mut source, &open).unwrap();
    }
    assert_eq!(id(&writer.finish().unwrap()), written);
    // And the keys under it: the same object's key differs per package.
    let keys = |bytes: &[u8]| {
        let reader = PackageReader::open(Cursor::new(bytes), PackageSecret::Key(&key)).unwrap();
        let id = fixture.manifest.records[0].display.id;
        object_key(&reader.keys, id).unwrap()
    };
    assert_ne!(*keys(&a), *keys(&b));
}
