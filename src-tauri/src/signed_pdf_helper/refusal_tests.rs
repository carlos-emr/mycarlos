//! The signed-PDF helper's structure checks and its pipe protocol, beyond what `signed_pdf_helper`'s
//! own tests reach (coverage batch 3).
//!
//! The helper runs in the confined child and reads a PDF that anybody may have made. Before the main
//! process sends a password for the attachment, the helper's report must say that the file holds
//! exactly one signature dictionary, referenced by exactly one reachable signature field, with no
//! cycle, no field tree past the bounds, and at most one manifest attachment that the catalog names.
//! These tests take the pinned fixture's good document, rebuild one part of it at a time and check
//! each refusal. FAKE documents only (the fixture's).

use super::*;
use lopdf::{Dictionary, Document, Object, ObjectId};

const FIXTURE: &[u8] = include_bytes!("../../tests/fixtures/mycarlos-signed-pdf-fixtures.json");

fn good_pdf() -> Vec<u8> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let fixture: serde_json::Value = serde_json::from_slice(FIXTURE).unwrap();
    STANDARD
        .decode(fixture["documents"][0]["pdf_b64"].as_str().unwrap())
        .unwrap()
}

fn name(text: &str) -> Object {
    Object::Name(text.as_bytes().to_vec())
}

fn dict(pairs: Vec<(&str, Object)>) -> Dictionary {
    let mut dictionary = Dictionary::new();
    for (key, value) in pairs {
        dictionary.set(key, value);
    }
    dictionary
}

fn reference(id: ObjectId) -> Object {
    Object::Reference(id)
}

struct Fixture {
    doc: Document,
    signature: ObjectId,
    filespec: ObjectId,
    catalog: ObjectId,
}

fn fixture() -> Fixture {
    let doc = Document::load_mem(&good_pdf()).unwrap();
    let find = |kind: &[u8]| {
        doc.objects
            .iter()
            .find_map(|(id, object)| {
                object
                    .as_dict()
                    .ok()
                    .filter(|dictionary| {
                        dictionary.get(b"Type").and_then(Object::as_name).ok() == Some(kind)
                    })
                    .map(|_| *id)
            })
            .unwrap()
    };
    let catalog = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
    Fixture {
        signature: find(b"Sig"),
        filespec: find(b"Filespec"),
        catalog,
        doc,
    }
}

impl Fixture {
    fn catalog_mut(&mut self) -> &mut Dictionary {
        self.doc
            .get_object_mut(self.catalog)
            .unwrap()
            .as_dict_mut()
            .unwrap()
    }

    /// A signature field that points at the signature dictionary.
    fn field(&mut self) -> ObjectId {
        let value = reference(self.signature);
        self.doc
            .add_object(dict(vec![("FT", name("Sig")), ("V", value)]))
    }

    fn plain(&mut self) -> ObjectId {
        self.doc.add_object(dict(vec![("FT", name("Tx"))]))
    }

    /// The form's fields replaced by `fields`.
    fn with_fields(mut self, fields: Vec<Object>) -> Self {
        let form = self
            .doc
            .add_object(dict(vec![("Fields", Object::Array(fields))]));
        self.catalog_mut().set("AcroForm", reference(form));
        self
    }

    /// The catalog's name tree replaced by one holding `entries` under `EmbeddedFiles`.
    fn with_names(mut self, node: Dictionary) -> Self {
        let tree = self.doc.add_object(node);
        let names = self
            .doc
            .add_object(dict(vec![("EmbeddedFiles", reference(tree))]));
        self.catalog_mut().set("Names", reference(names));
        self
    }

    fn manifest_entries(&self, entries: Vec<Object>) -> Dictionary {
        dict(vec![("Names", Object::Array(entries))])
    }

    fn file_name() -> Object {
        Object::string_literal(MANIFEST_NAME)
    }
}

fn structure(fixture: &Fixture) -> Result<[usize; 4], Refusal> {
    signature_structure(&fixture.doc)
}

