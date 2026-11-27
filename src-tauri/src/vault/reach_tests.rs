//! What is in reach of the library (#574 PR A, behaviour-neutral). FAKE data only.
//!
//! A document or a folder is out of reach when something hides it. Today that is only a hidden
//! person; hiding a folder (#574 PR B) adds a reason. This file pins the three helpers every
//! lookup asks (`person_in_reach`, `record_in_reach`, `folder_in_reach`), that the helper for a
//! folder is bounded and fails closed, the entry points that did not ask about a person before
//! (a folder target, a folder's parent, a batch of records), and a source scan that every
//! function taking a record or folder id still asks one of them, so that a function added later
//! cannot slip past the way the reader's and the importer's lookups once could.

use super::*;
use std::io::Cursor;

const PASSWORD: &str = "correct horse battery staple 9173";

fn source(name: &str, data: &[u8]) -> ImportSource {
    ImportSource {
        display_name: name.to_owned(),
        reader: Box::new(Cursor::new(data.to_vec())),
    }
}

struct Vault {
    _temp: tempfile::TempDir,
    store: VaultStore,
    parent: Uuid,
    child: Uuid,
    folder: Uuid,
    parent_doc: Uuid,
    child_doc: Uuid,
}

/// FAKE Parent (one document) and FAKE Child (a folder holding one document).
fn vault() -> Vault {
    let temp = tempfile::tempdir().unwrap();
    let store = VaultStore::new(temp.path().join("vault"));
    store.create(PASSWORD, "FAKE Parent", 1).unwrap();
    let parent = store.snapshot().unwrap().profiles[0].id;
    let child = store.create_profile("FAKE Child", 2).unwrap();
    let folder = store.create_folder(child, None, "FAKE Letters", 3).unwrap();
    let parent_doc = store
        .import(
            parent,
            vec![],
            vec![source("FAKE Parent Letter.pdf", b"FAKE-PARENT-BYTES")],
            4,
        )
        .unwrap()
        .imported[0];
    let child_doc = store
        .import(
            child,
            vec![folder],
            vec![source("FAKE Child Letter.pdf", b"FAKE-CHILD-BYTES")],
            5,
        )
        .unwrap()
        .imported[0];
    Vault {
        _temp: temp,
        store,
        parent,
        child,
        folder,
        parent_doc,
        child_doc,
    }
}

fn manifest_of(v: &Vault) -> Manifest {
    v.store.session().as_ref().unwrap().manifest.clone()
}

fn hidden() -> Option<Hidden> {
    Some(Hidden {
        at_ms: 1,
        reason: HiddenReason::Patient,
    })
}

/// Appends a folder to a hand-built manifest and returns its id.
fn push_folder(manifest: &mut Manifest, profile_id: Uuid, parent_id: Option<Uuid>) -> Uuid {
    let id = Uuid::new_v4();
    manifest.folders.push(VaultFolder {
        id,
        profile_id,
        parent_id,
        name: "FAKE Folder".to_owned(),
        created_at_ms: 1,
        hidden: None,
    });
    id
}

#[test]
fn a_person_in_reach_is_one_that_is_not_hidden_and_a_stranger_is_not_hidden() {
    let v = vault();
    let mut manifest = manifest_of(&v);
    assert!(manifest.person_in_reach(v.parent));
    assert!(manifest.person_in_reach(v.child));
    manifest
        .profiles
        .iter_mut()
        .find(|profile| profile.id == v.child)
        .unwrap()
        .hidden = hidden();
    assert!(!manifest.person_in_reach(v.child));
    assert!(manifest.person_in_reach(v.parent));
    // A profile that is not in the manifest is not hidden: the caller's own lookup says it is
    // missing (`require_profile` does).
    assert!(manifest.person_in_reach(Uuid::new_v4()));
    assert!(matches!(
        require_profile(&manifest, v.child),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        require_profile(&manifest, Uuid::new_v4()),
        Err(VaultError::NotFound)
    ));
    assert!(require_profile(&manifest, v.parent).is_ok());
}

