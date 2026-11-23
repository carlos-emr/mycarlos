//! Where a command finds "the" vault (#357, step 2 of the "vault slots" design). Today the app has
//! one `VaultStore`; the multi-vault design gives the device several, one per slot, and only one of
//! them is the vault the screen is on. This module is the seam: every command, the idle thread and
//! the shutdown hook ask a [`StoreHandle`], which asks a [`VaultSource`] for the current store.
//!
//! With the one source here, [`SingleVault`], nothing changes: the handle derefs to the same
//! `Arc<VaultStore>` the app managed before, so a command's body is as it was and only its parameter
//! type changes (`State<'_, Arc<VaultStore>>` to `State<'_, StoreHandle>`). That change is made by
//! `scripts/vault-store-handle-codemod.py`, which is kept so it can be run again over a command a
//! later-merged change adds with the old type; `no_command_takes_the_store_directly` fails the build
//! until it is. The slot-aware source, the switch and the unlock path come in later steps.
//!
//! `current` returns a reference borrowed from the source, so a handle needs no unsafe code and no
//! lock to hand out a store; a source that can change which store is current keeps every store it has
//! made for as long as it lives (the single store lives as long as the app does, today).

use std::ops::Deref;
use std::sync::Arc;

use crate::vault::VaultStore;

/// Where the vault that commands act on comes from.
pub(crate) trait VaultSource: Send + Sync + 'static {
    /// The vault commands act on now. A source that has several only changes which one this is while
    /// every one of them is locked.
    fn current(&self) -> &Arc<VaultStore>;

    /// Every store this source has made, for what must reach them all, such as stopping each store's
    /// document collection when the app exits.
    fn all(&self) -> Vec<Arc<VaultStore>>;
}

/// The only vault the device has, as before: a source whose current store never changes.
pub(crate) struct SingleVault {
    store: Arc<VaultStore>,
}

impl VaultSource for SingleVault {
    fn current(&self) -> &Arc<VaultStore> {
        &self.store
    }

    fn all(&self) -> Vec<Arc<VaultStore>> {
        vec![Arc::clone(&self.store)]
    }
}

/// What the app manages and commands take (`State<'_, StoreHandle>`): a cheap handle that derefs to
/// the current store. Clones share the one source.
#[derive(Clone)]
pub(crate) struct StoreHandle {
    source: Arc<dyn VaultSource>,
}

impl StoreHandle {
    pub(crate) fn new(source: impl VaultSource) -> Self {
        Self {
            source: Arc::new(source),
        }
    }

    /// A handle over a source the caller keeps a share of (the document worker holds the same one).
    pub(crate) fn from_source(source: Arc<dyn VaultSource>) -> Self {
        Self { source }
    }

    /// A handle fixed to the store that is current NOW. A command takes one at its start
    /// (`let store = store.pin();`, put there by the codemod), so every step of it, before and after
    /// an `await`, acts on the same vault even if the screen switches meanwhile: a command that
    /// began on vault A never finishes on vault B.
    pub(crate) fn pin(&self) -> Self {
        Self::single(Arc::clone(self.arc()))
    }

    /// A handle for the one vault the device has.
    pub(crate) fn single(store: Arc<VaultStore>) -> Self {
        Self::new(SingleVault { store })
    }

    /// The current store as the `Arc` the old `State<Arc<VaultStore>>::inner()` gave, for the calls
    /// that take `&Arc<VaultStore>` (`run_blocking`, `after_open`) or clone it into a worker.
    pub(crate) fn arc(&self) -> &Arc<VaultStore> {
        self.source.current()
    }

    /// Every store the source has made (see [`VaultSource::all`]).
    pub(crate) fn all(&self) -> Vec<Arc<VaultStore>> {
        self.source.all()
    }
}

impl Deref for StoreHandle {
    type Target = Arc<VaultStore>;

