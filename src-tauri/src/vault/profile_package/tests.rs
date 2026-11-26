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

/// Everything a reader returns. The package carries ids of its own, so `objects` is in
/// the manifest's order and a manifest is compared with `renumber`.
struct ReadBack {
    manifest: PackageManifest,
    objects: Vec<Vec<u8>>,
    reads: Vec<ObjectRead>,
}

/// The same manifest with its ids replaced by numbers in order of appearance, so that a
/// manifest as written and as read (which has the package's ids) compare by shape.
fn renumber(manifest: &PackageManifest) -> PackageManifest {
    let mut next = 0_u128;
    let mut fresh = || {
        next += 1;
        Uuid::from_u128(next)
    };
    let folders: HashMap<Uuid, Uuid> = manifest.folders.iter().map(|f| (f.id, fresh())).collect();
    let mut numbered = manifest.clone();
    for folder in &mut numbered.folders {
        folder.id = folders[&folder.id];
        folder.parent_id = folder.parent_id.map(|parent| folders[&parent]);
    }
    for record in &mut numbered.records {
        record.id = fresh();
        record.display.id = fresh();
        if let Some(original) = &mut record.original_pdf {
            original.id = fresh();
        }
        for answer in &mut record.ai_answers {
            answer.object.id = fresh();
        }
        for id in &mut record.folder_ids {
            *id = folders[id];
        }
    }
    numbered
}

/// The fixture's object contents in the manifest's order.
fn fixture_objects(fixture: &Fixture) -> Vec<Vec<u8>> {
    fixture
        .manifest
        .objects()
        .iter()
        .map(|object| fixture.data[&object.id].clone())
        .collect()
}