#[test]
fn a_document_is_in_reach_exactly_when_its_person_is() {
    let v = vault();
    let mut manifest = manifest_of(&v);
    let in_reach = |manifest: &Manifest, id: Uuid| {
        manifest.record_in_reach(manifest.records.iter().find(|r| r.id == id).unwrap())
    };
    assert!(in_reach(&manifest, v.parent_doc));
    assert!(in_reach(&manifest, v.child_doc));
    manifest
        .profiles
        .iter_mut()
        .find(|profile| profile.id == v.child)
        .unwrap()
        .hidden = hidden();
    assert!(in_reach(&manifest, v.parent_doc));
    assert!(!in_reach(&manifest, v.child_doc));
    // The document's own flag is a separate one that its callers check; it is not reach.
    let mut own = manifest_of(&v);
    own.records
        .iter_mut()
        .find(|r| r.id == v.child_doc)
        .unwrap()
        .hidden = hidden();
    assert!(in_reach(&own, v.child_doc));
}

#[test]
fn a_folder_is_in_reach_when_it_and_every_folder_above_it_is_and_its_person_is() {
    let v = vault();
    let mut manifest = manifest_of(&v);
    let inner = push_folder(&mut manifest, v.child, Some(v.folder));
    let innermost = push_folder(&mut manifest, v.child, Some(inner));
    for id in [v.folder, inner, innermost] {
        assert!(manifest.folder_in_reach(id));
    }
    // An unknown folder is not in reach: nothing is named that is not there.
    assert!(!manifest.folder_in_reach(Uuid::new_v4()));
    // A hidden person takes every folder of theirs with them, whatever its depth.
    manifest
        .profiles
        .iter_mut()
        .find(|profile| profile.id == v.child)
        .unwrap()
        .hidden = hidden();
    for id in [v.folder, inner, innermost] {
        assert!(!manifest.folder_in_reach(id));
    }
    assert!(manifest.folders_in_reach().is_empty());
}

#[test]
fn folder_reach_fails_closed_on_a_cycle_a_missing_parent_and_a_chain_too_deep() {
    let v = vault();
    // A cycle: each is the other's parent. Never true, never a loop.
    let mut manifest = manifest_of(&v);
    let a = push_folder(&mut manifest, v.child, None);
    let b = push_folder(&mut manifest, v.child, Some(a));
    manifest
        .folders
        .iter_mut()
        .find(|folder| folder.id == a)
        .unwrap()
        .parent_id = Some(b);
    assert!(!manifest.folder_in_reach(a));
    assert!(!manifest.folder_in_reach(b));
    // A folder that is its own parent.
    let mut manifest = manifest_of(&v);
    let own = push_folder(&mut manifest, v.child, None);
    manifest
        .folders
        .iter_mut()
        .find(|folder| folder.id == own)
        .unwrap()
        .parent_id = Some(own);
    assert!(!manifest.folder_in_reach(own));
    // A parent that is not in the manifest.
    let mut manifest = manifest_of(&v);
    let orphan = push_folder(&mut manifest, v.child, Some(Uuid::new_v4()));
    assert!(!manifest.folder_in_reach(orphan));
    // A chain of 32 folders, the deepest the vault allows, is in reach; one of 34 is not (the
    // walk is bounded, not trusting the manifest's own depth rule).
    let mut manifest = manifest_of(&v);
    let mut chain = Vec::new();
    let mut parent = None;
    for _ in 0..34 {
        let id = push_folder(&mut manifest, v.child, parent);
        chain.push(id);
        parent = Some(id);
    }
    assert!(manifest.folder_in_reach(chain[31]));
    assert!(!manifest.folder_in_reach(chain[33]));
}

#[test]
fn the_folders_in_reach_are_the_ones_asked_one_by_one() {
    let v = vault();
    let mut manifest = manifest_of(&v);
    let inner = push_folder(&mut manifest, v.child, Some(v.folder));
    let orphan = push_folder(&mut manifest, v.child, Some(Uuid::new_v4()));
    let set = manifest.folders_in_reach();
    for folder in &manifest.folders {
        assert_eq!(
            set.contains(&folder.id),
            manifest.folder_in_reach(folder.id)
        );
    }
    assert!(set.contains(&inner) && !set.contains(&orphan));
    // And the snapshot lists exactly them.
    assert_eq!(v.store.snapshot().unwrap().folders.len(), 1);
}