    fn deref(&self) -> &Arc<VaultStore> {
        self.source.current()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn given_a_single_vault_when_the_handle_is_used_then_it_is_that_store_every_time() {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(VaultStore::new(temp.path().join("vault")));
        let handle = StoreHandle::single(Arc::clone(&store));
        // Derefs to the same Arc the app managed before: commands see no difference.
        assert!(Arc::ptr_eq(&*handle, &store));
        assert!(Arc::ptr_eq(&*handle.clone(), &store));
        let all = handle.all();
        assert_eq!(all.len(), 1);
        assert!(Arc::ptr_eq(&all[0], &store));
        // Method calls reach the store through the handle.
        assert!(handle.status().is_ok());
    }

    /// A source with two stores that can change which is current, to see the handle follow it. It is
    /// shared with the test through an `Arc`, which is how a slot-aware source will be switched.
    struct Two {
        stores: [Arc<VaultStore>; 2],
        current: std::sync::atomic::AtomicUsize,
    }

    struct SharedTwo(Arc<Two>);

    impl VaultSource for SharedTwo {
        fn current(&self) -> &Arc<VaultStore> {
            let index = self.0.current.load(std::sync::atomic::Ordering::Acquire);
            &self.0.stores[index]
        }

        fn all(&self) -> Vec<Arc<VaultStore>> {
            self.0.stores.iter().map(Arc::clone).collect()
        }
    }

    #[test]
    fn given_a_source_that_changes_its_current_store_when_a_handle_is_used_then_it_follows() {
        let temp = tempfile::tempdir().unwrap();
        let first = Arc::new(VaultStore::new(temp.path().join("one")));
        let second = Arc::new(VaultStore::new(temp.path().join("two")));
        let two = Arc::new(Two {
            stores: [Arc::clone(&first), Arc::clone(&second)],
            current: std::sync::atomic::AtomicUsize::new(0),
        });
        let handle = StoreHandle::new(SharedTwo(Arc::clone(&two)));
        let shared = handle.clone();
        assert!(Arc::ptr_eq(&*handle, &first));
        // A clone shares the source, so a change shows through both.
        two.current.store(1, std::sync::atomic::Ordering::Release);
        assert!(Arc::ptr_eq(&*handle, &second));
        assert!(Arc::ptr_eq(&*shared, &second));
        assert_eq!(handle.all().len(), 2);
    }

    #[test]
    fn given_a_pinned_handle_when_the_source_switches_then_the_pin_keeps_its_store() {
        let temp = tempfile::tempdir().unwrap();
        let first = Arc::new(VaultStore::new(temp.path().join("one")));
        let second = Arc::new(VaultStore::new(temp.path().join("two")));
        let two = Arc::new(Two {
            stores: [Arc::clone(&first), Arc::clone(&second)],
            current: std::sync::atomic::AtomicUsize::new(0),
        });
        let handle = StoreHandle::from_source(Arc::new(SharedTwo(Arc::clone(&two))));
        let pinned = handle.pin();
        two.current.store(1, std::sync::atomic::Ordering::Release);
        assert!(Arc::ptr_eq(&*handle, &second));
        assert!(
            Arc::ptr_eq(&*pinned, &first),
            "a pin does not follow the switch"
        );
        assert!(Arc::ptr_eq(&*pinned.pin(), &first));
    }

    /// Every command takes the store through the handle: a command that still takes
    /// `State<'_, Arc<VaultStore>>` (or reads it with `app.state::<Arc<VaultStore>>()`) would keep
    /// working only while the device has one vault, and an app or test that still manages the bare
    /// `Arc<VaultStore>` would panic at the first command (the extraction acceptance test did). The
    /// scan covers every source file under `src/`, ignores white space and line breaks, and accepts
    /// any lifetime name and any path before `Arc` and `VaultStore`. Run
    /// `scripts/vault-store-handle-codemod.py` to fix a command.
    #[test]
    fn no_source_file_takes_or_manages_the_store_directly() {
        let mut offences = Vec::new();
        let mut folders = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(folder) = folders.pop() {
            for item in std::fs::read_dir(&folder).unwrap() {
                let path = item.unwrap().path();
                if path.is_dir() {
                    folders.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && path
                        .file_name()
                        .is_some_and(|name| name != "vault_source.rs")
                {
                    let source = std::fs::read_to_string(&path).unwrap();
                    if let Some(found) = takes_store_directly(&source) {
                        offences.push(format!("{}: {found}", path.display()));
                    }
                }
            }
        }
        assert!(
            offences.is_empty(),
            "run scripts/vault-store-handle-codemod.py (and wrap a managed store in \
             StoreHandle::single): {offences:#?}"
        );
    }

    /// A command that takes the handle pins it first, so an `await` in the middle of it cannot move
    /// it to another vault. Run `scripts/vault-store-handle-codemod.py` to add the line.
    #[test]
    fn every_command_pins_the_store_before_anything_else() {
        let mut offences = Vec::new();
        let mut folders = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(folder) = folders.pop() {
            for item in std::fs::read_dir(&folder).unwrap() {
                let path = item.unwrap().path();
                if path.is_dir() {
                    folders.push(path);
                } else if path.extension().is_some_and(|ext| ext == "rs")
                    && path
                        .file_name()
                        .is_some_and(|name| name != "vault_source.rs")
                {
                    let source = std::fs::read_to_string(&path).unwrap();
                    offences.extend(
                        unpinned_commands(&source)
                            .into_iter()
                            .map(|name| format!("{}: {name}", path.display())),
                    );
                }
            }
        }
        assert!(
            offences.is_empty(),
            "no `let store = store.pin();` first: {offences:#?}"
        );
    }

    #[test]
    fn the_pin_scan_finds_a_command_without_the_pin_and_accepts_one_with_it() {
        let pinned = "async fn a(store: State<'_, StoreHandle>) -> R {\n    let store = store.pin();\n    run(store.arc()).await\n}";
        let bare = "async fn b(\n    store: State<'_, StoreHandle>,\n    x: u8,\n) -> R {\n    run(store.arc()).await\n}";
        let late = "fn c(vault: State<'_, StoreHandle>) -> R {\n    let n = 1;\n    let vault = vault.pin();\n    n\n}";
        let pathed = "async fn e(on: bool, store: tauri::State<'_, StoreHandle>) -> R {\n    let store = store.pin();\n    on\n}";
        let pathed_bare =
            "async fn f(on: bool, store: tauri::State<'_, StoreHandle>) -> R {\n    on\n}";
        assert!(unpinned_commands(pathed).is_empty());
        assert_eq!(unpinned_commands(pathed_bare), vec!["f".to_owned()]);
        let other = "fn d(picks: State<'_, Arc<PendingPicks>>) -> R {\n    picks.clear()\n}";
        assert!(unpinned_commands(pinned).is_empty());
        assert_eq!(unpinned_commands(bare), vec!["b".to_owned()]);
        assert_eq!(unpinned_commands(late), vec!["c".to_owned()]);
        assert!(unpinned_commands(other).is_empty());
    }

    /// The functions in `source` that take `State<'_, StoreHandle>` and do not begin with
    /// `let <name> = <name>.pin();` for that parameter.
    fn unpinned_commands(source: &str) -> Vec<String> {
        let mut found = Vec::new();
        for (at, _) in source.match_indices("fn ") {
            let rest = &source[at + 3..];
            let Some(open) = rest.find('(') else { continue };
            let name = rest[..open].trim();
            if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            // The parameter list, up to its matching parenthesis.
            let mut depth = 0usize;
            let mut close = None;
            for (index, c) in rest[open..].char_indices() {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            close = Some(open + index);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            let Some(close) = close else { continue };
            let params: String = rest[open + 1..close].split_whitespace().collect();
            let Some(type_at) = params.find("State<'_,StoreHandle>") else {
                continue;
            };
            // The name before the colon, with an optional `tauri::` in front of the type.
            let before = params[..type_at].trim_end_matches("tauri::");
            let param = before
                .trim_end_matches(':')
                .rsplit(',')
                .next()
                .unwrap_or("")
                .trim();
            // The body starts at the first `{` after the signature.
            let Some(brace) = rest[close..].find('{') else {
                continue;
            };
            let body: String = rest[close + brace + 1..]
                .chars()
                .filter(|c| !c.is_whitespace())
                .take(60)
                .collect();
            let wanted = format!("let{param}={param}.pin();");
            if !body.starts_with(&wanted) {
                found.push(name.to_owned());
            }
        }
        found
    }

    #[test]
    fn the_scan_finds_every_spelling_of_the_old_type_and_leaves_the_new_one_alone() {
        for old in [
            "fn f(store: State<'_, Arc<VaultStore>>) {}",
            "fn f(store: State<'a,Arc<crate::vault::VaultStore>>) {}",
            "fn f(store: State<\n    '_,\n    std::sync::Arc<vault::VaultStore>,\n>) {}",
            "fn f(store: State<Arc<VaultStore>>) {}",
            "let s = app.state::<Arc<VaultStore>>();",
            "let s = app . state :: < Arc < VaultStore > > ();",
            "tauri::test::mock_builder().manage(Arc::clone(&store)).build()",
            "app.manage(Arc::new(VaultStore::new(root)));",
            "app.manage(\n    Arc::new(crate::vault::VaultStore::new(root)),\n);",
            "app.manage(store);",
        ] {
            assert!(takes_store_directly(old).is_some(), "{old}");
        }
        for fine in [
            "fn f(store: State<'_, StoreHandle>) {}",
            "fn f(picks: State<'_, Arc<PendingPicks>>) {}",
            "let s = app.state::<StoreHandle>();",
            "app.manage(StoreHandle::single(Arc::clone(&store)));",
            "app.manage(Arc::clone(&picks));",
            "fn g(store: &Arc<VaultStore>) {}",
        ] {
            assert!(takes_store_directly(fine).is_none(), "{fine}");
        }
    }

    /// The first spelling of the old type, or of a managed bare store, in `source`.
    fn takes_store_directly(source: &str) -> Option<String> {
        // No white space, and no trailing comma in a type argument list (`Arc<..>,>`).
        let text: String = source
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .replace(",>", ">");
        for opener in ["State<", "state::<"] {
            for (at, _) in text.match_indices(opener) {
                let rest = &text[at + opener.len()..];
                // The type argument ends at the first `>>`: `Arc<..VaultStore>>`.
                if let Some(end) = rest.find(">>") {
                    let argument = &rest[..end];
                    if argument.contains("Arc<") && argument.ends_with("VaultStore") {
                        return Some(format!("{opener}{argument}>>"));
                    }
                }
            }
        }
        for manage in [
            ".manage(Arc::clone(&store))",
            ".manage(store)",
            "manage(Arc::new(",
        ] {
            for (at, _) in text.match_indices(manage) {
                let rest = &text[at..text.len().min(at + 80)];
                if manage != "manage(Arc::new(" || rest.contains("VaultStore::new") {
                    return Some(manage.to_owned());
                }
            }
        }
        None
    }
}