fn read_all(bytes: &[u8], secret: PackageSecret<'_>) -> Result<ReadBack, PackageError> {
    let mut reader = PackageReader::open(Cursor::new(bytes), secret)?;
    let manifest = reader.manifest().clone();
    let mut objects = Vec::new();
    while reader.next_object().is_some() {
        let mut sink = Vec::new();
        reader.read_object(&mut sink, &open)?;
        objects.push(sink);
    }
    let package_id = reader.package_id();
    let verified = reader.finish()?;
    assert_eq!(verified.package_id(), package_id);
    assert_eq!(verified.manifest(), &manifest);
    Ok(ReadBack {
        manifest,
        objects,
        reads: verified.objects().to_vec(),
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
    assert_eq!(renumber(&read.manifest), renumber(&fixture.manifest));
    assert_eq!(read.objects, fixture_objects(&fixture));
    // The digests the reader hands back are each object's plaintext SHA-256.
    for (item, data) in read.reads.iter().zip(fixture_objects(&fixture)) {
        assert_eq!(item.sha256.as_slice(), Sha256::digest(&data).as_slice());
        assert_eq!(item.size, data.len() as u64);
    }
    assert_eq!(read.reads.len(), fixture.manifest.objects().len());
}

#[test]
fn a_package_round_trips_with_a_passphrase() {
    let fixture = fixture(&[0, 77, 70_000]);
    let bytes = write_with(&fixture, PackageSecret::Passphrase(PASSPHRASE)).unwrap();
    let read = read_all(&bytes, PackageSecret::Passphrase(PASSPHRASE)).unwrap();
    assert_eq!(renumber(&read.manifest), renumber(&fixture.manifest));
    assert_eq!(read.objects, fixture_objects(&fixture));
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
    // A one-character slip is caught as a typo, before any unwrapping. The check is 10 bits, so for
    // a random key about 2 slips in 1,024 would get through (as a key, or as a recovery key), which
    // made this test fail about one run in 450 (measured over 40,000 random keys). The exact answer
    // is asserted for a fixed key; the test below counts every slip of it.
    let fixed = Zeroizing::new([7_u8; RECOVERY_KEY_BYTES]);
    let fixed_text = encode_key_text(&fixed, PACKAGE_KEY_CHECK_LABEL);
    let mut slipped: Vec<char> = fixed_text.chars().collect();
    slipped[0] = if slipped[0] == '2' { '3' } else { '2' };
    assert_eq!(
        parse_package_key(&slipped.into_iter().collect::<String>()).err(),
        Some(PackageError::KeyTypo)
    );
}

#[test]
fn every_one_symbol_slip_of_a_fixed_package_key_is_counted_so_a_change_in_the_check_shows() {
    // The check is 10 bits: about 1 slip in 1,024 passes for the package label or for the
    // recovery label. For a fixed key the outcome of every slip is fixed too, so the counts are
    // exact: a check that is no longer read, a label that changed, or a different width moves them.
    // None may ever read back as the key itself (a slip changes the key).
    let key = Zeroizing::new([7_u8; RECOVERY_KEY_BYTES]);
    let text: Vec<char> = encode_key_text(&key, PACKAGE_KEY_CHECK_LABEL)
        .replace('-', "")
        .chars()
        .collect();
    assert_eq!(text.len(), 28);
    let (mut as_a_key, mut as_a_recovery_key, mut as_a_typo) = (0_u32, 0_u32, 0_u32);
    for position in 0..text.len() {
        for symbol in CROCKFORD_ALPHABET.iter().map(|symbol| char::from(*symbol)) {
            if text[position] == symbol {
                continue;
            }
            let mut slipped = text.clone();
            slipped[position] = symbol;
            match parse_package_key(&slipped.into_iter().collect::<String>()) {
                Ok(read) => {
                    assert_ne!(*read, *key, "a slip cannot read back as the key");
                    as_a_key += 1;
                }
                Err(PackageError::RecoveryKeyEntered) => as_a_recovery_key += 1,
                Err(PackageError::KeyTypo) => as_a_typo += 1,
                Err(other) => panic!("a slip gave {other:?}"),
            }
        }
    }
    // 28 symbols, 31 other symbols each: 868 slips.
    assert_eq!((as_a_key, as_a_recovery_key, as_a_typo), (0, 1, 867));
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
    let mut reader = PackageReader::open(
        Cursor::new(&bytes[..first_object.2]),
        PackageSecret::Key(&key),
    )
    .unwrap();
    assert_eq!(renumber(reader.manifest()), renumber(&fixture.manifest));
    assert_eq!(
        reader.next_object(),
        Some(reader.manifest().records[0].display)
    );
    // What opening alone cannot know, the tail check does: the file is cut short.
    assert_eq!(reader.verify_tail(), Err(PackageError::Unreadable));
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
        // Every object has a new name too: the ids are made by the writer.
        if one.0 == KIND_OBJECT {
            assert_ne!(one.1, two.1);
        }
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
    // The source's own ids are in neither the file nor, decrypted, the manifest: the
    // package has ids of its own for every folder, record and object.
    let read = read_all(&bytes, PackageSecret::Key(&key)).unwrap();
    let decrypted = serde_json::to_string(&read.manifest).unwrap();
    let mut ids: Vec<Uuid> = fixture.manifest.folders.iter().map(|f| f.id).collect();
    for record in &fixture.manifest.records {
        ids.push(record.id);
        ids.extend(
            record
                .original_pdf
                .iter()
                .chain([&record.display])
                .map(|o| o.id),
        );
        ids.extend(record.ai_answers.iter().map(|a| a.object.id));
    }
    for id in ids {
        assert!(!bytes.windows(16).any(|window| window == id.as_bytes()));
        assert!(!bytes
            .windows(32)
            .any(|window| window == id.simple().to_string().as_bytes()));
        assert!(!decrypted.contains(&id.to_string()));
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
    let object = reader.manifest().records[0].display;
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
    assert_eq!(out, fixture.data[&fixture.manifest.records[0].display.id]);
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
    let read = read_all(&bytes, PackageSecret::Key(&key)).unwrap();
    for record in &read.manifest.records {
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
    // And the keys under it: the object ids are new each time too, so no object has the
    // same id, or the same key, in two exports of one person.
    let first_object = |bytes: &[u8]| {
        let reader = PackageReader::open(Cursor::new(bytes), PackageSecret::Key(&key)).unwrap();
        let id = reader.manifest().records[0].display.id;
        (id, object_key(&reader.keys, id).unwrap())
    };
    let (id_a, key_a) = first_object(&a);
    let (id_b, key_b) = first_object(&b);
    assert_ne!(id_a, id_b);
    assert_ne!(*key_a, *key_b);
}

// ---------------------------------------------------------------------------
// The #390 review: format first, the tail without the objects, a poisoned
// writer, ids made by the writer, a verified token, a key of its own kind
// ---------------------------------------------------------------------------

/// A package made as a newer myCarlos might: magic, then a header that is not this
/// format's, with a field and a key kind this build does not know.
fn newer_header_package() -> Vec<u8> {
    let header = serde_json::json!({
        "format": 2,
        "packageId": Uuid::new_v4(),
        "keyKind": "hardware",
        "somethingNew": {"a": 1},
        "wrappedPackageKey": {"nonce": "x", "ciphertext": "y"}
    });
    let header = serde_json::to_vec(&header).unwrap();
    let mut bytes = PACKAGE_MAGIC.to_vec();
    bytes.extend((header.len() as u32).to_be_bytes());
    bytes.extend(header);
    bytes
}

#[test]
fn a_newer_header_is_a_newer_format_not_an_unreadable_file() {
    let bytes = newer_header_package();
    let key = key();
    assert!(matches!(
        PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)),
        Err(PackageError::NewerFormat)
    ));
    assert!(matches!(
        PackageReader::open(Cursor::new(&bytes), PackageSecret::Passphrase(PASSPHRASE)),
        Err(PackageError::NewerFormat)
    ));
    // A header with no format, or an older one, or not JSON, is just unreadable.
    for header in [
        br#"{"packageId":"x"}"#.as_slice(),
        br#"{"format":0}"#,
        b"not json",
    ] {
        let mut bytes = PACKAGE_MAGIC.to_vec();
        bytes.extend((header.len() as u32).to_be_bytes());
        bytes.extend(header);
        assert!(matches!(
            PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)),
            Err(PackageError::Unreadable)
        ));
    }
}

