//! Manual, model-free acceptance of the actual document-text command on synthetic PDFs.
//! This module and its executable-selection seam exist only in Linux test builds.

use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    path: String,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HelperManifest {
    schema: u32,
    source_revision: String,
    source_files: Vec<SourceFile>,
    build_features: Vec<String>,
    helper_path: PathBuf,
    helper_sha256: String,
    build_receipt_path: PathBuf,
    build_receipt_sha256: String,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_digest(path: &Path) -> String {
    let mut input = fs::File::open(path).expect("open acceptance provenance file");
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = input
            .read(&mut buffer)
            .expect("read acceptance provenance file");
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    format!("{:x}", hasher.finalize())
}

fn compiled_sources() -> BTreeMap<String, String> {
    [
        (
            "src-tauri/src/main.rs",
            include_bytes!("main.rs").as_slice(),
        ),
        ("src-tauri/src/lib.rs", include_bytes!("lib.rs").as_slice()),
        (
            "src-tauri/src/vault.rs",
            include_bytes!("vault.rs").as_slice(),
        ),
        (
            "src-tauri/src/pdf_view.rs",
            include_bytes!("pdf_view.rs").as_slice(),
        ),
        (
            "src-tauri/src/pdf_unlock.rs",
            include_bytes!("pdf_unlock.rs").as_slice(),
        ),
        (
            "src-tauri/src/extraction_acceptance_tests.rs",
            include_bytes!("extraction_acceptance_tests.rs").as_slice(),
        ),
        (
            "src-tauri/Cargo.toml",
            include_bytes!("../Cargo.toml").as_slice(),
        ),
        (
            "src-tauri/Cargo.lock",
            include_bytes!("../Cargo.lock").as_slice(),
        ),
        (
            "src-tauri/build.rs",
            include_bytes!("../build.rs").as_slice(),
        ),
        (
            "src-tauri/tests/fixtures/extraction-acceptance/fake-image-only-scan.pdf",
            include_bytes!("../tests/fixtures/extraction-acceptance/fake-image-only-scan.pdf")
                .as_slice(),
        ),
        (
            "src-tauri/tests/fixtures/extraction-acceptance/fake-widget-form.pdf",
            include_bytes!("../tests/fixtures/extraction-acceptance/fake-widget-form.pdf")
                .as_slice(),
        ),
        (
            "src-tauri/tests/fixtures/extraction-acceptance/fake-flattened-form.pdf",
            include_bytes!("../tests/fixtures/extraction-acceptance/fake-flattened-form.pdf")
                .as_slice(),
        ),
    ]
    .into_iter()
    .map(|(name, bytes)| (name.to_owned(), digest(bytes)))
    .collect()
}

fn git(root: &Path, arguments: &[&str]) -> String {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(root)
        .output()
        .expect("read acceptance source revision");
    assert!(
        output.status.success(),
        "acceptance source must remain a Git checkout"
    );
    String::from_utf8(output.stdout).expect("Git output is UTF-8")
}

struct BoundHelper {
    manifest: HelperManifest,
    path: PathBuf,
}

impl BoundHelper {
    fn load(scratch: &Path, source_root: &Path) -> Self {
        let manifest_path = std::env::var_os("MYCARLOS_EXTRACTION_ACCEPTANCE_MANIFEST")
            .expect("set a reviewed exact-build helper manifest for this ignored test");
        let manifest: HelperManifest = serde_json::from_slice(
            &fs::read(manifest_path).expect("read exact-build helper manifest"),
        )
        .expect("valid exact-build helper manifest");
        assert_eq!(manifest.schema, 1);
        assert_eq!(
            manifest.source_revision,
            git(source_root, &["rev-parse", "HEAD"]).trim()
        );
        assert!(git(source_root, &["status", "--porcelain"]).is_empty());
        let mut declared = BTreeMap::new();
        for file in &manifest.source_files {
            assert!(declared
                .insert(file.path.clone(), file.sha256.clone())
                .is_none());
        }
        assert_eq!(
            declared,
            compiled_sources(),
            "helper and test must bind the same source"
        );
        let features = if cfg!(feature = "ai-helper-stub") {
            vec!["ai-helper-stub".to_owned()]
        } else {
            Vec::new()
        };
        assert_eq!(manifest.build_features, features);
        assert_eq!(
            file_digest(&manifest.build_receipt_path),
            manifest.build_receipt_sha256
        );
        let original = fs::symlink_metadata(&manifest.helper_path).expect("stat exact helper");
        assert!(original.is_file() && !original.file_type().is_symlink());
        assert_eq!(
            fs::canonicalize(&manifest.helper_path).unwrap(),
            manifest.helper_path
        );
        assert_eq!(
            original.nlink(),
            1,
            "provide a private copy, never a shared-target hardlink"
        );
        assert_eq!(original.uid(), fs::metadata(scratch).unwrap().uid());
        assert_eq!(
            original.permissions().mode() & 0o222,
            0,
            "helper copy must be read-only"
        );
        assert_ne!(original.permissions().mode() & 0o111, 0);
        let parent = fs::metadata(manifest.helper_path.parent().unwrap()).unwrap();
        assert_eq!(
            parent.permissions().mode() & 0o077,
            0,
            "private helper bundle directory"
        );
        assert_eq!(parent.uid(), original.uid());
        assert_eq!(file_digest(&manifest.helper_path), manifest.helper_sha256);
        let path = scratch.join("FAKE-exact-pdf-helper");
        let mut from = fs::File::open(&manifest.helper_path).unwrap();
        let mut into = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .unwrap();
        std::io::copy(&mut from, &mut into).unwrap();
        into.sync_all().unwrap();
        drop(into);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(file_digest(&manifest.helper_path), manifest.helper_sha256);
        let bound = Self { manifest, path };
        bound.assert_unchanged();
        let mut magic = [0_u8; 4];
        fs::File::open(&bound.path)
            .unwrap()
            .read_exact(&mut magic)
            .unwrap();
        assert_eq!(
            &magic, b"\x7fELF",
            "use the built Linux app, not a script or protocol fake"
        );
        bound
    }

    fn assert_unchanged(&self) {
        let metadata = fs::symlink_metadata(&self.path).unwrap();
        assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.permissions().mode() & 0o222, 0);
        assert_eq!(file_digest(&self.path), self.manifest.helper_sha256);
    }
}