#[test]
fn a_folder_target_out_of_reach_is_not_named_and_a_foreign_or_unknown_one_is_invalid() {
    let v = vault();
    let mut manifest = manifest_of(&v);
    // As today: a folder of another person, or one that is not there, is invalid.
    assert!(matches!(
        validate_folder_ids(&manifest, v.parent, &[v.folder]),
        Err(VaultError::Invalid)
    ));
    assert!(matches!(
        validate_folder_ids(&manifest, v.child, &[Uuid::new_v4()]),
        Err(VaultError::Invalid)
    ));
    assert!(validate_folder_ids(&manifest, v.child, &[v.folder]).is_ok());
    assert!(validate_folder_ids(&manifest, v.child, &[]).is_ok());
    // A folder of the right person that is out of reach: not named (NotFound), so a document is
    // never filed into a place the patient cannot see.
    manifest
        .profiles
        .iter_mut()
        .find(|profile| profile.id == v.child)
        .unwrap()
        .hidden = hidden();
    assert!(matches!(
        validate_folder_ids(&manifest, v.child, &[v.folder]),
        Err(VaultError::NotFound)
    ));
}

#[test]
fn a_batch_is_refused_whole_when_any_one_document_in_it_is_out_of_reach() {
    let v = vault();
    let placements = |store: &VaultStore| {
        let mut all: Vec<(Uuid, Vec<Uuid>)> = store
            .snapshot()
            .unwrap()
            .records
            .iter()
            .map(|record| (record.id, record.folder_ids.clone()))
            .collect();
        all.sort();
        all
    };
    let before = placements(&v.store);
    v.store.hide_profile(v.child, 100).unwrap();
    // One in reach (the parent's) and one not (the hidden child's): nothing moves.
    assert!(matches!(
        v.store
            .assign_folders_batch(vec![v.parent_doc, v.child_doc], vec![]),
        Err(VaultError::NotFound)
    ));
    v.store.restore_profile(v.child).unwrap();
    assert_eq!(placements(&v.store), before);
    // Both in reach: allowed, as before.
    v.store
        .assign_folders_batch(vec![v.child_doc], vec![])
        .unwrap();
}

#[test]
fn nothing_is_filed_under_or_moved_into_a_folder_of_a_hidden_person() {
    let v = vault();
    v.store.hide_profile(v.child, 100).unwrap();
    assert!(matches!(
        v.store
            .create_folder(v.child, Some(v.folder), "FAKE Inside", 101),
        Err(VaultError::NotFound)
    ));
    assert!(matches!(
        v.store.update_folder(v.folder, None, "FAKE Renamed"),
        Err(VaultError::NotFound)
    ));
    // The parent lookup of a folder moved or made: the parent's own reach is what counts, so a
    // visible person's folder cannot take a hidden person's folder as its parent either (it is
    // another person's, which was already invalid).
    let other = v
        .store
        .create_folder(v.parent, None, "FAKE Other", 102)
        .unwrap();
    assert!(matches!(
        v.store.update_folder(other, Some(v.folder), "FAKE Other"),
        Err(VaultError::Invalid)
    ));
}

// ---- the net -------------------------------------------------------------------------------

