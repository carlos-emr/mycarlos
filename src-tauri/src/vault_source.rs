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
#![cfg_attr(not(test), allow(dead_code))]

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

    /// Every command takes the store through the handle: a command that still takes
    /// `State<'_, Arc<VaultStore>>` would keep working only while the device has one vault, so it
    /// fails the build here. Run `scripts/vault-store-handle-codemod.py` to fix one.
    #[test]
    fn no_command_takes_the_store_directly() {
        let source = include_str!("lib.rs");
        for (number, line) in source.lines().enumerate() {
            for old in [
                "State<'_, Arc<VaultStore>>",
                "State<Arc<VaultStore>>",
                "state::<Arc<VaultStore>>",
            ] {
                assert!(
                    !line.contains(old),
                    "lib.rs line {} takes the store directly ({old}): run scripts/vault-store-handle-codemod.py",
                    number + 1
                );
            }
        }
    }
}