fn write_evidence(output: &Path, name: &str, bytes: &[u8]) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output.join(name))
        .expect("never overwrite acceptance evidence");
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
}

fn expected_page_digest(text: &str) -> [u8; 32] {
    // Independent construction of the documented page-index/UTF-8-length frame.
    let mut framed = vec![0_u8; 4];
    framed.extend_from_slice(&(text.len() as u64).to_le_bytes());
    framed.extend_from_slice(text.as_bytes());
    Sha256::digest(framed).into()
}

#[test]
#[ignore = "manual: exact-built real PDF helper, private bundle and model-free native window required"]
fn actual_document_text_preserves_scan_and_form_extraction_limits() {
    let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let helper = BoundHelper::load(scratch.path(), source_root);
    let output = PathBuf::from(
        std::env::var_os("MYCARLOS_EXTRACTION_ACCEPTANCE_OUTPUT")
            .expect("set a new external directory for retained extraction pages"),
    );
    assert!(output.is_absolute());
    let output = fs::canonicalize(output.parent().expect("external output parent"))
        .unwrap()
        .join(output.file_name().expect("new output directory name"));
    assert!(!output.starts_with(fs::canonicalize(source_root).unwrap()));
    fs::DirBuilder::new()
        .mode(0o700)
        .create(&output)
        .expect("new private evidence directory");
    write_evidence(
        &output,
        "helper-provenance.json",
        &serde_json::to_vec_pretty(&helper.manifest).unwrap(),
    );
    let store = Arc::new(VaultStore::new(scratch.path().join("FAKE-vault")));
    store
        .create(
            "river-azimuth-cobalt-sparrow-934",
            "FAKE Extraction Person",
            1,
        )
        .unwrap();
    let profile = store.snapshot().unwrap().profiles[0].id;
    let picks = Arc::new(PendingPicks::default());
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&store))
        .manage(Arc::clone(&picks))
        .build(production_context())
        .unwrap();
    let cases: [(&str, &[u8], &str); 3] = [
        ("fake-image-only-scan.pdf", include_bytes!("../tests/fixtures/extraction-acceptance/fake-image-only-scan.pdf"), ""),
        ("fake-widget-form.pdf", include_bytes!("../tests/fixtures/extraction-acceptance/fake-widget-form.pdf"),
         "FAKE SYNTHETIC FORM - NO REAL PERSON\nForm record is 7.\nSelected colour:\nKeep green card:\n"),
        ("fake-flattened-form.pdf", include_bytes!("../tests/fixtures/extraction-acceptance/fake-flattened-form.pdf"),
         "FAKE FLATTENED FORM - NO REAL PERSON\nForm record is 8.\nSelected colour: BLUE FLATTENED\nKeep green card: YES FLATTENED\n"),
    ];
    let mut retained = Vec::new();
    let mut observations = Vec::new();
    for (index, (name, pdf, expected)) in cases.into_iter().enumerate() {
        let record = store
            .import(
                profile,
                vec![],
                vec![vault::ImportSource {
                    display_name: name.to_owned(),
                    reader: Box::new(std::io::Cursor::new(pdf.to_vec())),
                }],
                index as u64 * 20 + 2,
            )
            .unwrap()
            .imported[0];
        let reader = Uuid::new_v4();
        let selected = pdf_view::extraction_testing::bind(reader, helper.path.clone());
        helper.assert_unchanged();
        let text = tauri::async_runtime::block_on(vault_document_text(
            app.state(),
            app.state(),
            DocumentTextRequest {
                record_id: record,
                read_id: reader,
                password: None,
            },
        ))
        .unwrap_or_else(|_| panic!("real document-text command failed for {name}"));
        assert_eq!(
            selected.selections(),
            1,
            "one real helper exchange for the one-page PDF"
        );
        helper.assert_unchanged();
        assert_eq!(text.page_count, 1);
        assert_eq!(text.pages.len(), 1);
        assert_eq!(text.pages[0].index, 0);
        assert_eq!(text.pages[0].text, expected);
        assert_eq!(text.joined, expected);
        assert_eq!(text.page_starts, [0]);
        assert_eq!(
            text.empty_pages,
            if expected.is_empty() { vec![0] } else { vec![] }
        );
        assert!(text.cut_pages.is_empty() && text.failed_pages.is_empty() && !text.truncated);
        assert!(!text.ticket.is_nil());
        let ticket = picks.peek_text(text.ticket, record).unwrap();
        assert_eq!(ticket.record_id, record);
        assert_eq!(ticket.pages_digest, expected_page_digest(expected));
        assert_eq!(ticket.pages_missing, expected.is_empty());
        assert!(!ticket.truncated && ticket.cut_after_page.is_none());
        assert_eq!(ticket.last_index, Some(0));
        assert!(matches!(
            picks.peek_text(text.ticket, Uuid::nil()),
            Err(VaultError::Invalid)
        ));
        if name == "fake-widget-form.pdf" {
            assert!(!text.joined.contains("BLUE WIDGET ONLY"));
            assert!(!text.joined.contains("Yes"));
        }
        write_evidence(&output, name, pdf);
        write_evidence(
            &output,
            &format!("{name}.pages.json"),
            &serde_json::to_vec_pretty(&text).unwrap(),
        );
        observations.push(serde_json::json!({
            "input": name, "input_sha256": digest(pdf), "document_text": &text,
            "bound_ticket_digest": ticket.pages_digest,
            "known_extraction_limitation": name != "fake-flattened-form.pdf",
        }));
        retained.push((text.ticket, record));
        drop(selected);
        store.hide_record(record, index as u64 * 20 + 10).unwrap();
        let refused_reader = Uuid::new_v4();
        let refusal = pdf_view::extraction_testing::bind(refused_reader, helper.path.clone());
        let error = tauri::async_runtime::block_on(vault_document_text(
            app.state(),
            app.state(),
            DocumentTextRequest {
                record_id: record,
                read_id: refused_reader,
                password: None,
            },
        ))
        .err()
        .expect("hidden record must be refused");
        assert_eq!(error.code, "not_found");
        assert_eq!(
            refusal.selections(),
            0,
            "hidden record refused before helper selection"
        );
    }
    picks.clear();
    for (ticket, record) in &retained {
        assert!(
            matches!(picks.peek_text(*ticket, *record), Err(VaultError::NotFound)),
            "old-session ticket is unusable"
        );
    }
    store.lock();
    let locked_reader = Uuid::new_v4();
    let locked = pdf_view::extraction_testing::bind(locked_reader, helper.path.clone());
    let error = tauri::async_runtime::block_on(vault_document_text(
        app.state(),
        app.state(),
        DocumentTextRequest {
            record_id: retained[0].1,
            read_id: locked_reader,
            password: None,
        },
    ))
    .err()
    .expect("locked vault must be refused");
    assert_eq!(error.code, "locked");
    assert_eq!(locked.selections(), 0);
    helper.assert_unchanged();
    write_evidence(&output, "acceptance-result.json", &serde_json::to_vec_pretty(&serde_json::json!({
        "schema": 1, "command": "vault_document_text", "runtime": "tauri mock runtime",
        "source_revision": &helper.manifest.source_revision, "helper_sha256": &helper.manifest.helper_sha256,
        "observations": observations, "hidden_and_locked_refused_before_helper": true,
        "old_session_tickets_refused": true, "model_invoked": false,
        "scope": "extraction characterization only; no OCR/widget support or model-quality claim",
    })).unwrap());
    assert!(git(source_root, &["status", "--porcelain"]).is_empty());
}