/// How a function that takes a record or folder id proves it asked the helpers.
enum Reach {
    /// Its body names this helper (or one of the checks that calls it).
    Asks(&'static str),
    /// It hands the work to another registered function.
    Delegates(&'static str),
    /// It reads or opens nothing the manifest holds; the reason is the review.
    Exempt(&'static str),
}

/// Every function in `impl VaultStore` that takes `record_id`, `record_ids`, `folder_id`,
/// `folder_ids` or `parent_id`. A new one fails `every_function_taking_a_record_or_folder_id…`
/// until it is added here with how it asks.
const ENTRY_POINTS: &[(&str, Reach)] = &[
    ("create_folder", Reach::Asks("folder_in_reach")),
    ("update_folder", Reach::Asks("folder_in_reach")),
    ("rename_record", Reach::Asks("record_in_reach")),
    ("assign_folders", Reach::Delegates("assign_folders_batch")),
    ("assign_folders_batch", Reach::Asks("record_in_reach")),
    ("import", Reach::Delegates("import_from")),
    ("import_from", Reach::Asks("validate_folder_ids")),
    ("move_to_profile", Reach::Asks("record_in_reach")),
    ("export", Reach::Delegates("read_record")),
    ("read_for_view", Reach::Delegates("read_record")),
    ("read_for_suggestion", Reach::Delegates("read_record")),
    ("read_record", Reach::Asks("record_in_reach")),
    ("export_name", Reach::Asks("record_in_reach")),
    ("export_atomic", Reach::Delegates("export")),
    (
        "record_copy_saved",
        Reach::Delegates("record_copy_saved_how"),
    ),
    ("record_copy_saved_how", Reach::Asks("record_in_reach")),
    ("export_text_atomic", Reach::Asks("record_in_reach")),
    ("known_identifiers", Reach::Asks("record_in_reach")),
    ("hide_record", Reach::Delegates("set_hidden")),
    ("unhide_record", Reach::Delegates("set_hidden")),
    ("set_hidden", Reach::Asks("record_in_reach")),
    ("playback_open", Reach::Asks("record_in_reach")),
    (
        "notify_local_arrival",
        Reach::Delegates("notify_local_arrival_controlled"),
    ),
    (
        "notify_local_arrival_controlled",
        Reach::Asks("record_in_reach"),
    ),
    (
        "take_arrived_for_hidden",
        Reach::Exempt("takes a record id out of an in-memory set; it opens no record"),
    ),
    ("save_ai_result", Reach::Asks("record_in_reach")),
    ("ai_results", Reach::Asks("record_in_reach")),
    ("read_ai_result", Reach::Asks("record_in_reach")),
    ("recording_start", Reach::Asks("validate_folder_ids")),
    ("added_with_camera", Reach::Asks("record_in_reach")),
    // Hiding a folder (#574 PR B): the folder must be in reach to be hidden; a hidden one is
    // restored only when its person and every folder above it are in reach.
    ("hide_folder", Reach::Asks("folder_in_reach")),
    ("restore_folder", Reach::Asks("folder_parent_in_reach")),
];

/// Functions that take such an id and are not entry points: the helpers themselves.
const NOT_ENTRY_POINTS: &[&str] = &[
    // The reach helpers and their ancestry/subtree walks. `records_hidden_by_folder` compares
    // visible placements for a folder that `hide_folder` has already checked.
    "folder_in_reach",
    "walk_in_reach",
    "folder_parent_in_reach",
    "folder_subtree",
    "records_hidden_by_folder",
    // `ChunkReader::open` (playback.rs): a constructor handed a record that `playback_open` has
    // already found in reach; it looks nothing up.
    "open",
];

/// The code of a source file before its first INLINE test module (`#[cfg(test)] mod name {`).
/// A `#[cfg(test)] mod name;` declaration is a line, not a cut: vault.rs has several of them
/// ahead of its production code.
fn production_code(text: &str) -> &str {
    let marker = "\n#[cfg(test)]\nmod ";
    let mut from = 0;
    while let Some(found) = text[from..].find(marker) {
        let at = from + found;
        let line_end = text[at + marker.len()..]
            .find('\n')
            .map_or(text.len(), |n| at + marker.len() + n);
        if text[at + marker.len()..line_end].trim_end().ends_with('{') {
            return &text[..at];
        }
        from = at + marker.len();
    }
    text
}

/// A function body without its comment lines (a doc comment that names a helper is not a call).
fn without_comments(body: &str) -> String {
    body.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

const ID_PARAMETERS: &[&str] = &[
    "record_id",
    "record_ids",
    "folder_id",
    "folder_ids",
    "parent_id",
];

struct Function {
    name: String,
    parameters: String,
    body: String,
}

/// The functions declared four spaces in (members of an `impl`), in the code before the file's
/// first test module.
fn functions(text: &str) -> Vec<Function> {
    let code = production_code(text);
    let mut starts = Vec::new();
    let mut offset = 0;
    for line in code.split_inclusive('\n') {
        let trimmed = line
            .strip_prefix("    ")
            .filter(|rest| !rest.starts_with(' '));
        if let Some(rest) = trimmed {
            let rest = rest.strip_prefix("pub(crate) ").unwrap_or(rest);
            let rest = rest.strip_prefix("pub ").unwrap_or(rest);
            let rest = rest.strip_prefix("async ").unwrap_or(rest);
            if let Some(after) = rest.strip_prefix("fn ") {
                let name: String = after
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                // Start at `fn`, so visibility such as `pub(crate)` cannot be mistaken for
                // the function's parameter list.
                starts.push((offset + line.len() - rest.len(), name));
            }
        }
        offset += line.len();
    }
    let mut found = Vec::new();
    for (index, (start, name)) in starts.iter().enumerate() {
        let stop = starts.get(index + 1).map_or(code.len(), |next| next.0);
        let body = &code[*start..stop];
        let open = body.find('(').unwrap();
        let mut depth = 0;
        let mut close = open;
        for (position, character) in body[open..].char_indices() {
            match character {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + position;
                        break;
                    }
                }
                _ => {}
            }
        }
        found.push(Function {
            name: name.clone(),
            parameters: body[open + 1..close].to_owned(),
            body: body.to_owned(),
        });
    }
    found
}

fn vault_sources() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = vec![root.join("vault.rs")];
    for entry in std::fs::read_dir(root.join("vault")).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name.ends_with(".rs") && !name.ends_with("tests.rs") && !name.starts_with("test") {
            files.push(path);
        }
    }
    files
        .into_iter()
        .map(|path| {
            let text = std::fs::read_to_string(&path).unwrap();
            (path.display().to_string(), text)
        })
        .collect()
}