#[test]
fn a_newer_manifest_is_a_newer_format_even_with_fields_this_build_does_not_know() {
    let key = key();
    let mut writer = PackageWriter::create(Vec::new(), PackageSecret::Key(&key), &[]).unwrap();
    let json = serde_json::to_vec(&serde_json::json!({
        "format": 2,
        "exportedAtMs": 1,
        "somethingNew": [1, 2, 3],
        "profile": {"unknownKind": true}
    }))
    .unwrap();
    let sealed = seal_padded(
        &writer.keys.manifest,
        &entry_aad(MANIFEST_AAD, writer.package_id),
        &json,
        manifest_class(json.len()).unwrap(),
    )
    .unwrap();
    writer
        .small_entry(KIND_MANIFEST, NAME_MANIFEST, &sealed)
        .unwrap();
    let bytes = writer.inner;
    assert!(matches!(
        PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)),
        Err(PackageError::NewerFormat)
    ));
}

#[test]
fn the_tail_is_checked_without_reading_the_objects() {
    let fixture = fixture(&[1, CHUNK_SIZE + 3, 0, 70_000]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    reader.verify_tail().unwrap();
    // The place is put back: the objects are read, and the whole checked, after it.
    let mut count = 0;
    while reader.next_object().is_some() {
        reader.read_object(&mut Vec::new(), &open).unwrap();
        count += 1;
        if count == 2 {
            reader.verify_tail().unwrap();
        }
    }
    reader.finish().unwrap();
}

#[test]
fn a_package_that_is_cut_altered_or_extended_is_refused_by_the_tail_check() {
    let fixture = fixture(&[1, 5_000, 70_000]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let entries = spans(&bytes);
    let manifest_end = entries
        .iter()
        .find(|entry| entry.0 == KIND_MANIFEST)
        .unwrap()
        .3;
    let digests = entries
        .iter()
        .find(|entry| entry.0 == KIND_DIGESTS)
        .unwrap();
    let trailer_at = digests.3;
    let tail = |bytes: &[u8]| {
        let mut reader = PackageReader::open(Cursor::new(bytes), PackageSecret::Key(&key))?;
        reader.verify_tail()
    };
    assert_eq!(tail(&bytes), Ok(()));

    // Cut right after the manifest: what inspecting alone would have accepted.
    assert!(PackageReader::open(
        Cursor::new(&bytes[..manifest_end]),
        PackageSecret::Key(&key)
    )
    .is_ok());
    assert_eq!(tail(&bytes[..manifest_end]), Err(PackageError::Unreadable));
    // Cut between the objects and the digests, inside the digests, inside the trailer,
    // and one byte short of the end.
    for cut in [
        digests.2,
        digests.2 + 20,
        trailer_at,
        trailer_at + 10,
        bytes.len() - 1,
    ] {
        assert_eq!(tail(&bytes[..cut]), Err(PackageError::Unreadable), "{cut}");
    }
    // A bit flipped in the trailer or its tag; a byte added; a whole entry's worth added.
    for at in [trailer_at + 8, bytes.len() - 1, bytes.len() - 40] {
        let mut flipped = bytes.clone();
        flipped[at] ^= 1;
        assert_eq!(tail(&flipped), Err(PackageError::Unreadable), "{at}");
    }
    let mut longer = bytes.clone();
    longer.push(0);
    assert_eq!(tail(&longer), Err(PackageError::Unreadable));
    let mut doubled = bytes.clone();
    doubled.extend_from_slice(&bytes[trailer_at..]);
    assert_eq!(tail(&doubled), Err(PackageError::Unreadable));
    // A digests entry from another package, in place of this one's.
    let other = write_package(&fixture, &key);
    let other_digests = spans(&other)
        .into_iter()
        .find(|entry| entry.0 == KIND_DIGESTS)
        .unwrap();
    let mut swapped = bytes[..digests.2].to_vec();
    swapped.extend_from_slice(&other[other_digests.2..other_digests.3]);
    swapped.extend_from_slice(&bytes[trailer_at..]);
    assert_eq!(tail(&swapped), Err(PackageError::Unreadable));
}

#[test]
fn the_tail_check_works_on_a_file() {
    use std::io::BufReader;
    let fixture = fixture(&[3 * CHUNK_SIZE + 1, 20]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("package.mcprofile");
    std::fs::write(&path, &bytes).unwrap();
    let file = BufReader::new(std::fs::File::open(&path).unwrap());
    let mut reader = PackageReader::open(file, PackageSecret::Key(&key)).unwrap();
    reader.verify_tail().unwrap();
    while reader.next_object().is_some() {
        reader.read_object(&mut io::sink(), &open).unwrap();
    }
    reader.finish().unwrap();
}

#[test]
fn a_writer_that_has_failed_writes_nothing_more() {
    let fixture = fixture(&[3 * CHUNK_SIZE, 10]);
    let key = key();
    let first = fixture.manifest.records[0].display;

    // A cancelled object may have left half an entry: no other object, and no finish.
    let mut writer = started(&fixture, &key);
    let mut source = Cursor::new(fixture.data[&first.id].clone());
    assert_eq!(
        writer.write_object(first.id, &mut source, &|| false),
        Err(PackageError::Cancelled)
    );
    let length = writer.inner.len();
    let mut again = Cursor::new(fixture.data[&first.id].clone());
    assert_eq!(
        writer.write_object(first.id, &mut again, &open),
        Err(PackageError::Invalid)
    );
    assert_eq!(writer.inner.len(), length);
    assert!(matches!(writer.finish(), Err(PackageError::Invalid)));

    // A source of the wrong size does the same.
    let mut writer = started(&fixture, &key);
    assert!(writer
        .write_object(first.id, &mut Cursor::new(vec![0_u8; 5]), &open)
        .is_err());
    assert!(matches!(writer.finish(), Err(PackageError::Invalid)));

    // And a manifest that was refused leaves the writer unusable, not waiting for another.
    let mut bad = fixture.manifest.clone();
    bad.profile.display_name.clear();
    let mut writer = PackageWriter::create(Vec::new(), PackageSecret::Key(&key), &[]).unwrap();
    assert!(writer.write_manifest(&bad).is_err());
    assert_eq!(
        writer.write_manifest(&fixture.manifest),
        Err(PackageError::Invalid)
    );
}

#[test]
fn the_writer_makes_every_id_and_keeps_the_callers_out_of_the_file() {
    let fixture = fixture(&[100, 200, 300]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let read = read_all(&bytes, PackageSecret::Key(&key)).unwrap();
    let mine: HashSet<Uuid> = fixture
        .manifest
        .folders
        .iter()
        .map(|folder| folder.id)
        .chain(fixture.manifest.records.iter().map(|record| record.id))
        .chain(fixture.manifest.objects().iter().map(|object| object.id))
        .collect();
    let theirs: HashSet<Uuid> = read
        .manifest
        .folders
        .iter()
        .map(|folder| folder.id)
        .chain(read.manifest.records.iter().map(|record| record.id))
        .chain(read.manifest.objects().iter().map(|object| object.id))
        .collect();
    assert_eq!(mine.len(), theirs.len());
    assert!(mine.is_disjoint(&theirs));
    // The folder tree and each record's folders are the same shape, on the new ids.
    assert_eq!(renumber(&read.manifest), renumber(&fixture.manifest));
    // Two exports of one person share no id.
    let again = read_all(&write_package(&fixture, &key), PackageSecret::Key(&key)).unwrap();
    let ids = |manifest: &PackageManifest| -> HashSet<Uuid> {
        manifest
            .folders
            .iter()
            .map(|folder| folder.id)
            .chain(manifest.records.iter().map(|record| record.id))
            .chain(manifest.objects().iter().map(|object| object.id))
            .collect()
    };
    assert!(ids(&read.manifest).is_disjoint(&ids(&again.manifest)));
}

#[test]
fn the_manifest_says_how_many_bytes_the_objects_hold() {
    let fixture = fixture(&[0, 10, 70_000]);
    // The sizes plus the first record's second copy (300) and answer (40).
    assert_eq!(fixture.manifest.total_plaintext_bytes(), 70_010 + 340);
}

#[test]
fn the_history_excerpt_is_bounded_by_what_a_phone_can_hold() {
    assert_eq!(MAX_HISTORY_ENTRIES, 2_000);
    assert_eq!(MAX_MANIFEST_CLASS, 16 * 1024 * 1024);
    let mut manifest = fixture(&[1]).manifest;
    manifest.history = Some(vec![
        serde_json::json!({"event": "imported"});
        MAX_HISTORY_ENTRIES
    ]);
    assert_eq!(manifest.validate(), Ok(()));
}

#[test]
fn a_package_key_and_a_recovery_key_are_told_apart() {
    // A fixed key: with a random one, each of the three assertions about the check below had a
    // 1-in-1,024 chance of failing (the 10-bit checks of the two kinds can agree by chance).
    let key = Zeroizing::new([7_u8; RECOVERY_KEY_BYTES]);
    let text = encode_key_text(&key, PACKAGE_KEY_CHECK_LABEL);
    // The package's own key reads back, as it is shown and as a person types it.
    assert_eq!(*parse_package_key(&text).unwrap(), *key);
    assert_eq!(
        *parse_package_key(&text.to_lowercase().replace('-', " ")).unwrap(),
        *key
    );
    // The vault does not take it for a recovery key, nor a recovery key for it, and
    // the person is told which was typed.
    assert!(super::super::decode_recovery_key(&text).is_err());
    let recovery = super::super::encode_recovery_key(&key);
    assert_eq!(
        parse_package_key(&recovery).err(),
        Some(PackageError::RecoveryKeyEntered)
    );
    assert_ne!(*recovery, *text);
    // Still a typo when it is neither.
    let mut typo = text.to_string();
    typo.replace_range(0..1, if typo.starts_with('A') { "B" } else { "A" });
    assert_eq!(parse_package_key(&typo).err(), Some(PackageError::KeyTypo));
}

#[test]
fn the_digests_bound_holds_and_a_manifest_of_names_never_prints() {
    let widest = DigestEntry {
        id: Uuid::new_v4(),
        size: MAX_OBJECT_BYTES,
        sha256: BASE64.encode([255_u8; 32]),
    };
    for count in [0, 1, 1_000] {
        let json = serde_json::to_vec(&Digests {
            objects: (0..count)
                .map(|_| DigestEntry {
                    id: widest.id,
                    size: widest.size,
                    sha256: widest.sha256.clone(),
                })
                .collect(),
        })
        .unwrap();
        assert!(json.len() <= digests_upper_bound(count), "{count}");
    }
    // The most objects a package may hold leave room for their digests and trailer.
    assert!(manifest_class(digests_upper_bound(MAX_PACKAGE_OBJECTS)).is_some());
    const { assert!(MAX_PACKAGE_OBJECTS * 140 + 200 <= MAX_TRAILER_BYTES) };
    // Debug prints counts, never a name or a date.
    let fixture = fixture(&[1, 2]);
    let shown = format!("{:?}", fixture.manifest);
    for word in ["FAKE", "2015", "Letter"] {
        assert!(!shown.contains(word), "{word}");
    }
    let key = key();
    let bytes = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    while reader.next_object().is_some() {
        reader.read_object(&mut io::sink(), &open).unwrap();
    }
    let verified = reader.finish().unwrap();
    assert!(!format!("{verified:?}").contains("FAKE"));
}

#[test]
fn a_trailer_length_that_claims_more_than_the_file_holds_allocates_nothing_of_the_sort() {
    let fixture = fixture(&[1]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let digests = spans(&bytes)
        .into_iter()
        .find(|entry| entry.0 == KIND_DIGESTS)
        .unwrap();
    // The trailer marker, then a length of nearly the maximum, then nothing.
    let mut forged = bytes[..digests.3].to_vec();
    forged.push(KIND_TRAILER);
    forged.extend((MAX_TRAILER_BYTES as u32).to_be_bytes());
    forged.extend([0_u8; 10]);
    let mut reader = PackageReader::open(Cursor::new(&forged), PackageSecret::Key(&key)).unwrap();
    assert_eq!(reader.verify_tail(), Err(PackageError::Unreadable));
    // A file cut so that the tail would start past its end.
    let manifest_end = spans(&bytes)
        .into_iter()
        .find(|entry| entry.0 == KIND_MANIFEST)
        .unwrap()
        .3;
    let mut reader = PackageReader::open(
        Cursor::new(&bytes[..manifest_end]),
        PackageSecret::Key(&key),
    )
    .unwrap();
    assert_eq!(reader.verify_tail(), Err(PackageError::Unreadable));
}

#[test]
fn the_history_and_the_evidence_carry_none_of_the_vaults_ids() {
    let mut fixture = fixture(&[10, 20]);
    let make = |sizes: &[usize]| self::fixture(sizes);
    let first = fixture.manifest.records[0].id;
    let second = fixture.manifest.records[1].id;
    let folder = fixture.manifest.folders[0].id;
    fixture.manifest.history = Some(vec![
        serde_json::json!({"event": "imported", "recordId": first, "profileId": Uuid::new_v4(), "folderId": folder}),
        serde_json::json!({"event": "renamed", "recordId": second}),
        // A record that is not in the package: its id is dropped, not left pointing at nothing.
        serde_json::json!({"event": "hidden", "recordId": Uuid::new_v4()}),
        serde_json::json!({"event": "imported", "portalLinkId": Uuid::new_v4()}),
    ]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let read = read_all(&bytes, PackageSecret::Key(&key)).unwrap();
    let history = read.manifest.history.as_ref().unwrap();
    assert_eq!(history.len(), 4);
    // The two entries about documents in the package follow those documents' new ids.
    assert_eq!(
        history[0]["recordId"],
        serde_json::json!(read.manifest.records[0].id)
    );
    assert_eq!(
        history[1]["recordId"],
        serde_json::json!(read.manifest.records[1].id)
    );
    for entry in history {
        for key in ["profileId", "folderId", "portalLinkId"] {
            assert!(entry.get(key).is_none(), "{key}");
        }
    }
    assert!(history[2].get("recordId").is_none());
    // A vault id left in clinic evidence is refused rather than written.
    let mut stray = make(&[10]);
    let record = stray.manifest.records[0].id;
    stray.manifest.records[0].carried = Some(serde_json::json!({"source": record}));
    assert!(matches!(
        write_with(&stray, PackageSecret::Key(&key)),
        Err(PackageError::Invalid)
    ));
}

// ---------------------------------------------------------------------------
// Import (#360 PR 4): objects as streams, the digests before the objects, the receipt code
// ---------------------------------------------------------------------------

#[test]
fn an_object_can_be_pulled_as_a_stream_and_counts_only_once_finished() {
    let fixture = fixture(&[CHUNK_SIZE + 9, 40, 0]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    let mut got = Vec::new();
    while reader.next_object().is_some() {
        let mut stream = reader.object_stream(&open).unwrap();
        let mut data = Vec::new();
        // Small reads, as a re-encryptor that reads a chunk at a time would make.
        let mut piece = [0_u8; 1000];
        loop {
            let read = stream.read(&mut piece).unwrap();
            if read == 0 {
                break;
            }
            data.extend_from_slice(&piece[..read]);
        }
        let read = stream.finish().unwrap();
        assert_eq!(read.size, data.len() as u64);
        got.push(data);
    }
    assert_eq!(got, fixture_objects(&fixture));
    assert!(reader.finish().is_ok());
}

#[test]
fn a_stream_dropped_early_leaves_the_reader_unusable_and_an_unfinished_one_is_refused() {
    let fixture = fixture(&[2 * CHUNK_SIZE, 40]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    {
        let mut stream = reader.object_stream(&open).unwrap();
        let mut piece = [0_u8; 10];
        stream.read_exact(&mut piece).unwrap();
        // Not read to its end: finishing it is refused.
        assert!(matches!(stream.finish(), Err(PackageError::Invalid)));
    }
    assert!(reader.next_object().is_none());
    assert!(matches!(
        reader.object_stream(&open),
        Err(PackageError::Invalid)
    ));
    assert!(matches!(reader.verify_tail(), Err(PackageError::Invalid)));
    assert!(matches!(reader.finish(), Err(PackageError::Invalid)));
}

#[test]
fn a_damaged_or_stopped_stream_says_what_went_wrong() {
    let fixture = fixture(&[2 * CHUNK_SIZE]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let object = spans(&bytes)
        .into_iter()
        .find(|entry| entry.0 == KIND_OBJECT)
        .unwrap();
    let mut flipped = bytes.clone();
    flipped[object.2 + 3 + object.1.len() + 8 + 25 + 5 + 100] ^= 1;
    let mut reader = PackageReader::open(Cursor::new(&flipped), PackageSecret::Key(&key)).unwrap();
    let mut stream = reader.object_stream(&open).unwrap();
    let mut sink = Vec::new();
    assert!(stream.read_to_end(&mut sink).is_err());
    assert_eq!(stream.take_failure(), Some(PackageError::Unreadable));

    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    let stopped = || false;
    let mut stream = reader.object_stream(&stopped).unwrap();
    assert!(stream.read(&mut [0_u8; 10]).is_err());
    assert_eq!(stream.take_failure(), Some(PackageError::Cancelled));
}

#[test]
fn the_digests_are_known_before_any_object_is_read_and_agree_with_what_is_read() {
    let fixture = fixture(&[10, CHUNK_SIZE + 1]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    assert!(reader.tail_digests().is_none());
    reader.verify_tail().unwrap();
    let before: Vec<ObjectRead> = reader.tail_digests().unwrap().to_vec();
    while reader.next_object().is_some() {
        reader.read_object(&mut io::sink(), &open).unwrap();
    }
    let verified = reader.finish().unwrap();
    assert_eq!(before, verified.objects());
}

#[test]
fn the_receipt_code_is_the_same_from_the_import_and_from_the_source_and_differs_per_package() {
    let fixture = fixture(&[10, 5_000]);
    let key = key();
    let bytes = write_package(&fixture, &key);
    // The importer's: after reading everything.
    let mut reader = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    while reader.next_object().is_some() {
        reader.read_object(&mut io::sink(), &open).unwrap();
    }
    let imported = reader.finish().unwrap().receipt_code().to_owned();
    // The source's: from the file and the key, without reading an object.
    let mut again = PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
    assert!(again.receipt_code().is_none());
    again.verify_tail().unwrap();
    assert_eq!(again.receipt_code().unwrap(), imported);
    // Eight characters of the key's alphabet in two groups.
    assert_eq!(imported.len(), 9);
    assert_eq!(imported.as_bytes()[4], b'-');
    assert!(imported
        .chars()
        .filter(|c| *c != '-')
        .all(|c| CROCKFORD_ALPHABET.contains(&(c as u8))));
    // Another export of the same documents is another package: another code.
    let other = write_package(&fixture, &key);
    let mut reader = PackageReader::open(Cursor::new(&other), PackageSecret::Key(&key)).unwrap();
    reader.verify_tail().unwrap();
    assert_ne!(reader.receipt_code().unwrap(), imported);
}

#[test]
fn the_kind_of_key_is_read_from_the_header_without_any_secret() {
    let fixture = fixture(&[3]);
    let key = key();
    let with_key = write_package(&fixture, &key);
    assert_eq!(
        package_key_kind(Cursor::new(&with_key)).unwrap(),
        KeyKind::Key
    );
    let with_passphrase = write_with(&fixture, PackageSecret::Passphrase(PASSPHRASE)).unwrap();
    assert_eq!(
        package_key_kind(Cursor::new(&with_passphrase)).unwrap(),
        KeyKind::Passphrase
    );
    // Not a package, cut short, or from a newer myCarlos: said as such.
    assert!(matches!(
        package_key_kind(Cursor::new(b"not a package at all".as_slice())),
        Err(PackageError::Unreadable)
    ));
    assert!(matches!(
        package_key_kind(Cursor::new(&with_key[..30])),
        Err(PackageError::Unreadable)
    ));
    assert!(matches!(
        package_key_kind(Cursor::new(newer_header_package())),
        Err(PackageError::NewerFormat)
    ));
}