// ---- the signature structure ------------------------------------------------------------------

#[test]
fn the_fixture_has_one_signature_and_one_manifest_and_each_test_below_changes_one_part() {
    let good = fixture();
    assert!(structure(&good).is_ok());
    assert!(manifest(&good.doc).unwrap().is_some());
    // The same document rebuilt with a form of its own, as the tests below do.
    let mut rebuilt = fixture();
    let field = rebuilt.field();
    let rebuilt = rebuilt.with_fields(vec![reference(field)]);
    assert_eq!(structure(&rebuilt), structure(&good));
}

#[test]
fn a_second_signature_dictionary_or_none_is_refused() {
    let mut two = fixture();
    two.doc.add_object(dict(vec![
        ("Type", name("Sig")),
        ("Filter", name("Adobe.PPKLite")),
        ("SubFilter", name("ETSI.CAdES.detached")),
    ]));
    assert_eq!(structure(&two), Err(Refusal::BadStructure));
    let mut none = fixture();
    let id = none.signature;
    none.doc
        .get_object_mut(id)
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .remove(b"Type");
    assert_eq!(structure(&none), Err(Refusal::BadStructure));
}

#[test]
fn only_the_cades_detached_signature_of_the_pkcs_provider_is_accepted() {
    for key in ["SubFilter", "Filter"] {
        let mut other = fixture();
        let id = other.signature;
        other
            .doc
            .get_object_mut(id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set(key, name("Something.Else"));
        assert_eq!(structure(&other), Err(Refusal::BadStructure), "{key}");
    }
}

#[test]
fn a_catalog_that_is_not_one_or_has_no_form_is_refused() {
    let mut not_catalog = fixture();
    not_catalog.catalog_mut().set("Type", name("Pages"));
    assert_eq!(structure(&not_catalog), Err(Refusal::BadStructure));
    let mut no_form = fixture();
    no_form.catalog_mut().remove(b"AcroForm");
    assert_eq!(structure(&no_form), Err(Refusal::BadStructure));
}

#[test]
fn the_byte_range_must_be_four_non_negative_integers() {
    for bad in [
        vec![Object::Integer(0), Object::Integer(1), Object::Integer(2)],
        vec![
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(2),
            Object::Integer(-3),
        ],
        vec![
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(2),
            name("Three"),
        ],
        vec![
            Object::Integer(0),
            Object::Integer(1),
            Object::Integer(2),
            Object::Integer(3),
            Object::Integer(4),
        ],
    ] {
        let mut other = fixture();
        let id = other.signature;
        other
            .doc
            .get_object_mut(id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("ByteRange", Object::Array(bad));
        assert_eq!(structure(&other), Err(Refusal::BadStructure));
    }
}

#[test]
fn the_signature_must_be_the_value_of_exactly_one_reachable_field() {
    // The same field listed twice (a cycle in the making), two fields holding it, and none.
    let mut repeated = fixture();
    let field = repeated.field();
    let repeated = repeated.with_fields(vec![reference(field), reference(field)]);
    assert_eq!(structure(&repeated), Err(Refusal::BadStructure));
    let mut twice = fixture();
    let (one, two) = (twice.field(), twice.field());
    let twice = twice.with_fields(vec![reference(one), reference(two)]);
    assert_eq!(structure(&twice), Err(Refusal::BadStructure));
    let mut empty_value = fixture();
    let plain = empty_value.plain();
    let empty_value = empty_value.with_fields(vec![reference(plain)]);
    assert_eq!(structure(&empty_value), Err(Refusal::BadStructure));
    // A value that is written inline instead of pointing at the dictionary.
    let mut inline = fixture();
    let field = inline.doc.add_object(dict(vec![
        ("FT", name("Sig")),
        ("V", Object::Dictionary(Dictionary::new())),
    ]));
    let inline = inline.with_fields(vec![reference(field)]);
    assert_eq!(structure(&inline), Err(Refusal::BadStructure));
}

#[test]
fn a_field_tree_past_its_bounds_is_refused_and_at_the_bounds_is_read() {
    // 256 fields visited is the most; one more is refused.
    let build = |others: usize| {
        let mut fixture = fixture();
        let field = fixture.field();
        let mut fields = vec![reference(field)];
        for _ in 0..others {
            let plain = fixture.plain();
            fields.push(reference(plain));
        }
        fixture.with_fields(fields)
    };
    assert!(structure(&build(255)).is_ok());
    assert_eq!(structure(&build(256)), Err(Refusal::BadStructure));
    // More than 256 kids under one field.
    let mut many = fixture();
    let kids: Vec<Object> = (0..257).map(|_| reference(many.plain())).collect();
    let parent = many
        .doc
        .add_object(dict(vec![("Kids", Object::Array(kids))]));
    let many = many.with_fields(vec![reference(parent)]);
    assert_eq!(structure(&many), Err(Refusal::BadStructure));
    // A chain of nested fields: the signature at depth 32 is read, at depth 33 it is refused.
    let chain = |depth: usize| {
        let mut fixture = fixture();
        let mut inner = fixture.field();
        for _ in 0..depth {
            inner = fixture
                .doc
                .add_object(dict(vec![("Kids", Object::Array(vec![reference(inner)]))]));
        }
        fixture.with_fields(vec![reference(inner)])
    };
    assert!(structure(&chain(32)).is_ok());
    assert_eq!(structure(&chain(33)), Err(Refusal::BadStructure));
}

// ---- the manifest attachment --------------------------------------------------------------------

#[test]
fn the_manifest_is_found_by_its_exact_name_in_either_string_form() {
    let file = |fixture: &Fixture| reference(fixture.filespec);
    let base = fixture();
    let entries = vec![Fixture::file_name(), file(&base)];
    let node = base.manifest_entries(entries);
    assert!(manifest(&base.with_names(node).doc).unwrap().is_some());
    // The same name as UTF-16 with a byte-order mark.
    let base = fixture();
    let mut utf16 = vec![0xfe, 0xff];
    for byte in MANIFEST_NAME {
        utf16.extend_from_slice(&[0, *byte]);
    }
    let node = base.manifest_entries(vec![Object::string_literal(utf16.clone()), file(&base)]);
    assert!(manifest(&base.with_names(node).doc).unwrap().is_some());
    // Anything else is another file's name: no manifest, not a refusal.
    let mut shorter = utf16.clone();
    shorter.truncate(shorter.len() - 2);
    let mut swapped = utf16.clone();
    swapped[2..4].copy_from_slice(&[b'c', 0]);
    for other in [
        Object::string_literal(b"carlos-document-manifest.jsn".to_vec()),
        Object::string_literal(b"Carlos-document-manifest.json".to_vec()),
        Object::string_literal(shorter),
        Object::string_literal(swapped),
        Object::string_literal(Vec::<u8>::new()),
    ] {
        let base = fixture();
        let node = base.manifest_entries(vec![other, file(&base)]);
        assert_eq!(manifest(&base.with_names(node).doc), Ok(None));
    }
    // No name tree, or a name tree without embedded files, has no manifest either.
    let mut no_names = fixture();
    no_names.catalog_mut().remove(b"Names");
    assert_eq!(manifest(&no_names.doc), Ok(None));
    let mut no_files = fixture();
    let names = no_files.doc.add_object(Dictionary::new());
    no_files.catalog_mut().set("Names", reference(names));
    assert_eq!(manifest(&no_files.doc), Ok(None));
}

#[test]
fn a_name_tree_that_is_odd_long_or_ambiguous_is_refused() {
    let case = |entries: &dyn Fn(&Fixture) -> Vec<Object>| {
        let base = fixture();
        let entries = entries(&base);
        let node = base.manifest_entries(entries);
        manifest(&base.with_names(node).doc)
    };
    // An odd number of entries.
    assert_eq!(
        case(&|f| vec![
            Fixture::file_name(),
            reference(f.filespec),
            Object::Integer(1)
        ]),
        Err(Refusal::BadManifest)
    );
    // More than 256 entries.
    assert_eq!(
        case(&|_| vec![Object::Integer(0); 258]),
        Err(Refusal::BadManifest)
    );
    // The name twice (two attachments of that name), and a value that is not a reference.
    assert_eq!(
        case(&|f| vec![
            Fixture::file_name(),
            reference(f.filespec),
            Fixture::file_name(),
            reference(f.filespec),
        ]),
        Err(Refusal::BadManifest)
    );
    assert_eq!(
        case(&|_| vec![Fixture::file_name(), Object::Integer(1)]),
        Err(Refusal::BadManifest)
    );
}

#[test]
fn a_name_tree_past_its_bounds_is_refused() {
    // 128 nodes visited is the most (the root counts): a root with 128 empty kids is 129.
    let kids = |count: usize| {
        let mut base = fixture();
        let children: Vec<Object> = (0..count)
            .map(|_| reference(base.doc.add_object(Dictionary::new())))
            .collect();
        let node = dict(vec![("Kids", Object::Array(children))]);
        manifest(&base.with_names(node).doc)
    };
    assert_eq!(kids(127), Ok(None));
    assert_eq!(kids(128), Err(Refusal::BadManifest));
    assert_eq!(kids(129), Err(Refusal::BadManifest));
    // A chain of kids: depth 16 is read, 17 refused.
    let chain = |depth: usize| {
        let mut base = fixture();
        let mut inner = base.doc.add_object(Dictionary::new());
        for _ in 0..depth {
            inner = base
                .doc
                .add_object(dict(vec![("Kids", Object::Array(vec![reference(inner)]))]));
        }
        let root = dict(vec![("Kids", Object::Array(vec![reference(inner)]))]);
        manifest(&base.with_names(root).doc)
    };
    assert_eq!(chain(14), Ok(None));
    assert_eq!(chain(16), Err(Refusal::BadManifest));
}

#[test]
fn the_catalog_must_associate_the_attachment_once_and_the_stream_must_be_an_embedded_file() {
    let named = |fixture: Fixture| {
        let node =
            fixture.manifest_entries(vec![Fixture::file_name(), reference(fixture.filespec)]);
        fixture.with_names(node)
    };
    // Not associated at all, listed twice, and more than 128 entries.
    let mut none = fixture();
    none.catalog_mut().remove(b"AF");
    assert_eq!(manifest(&named(none).doc), Err(Refusal::BadManifest));
    let mut twice = fixture();
    let file = reference(twice.filespec);
    twice
        .catalog_mut()
        .set("AF", Object::Array(vec![file.clone(), file.clone()]));
    assert_eq!(manifest(&named(twice).doc), Err(Refusal::BadManifest));
    let mut many = fixture();
    let file = reference(many.filespec);
    let mut list = vec![file];
    list.extend((0..128).map(|_| Object::Integer(0)));
    many.catalog_mut().set("AF", Object::Array(list));
    assert_eq!(manifest(&named(many).doc), Err(Refusal::BadManifest));
    // The attached stream is not typed as an embedded file.
    let mut untyped = fixture();
    let stream = embedded_stream(&untyped);
    untyped
        .doc
        .get_object_mut(stream)
        .unwrap()
        .as_stream_mut()
        .unwrap()
        .dict
        .remove(b"Type");
    assert_eq!(manifest(&untyped.doc), Err(Refusal::BadManifest));
}

fn embedded_stream(fixture: &Fixture) -> ObjectId {
    let file = fixture
        .doc
        .get_object(fixture.filespec)
        .unwrap()
        .as_dict()
        .unwrap();
    let ef = fixture
        .doc
        .dereference(file.get(b"EF").unwrap())
        .unwrap()
        .1
        .as_dict()
        .unwrap();
    ef.get(b"F").unwrap().as_reference().unwrap()
}

#[test]
fn a_manifest_of_exactly_the_limit_is_read_and_one_byte_more_is_refused() {
    for (length, ok) in [(MAX_MANIFEST, true), (MAX_MANIFEST + 1, false)] {
        let mut sized = fixture();
        let stream = embedded_stream(&sized);
        sized
            .doc
            .get_object_mut(stream)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .set_plain_content(vec![b'x'; length]);
        match manifest(&sized.doc) {
            Ok(Some(bytes)) => assert!(ok && bytes.len() == length, "{length}"),
            Err(Refusal::BadManifest) => assert!(!ok, "{length}"),
            other => panic!("{length}: {other:?}"),
        }
    }
}

// ---- the pipe protocol -----------------------------------------------------------------------

fn request(stage: u8, password: &str, pdf: &[u8]) -> Vec<u8> {
    let mut bytes = vec![stage];
    crate::pdf_unlock::write_password_and_pdf(&mut bytes, password.as_bytes(), pdf).unwrap();
    bytes
}

fn answered(input: &[u8]) -> (i32, Vec<u8>) {
    let mut out = Vec::new();
    let code = answer(&mut &input[..], &mut out);
    (code, out)
}

#[test]
fn the_helper_answers_only_a_whole_well_formed_request_for_a_stage_it_knows() {
    let pdf = good_pdf();
    // Nothing at all, a stage byte alone, a request cut short.
    assert_eq!(answered(&[]).0, 3);
    assert_eq!(answered(&[0]).0, 3);
    assert_eq!(answered(&request(0, "", &pdf)[..6]).0, 3);
    // A stage the helper does not have, and stage 0 with a password (the first stage never gets one).
    assert_eq!(answered(&request(2, "", &pdf)).0, 3);
    assert_eq!(answered(&request(255, "", &pdf)).0, 3);
    assert_eq!(answered(&request(0, "secret", &pdf)).0, 3);
    // A password longer than the helper takes: the request itself is malformed.
    let long = "p".repeat(crate::pdf_unlock::MAX_PASSWORD_BYTES + 1);
    assert_eq!(answered(&request(1, &long, &pdf)).0, 3);
    // Stage 0 with no password answers with the layout and no manifest.
    let (code, out) = answered(&request(0, "", &pdf));
    assert_eq!(code, 0);
    assert_eq!(&out[..8], RESPONSE);
    let size = u32::from_le_bytes(out[8..12].try_into().unwrap()) as usize;
    assert_eq!(out.len(), 12 + size);
    let report: Result<Report, Refusal> = serde_json::from_slice(&out[12..]).unwrap();
    let report = report.unwrap();
    assert_eq!(report.layout.byte_ranges.len(), 1);
    assert!(report.manifest.is_none());
    // A document that is not signed is still answered, with the refusal.
    let (code, out) = answered(&request(0, "", b"%PDF-1.7\nno signature here\n"));
    assert_eq!(code, 0);
    let report: Result<Report, Refusal> = serde_json::from_slice(&out[12..]).unwrap();
    assert!(report.unwrap().layout.byte_ranges.is_empty());
}

#[test]
fn an_answer_that_cannot_be_written_is_a_failed_run() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("FAKE closed pipe"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let input = request(0, "", &good_pdf());
    assert_eq!(answer(&mut &input[..], &mut Broken), 3);
}

#[cfg(desktop)]
fn through_a_pipe(bytes: Vec<u8>) -> Option<Result<Report, Refusal>> {
    let (mut reader, mut writer) = io::pipe().unwrap();
    // A thread writes, since a long answer is larger than the pipe holds.
    let sender = std::thread::spawn(move || {
        let _ = writer.write_all(&bytes);
    });
    let result = read_response(&mut reader);
    drop(reader);
    sender.join().unwrap();
    result
}

#[cfg(desktop)]
fn framed(result: &Result<Report, Refusal>) -> Vec<u8> {
    let body = serde_json::to_vec(result).unwrap();
    let mut bytes = RESPONSE.to_vec();
    bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&body);
    bytes
}

#[cfg(desktop)]
#[test]
fn the_parent_reads_only_a_framed_answer_within_the_bounds() {
    let layout = |ranges: usize| SignatureLayout {
        byte_ranges: vec![[0, 1, 2, 3]; ranges],
        update_after_signature: false,
        encrypted: false,
    };
    let report = |ranges: usize, manifest: Option<Vec<u8>>| {
        Ok(Report {
            layout: layout(ranges),
            manifest,
        })
    };
    // A good answer, in both of its shapes.
    assert!(through_a_pipe(framed(&report(1, Some(vec![b'm'; MAX_MANIFEST])))).is_some());
    assert!(matches!(
        through_a_pipe(framed(&Err(Refusal::BadStructure))),
        Some(Err(Refusal::BadStructure))
    ));
    // More than two signatures, and a manifest one byte over its limit.
    assert!(through_a_pipe(framed(&report(3, None))).is_none());
    assert!(through_a_pipe(framed(&report(1, Some(vec![b'm'; MAX_MANIFEST + 1])))).is_none());
    // A wrong magic, a size over the limit (nothing after it needs to be sent), a body cut short and a
    // body that is not the agreed JSON.
    let mut wrong_magic = framed(&report(1, None));
    wrong_magic[0] ^= 1;
    assert!(through_a_pipe(wrong_magic).is_none());
    let mut huge = RESPONSE.to_vec();
    huge.extend_from_slice(&((MAX_RESPONSE + 1) as u32).to_le_bytes());
    assert!(through_a_pipe(huge).is_none());
    let mut cut = framed(&report(1, None));
    cut.truncate(cut.len() - 1);
    assert!(through_a_pipe(cut).is_none());
    let mut junk = RESPONSE.to_vec();
    junk.extend_from_slice(&4_u32.to_le_bytes());
    junk.extend_from_slice(b"nope");
    assert!(through_a_pipe(junk).is_none());
    assert!(through_a_pipe(Vec::new()).is_none());
}

// ---- the import probe ---------------------------------------------------------------------------

#[test]
fn the_probe_gives_up_on_a_file_over_the_helpers_budget_and_forgets_what_it_kept() {
    let mut probe = ImportProbe::new();
    probe.write_all(b"%PDF-1.7\n").unwrap();
    assert!(probe.is_pdf());
    // One write past the budget (zero bytes, so nothing is touched): it is over, what it held is
    // wiped, and the verdict is "too large" whatever else was seen.
    probe
        .write_all(&vec![0_u8; crate::pdf_unlock::MAX_LOCKED_PDF_BYTES])
        .unwrap();
    assert!(probe.bytes.is_empty());
    assert!(matches!(
        probe.finish_with(|_| Failure::Unavailable),
        Some(Failure::TooLarge)
    ));
}

#[test]
fn the_probe_only_looks_at_a_pdf_with_a_byte_range_and_only_the_first_kilobyte_for_its_type() {
    let finish = |bytes: &[u8]| {
        let mut probe = ImportProbe::new();
        probe.write_all(bytes).unwrap();
        probe.finish_with(|_| Failure::Unavailable)
    };
    // Not a PDF, a PDF with no signature range, and a signed one.
    assert!(finish(b"hello /ByteRange [0 1 2 3]").is_none());
    assert!(finish(b"%PDF-1.7\nplain document").is_none());
    assert!(matches!(
        finish(b"%PDF-1.7\n/ByteRange [0 1 2 3]"),
        Some(Failure::Unavailable)
    ));
    // The type is read from the first kilobyte only.
    let mut late = ImportProbe::new();
    late.write_all(&[b' '; 1024]).unwrap();
    late.write_all(b"%PDF-").unwrap();
    assert!(!late.is_pdf());
}