#[test]
fn every_function_taking_a_record_or_folder_id_asks_the_reach_helpers() {
    let sources = vault_sources();
    let all: Vec<Function> = sources
        .iter()
        .flat_map(|(_, text)| functions(text))
        .collect();
    assert!(
        all.len() > 100,
        "the scan found only {} functions",
        all.len()
    );
    // The scan must reach vault.rs's own methods (it once stopped at a `mod x;` line near the top
    // and saw none of them): these are in vault.rs, and the registry depends on finding them.
    for name in ["create_folder", "assign_folders_batch", "rename_record"] {
        assert!(
            all.iter().any(|function| function.name == name),
            "the scan did not find `{name}` in vault.rs"
        );
    }
    let takes_an_id = |function: &Function| {
        function.parameters.split(',').any(|parameter| {
            let name = parameter.split(':').next().unwrap_or("").trim();
            ID_PARAMETERS.contains(&name)
        })
    };
    // A name can be declared more than once (in different impls): the one that takes the id.
    let by_name = |name: &str| {
        all.iter()
            .find(|function| function.name == name && takes_an_id(function))
    };

    // 1. Nothing takes such an id without being registered (and a registered one still exists).
    for function in all.iter().filter(|function| takes_an_id(function)) {
        assert!(
            NOT_ENTRY_POINTS.contains(&function.name.as_str())
                || ENTRY_POINTS.iter().any(|(name, _)| *name == function.name),
            "`{}` takes a record or folder id and is not in ENTRY_POINTS: say how it asks the \
             reach helpers (record_in_reach / folder_in_reach / validate_folder_ids), or why it \
             need not (#574)",
            function.name
        );
    }
    for (name, _) in ENTRY_POINTS {
        assert!(
            by_name(name).is_some(),
            "`{name}` is registered but no longer takes a record or folder id"
        );
    }

    // 2. Each one asks, or hands the work to one that does.
    for (name, how) in ENTRY_POINTS {
        let function = by_name(name).unwrap();
        // Comment lines do not count: a doc comment that names a helper is not a call.
        let code = without_comments(&function.body);
        match how {
            Reach::Asks(helper) => assert!(
                code.contains(helper),
                "`{name}` no longer mentions `{helper}`"
            ),
            Reach::Delegates(callee) => {
                assert!(
                    code.contains(&format!("{callee}(")),
                    "`{name}` no longer calls `{callee}`"
                );
                assert!(
                    ENTRY_POINTS.iter().any(|(other, _)| other == callee),
                    "`{name}` delegates to `{callee}`, which is not registered"
                );
            }
            Reach::Exempt(reason) => assert!(!reason.is_empty()),
        }
    }
}

#[test]
fn the_retired_person_is_hidden_is_gone_and_the_three_helpers_are_there() {
    let mut scanned_vault_rs = false;
    for (path, text) in vault_sources() {
        let code = production_code(&text);
        scanned_vault_rs |= path.ends_with("vault.rs") && code.contains("fn create_folder");
        assert!(
            !code.contains("person_is_hidden"),
            "{path} reads the retired `person_is_hidden`: ask person_in_reach / record_in_reach / \
             folder_in_reach (#574)"
        );
    }
    // The scan really read vault.rs's methods, not only the lines before its first `mod x;`.
    assert!(
        scanned_vault_rs,
        "the scan did not reach vault.rs's own code"
    );
    // The three helpers are the ones the lists use.
    let main = include_str!("../vault.rs");
    for helper in [
        "fn person_in_reach",
        "fn record_in_reach",
        "fn folder_in_reach",
    ] {
        assert!(main.contains(helper), "{helper} is gone");
    }
}
