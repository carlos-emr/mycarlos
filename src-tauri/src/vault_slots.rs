//! The device's vaults as "vault slots" (#357, step 3): a [`VaultSource`] over the registry in
//! `vault_registry.rs`. Each slot has its own `VaultStore` rooted in its own folder, exactly as the one
//! store was before, and the source hands out the one the screen is on. Switching moves that pointer
//! and nothing else. There is still no UI, no unlock by name and no command that switches: those are
//! the next steps; this one is the source, the switch rule and the document worker.
//!
//! - **One store per slot, kept for the process.** The stores sit in an append-only list that is only
//!   ever added to, so [`VaultSource::current`] can lend a reference borrowed from the source with no
//!   lock and no unsafe code. A removed slot's store stays allocated, locked and unreachable.
//! - **Main is not forced into the list.** The registry says which vaults exist, and it may leave
//!   Main out: removing a vault frees its slot, and Main's vault is a vault like any other (the
//!   design's "set aside and start again"). Re-adding Main here would bring back, as an unnamed
//!   default, a vault the owner set aside. So the slots are exactly the registry's; only a device
//!   with NO registry (or one that cannot be read) is taken to have Main alone.
//! - **No registry file for one vault.** A device that has never added a vault has no `vaults.v1`; that
//!   reads as "the Main slot alone, the default", and nothing is written, so a one-vault install is
//!   byte for byte what it was. The file appears when a second vault is added (a later step).
//! - **A registry that cannot be read does not close the app.** The Main vault still opens, the file is
//!   left exactly as it is (it is never overwritten, see `Registry::save`), and [`VaultSlots::registry_problem`]
//!   says why, so that the recovery step can offer the owner the way back to the other vaults.
//! - **A switch** is only from a vault at rest to another at rest (nothing open, no key being derived,
//!   no import or export running; see [`VaultStore::is_at_rest`]), and it cancels the old one's work
//!   first. It never calls `stop_document_collection`, which is permanent and for app exit alone.
//!   **The unlock step must check that the store it opens is still `current()` when the key is
//!   installed**, because a command that resolved the old store just before a switch could otherwise
//!   open it behind the new one's back: one unlocked vault at a time is the rule this relies on.
//! - **One document worker** (Windows) ticks the current store once a second. A locked store has no
//!   session, so it would only return at its first check; one thread instead of one per vault keeps the
//!   thread count independent of the number of vaults.
//! - **Per-slot notifications.** Each slot's `configure_notifications` is given a ledger under that
//!   slot's own home, so two vaults never share one file, and a slot with no ledger starts with
//!   automatic checks off until its owner turns them on.
#![cfg_attr(not(test), allow(dead_code))]

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::vault::VaultStore;
use crate::vault_registry::{slot_home, slot_store_root, Registry, RegistryError, SlotId};
use crate::vault_source::VaultSource;

/// The notification ledger's file name in a slot's home (as it has always been for the Main slot).
const NOTIFICATIONS_FILE: &str = "document-notifications-v1.json";

/// Why a switch did not happen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SwitchError {
    /// The device has no such slot.
    UnknownSlot,
    /// A vault is open, a key is being derived or a transfer is running: lock it and let it finish.
    NotAtRest,
}

/// One slot's store, in an append-only list.
struct Node {
    slot: SlotId,
    store: Arc<VaultStore>,
    next: OnceLock<Box<Node>>,
}

impl Node {
    fn new(slot: SlotId, store: Arc<VaultStore>) -> Node {
        Node {
            slot,
            store,
            next: OnceLock::new(),
        }
    }
}

/// The vaults of a device, as a [`VaultSource`].
pub(crate) struct VaultSlots {
    data_dir: PathBuf,
    app_id: String,
    head: Node,
    /// The index (oldest first) of the slot the screen is on.
    current: AtomicUsize,
    /// Held to add a slot or switch, so the two cannot interleave.
    changing: Mutex<()>,
    registry_problem: Option<RegistryError>,
}

impl VaultSlots {
    /// The device's slots from the registry in `data_dir` (the app's local data folder). With no
    /// registry file it is the Main slot alone and nothing is written. The screen starts on the
    /// registry's default slot.
    pub(crate) fn open(data_dir: PathBuf, app_id: String) -> VaultSlots {
        let (registry, problem) = match Registry::load(&data_dir) {
            Ok(Some(registry)) => (Some(registry), None),
            Ok(None) => (None, None),
            Err(error) => (None, Some(error)),
        };
        let (slots, default) = match &registry {
            Some(registry) if !registry.slots().is_empty() => (
                registry.slots(),
                registry.default_slot().unwrap_or(SlotId::Main),
            ),
            _ => (vec![SlotId::Main], SlotId::Main),
        };
        let make = |slot: SlotId| Self::new_store(&data_dir, &app_id, slot);
        let mut iter = slots.iter();
        let first = *iter.next().expect("at least one slot");
        let head = Node::new(first, make(first));
        let mut tail = &head;
        for &slot in iter {
            let node = tail
                .next
                .get_or_init(|| Box::new(Node::new(slot, make(slot))));
            tail = &**node;
        }
        let current = slots.iter().position(|slot| *slot == default).unwrap_or(0);
        VaultSlots {
            data_dir,
            app_id,
            head,
            current: AtomicUsize::new(current),
            changing: Mutex::new(()),
            registry_problem: problem,
        }
    }

    /// A store for a slot, rooted in the slot's own folder, with its own notification ledger there.
    fn new_store(data_dir: &std::path::Path, app_id: &str, slot: SlotId) -> Arc<VaultStore> {
        let store = Arc::new(VaultStore::new(slot_store_root(data_dir, slot)));
        store.configure_notifications(
            slot_home(data_dir, slot).join(NOTIFICATIONS_FILE),
            app_id.to_owned(),
        );
        store
    }

    /// Why the registry could not be read, when it could not: the Main vault is then the only one
    /// offered and the file has been left alone.
    pub(crate) fn registry_problem(&self) -> Option<&RegistryError> {
        self.registry_problem.as_ref()
    }

    /// The slots, oldest first.
    pub(crate) fn slots(&self) -> Vec<SlotId> {
        self.nodes().map(|node| node.slot).collect()
    }

    /// The slot the screen is on.
    pub(crate) fn current_slot(&self) -> SlotId {
        self.node_at(self.current.load(Ordering::Acquire)).slot
    }

    /// The store of a slot, when the device has it.
    pub(crate) fn store_of(&self, slot: SlotId) -> Option<&Arc<VaultStore>> {
        self.nodes()
            .find(|node| node.slot == slot)
            .map(|n| &n.store)
    }

    fn nodes(&self) -> impl Iterator<Item = &Node> {
        std::iter::successors(Some(&self.head), |node| node.next.get().map(|n| &**n))
    }

    fn node_at(&self, index: usize) -> &Node {
        self.nodes().nth(index).unwrap_or(&self.head)
    }

    /// Adds a slot the registry now lists (a later step writes the registry, then calls this), with
    /// its own store and ledger. Adding one the device already has changes nothing.
    pub(crate) fn add_slot(&self, slot: SlotId) -> &Arc<VaultStore> {
        let _changing = self.changing.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(store) = self.store_of(slot) {
            return store;
        }
        let tail = self.nodes().last().expect("the list always has its head");
        let node = tail.next.get_or_init(|| {
            Box::new(Node::new(
                slot,
                Self::new_store(&self.data_dir, &self.app_id, slot),
            ))
        });
        &node.store
    }

    /// Moves the screen to another slot's vault. Both must be at rest; `stop_work` runs first, after
    /// the check and before the old store is locked, so whatever the app was doing for the old vault
    /// (picks, page views, text reads, the AI helper) is stopped as a lock stops it. A refusal
    /// BEFORE that point (an unknown slot, either vault not at rest) changes nothing. The one
    /// refusal after it (the old vault began something between the check and the move) has
    /// already run `stop_work` and locked the old vault: only the pointer is put back, and the new
    /// store is not checked again. Never stops the document collection for good (see the module note).
    pub(crate) fn switch(&self, slot: SlotId, stop_work: impl FnOnce()) -> Result<(), SwitchError> {
        let _changing = self.changing.lock().unwrap_or_else(|p| p.into_inner());
        let target = self
            .nodes()
            .position(|node| node.slot == slot)
            .ok_or(SwitchError::UnknownSlot)?;
        let from = self.current.load(Ordering::Acquire);
        if target == from {
            return Ok(());
        }
        let old = &self.node_at(from).store;
        let new = &self.node_at(target).store;
        if !old.is_at_rest() || !new.is_at_rest() {
            return Err(SwitchError::NotAtRest);
        }
        stop_work();
        old.lock();
        self.current.store(target, Ordering::Release);
        // Something may have begun on the old store between the check and the move. `stop_work` has
        // run and the old vault is locked; put the pointer back (the new store is not re-checked).
        if !old.is_at_rest() {
            self.current.store(from, Ordering::Release);
            return Err(SwitchError::NotAtRest);
        }
        Ok(())
    }

    /// One tick of the document worker, on the current store (see [`VaultStore::document_tick`]).
    /// `false` once the collection has been stopped for good.
    pub(crate) fn tick_documents(&self) -> bool {
        self.current().document_tick()
    }

    /// Starts the app's one document worker (Windows): a thread that ticks the current store once a
    /// second, holding the source only weakly, until the collection is stopped at exit.
    #[cfg(windows)]
    pub(crate) fn start_document_collection(self: &Arc<Self>) -> std::io::Result<()> {
        let weak = Arc::downgrade(self);
        std::thread::Builder::new()
            .name("document-checks".into())
            .spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let Some(slots) = weak.upgrade() else {
                    break;
                };
                if !slots.tick_documents() {
                    break;
                }
            })
            .map(|_| ())
    }
}

impl VaultSource for VaultSlots {
    fn current(&self) -> &Arc<VaultStore> {
        &self.node_at(self.current.load(Ordering::Acquire)).store
    }

    fn all(&self) -> Vec<Arc<VaultStore>> {
        self.nodes().map(|node| Arc::clone(&node.store)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::VaultStatus;
    use crate::vault_registry::{HashCost, FILE_NAME};
    use std::cell::Cell;
    use std::fs;
    use std::path::Path;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    fn slots_in(dir: &Path) -> VaultSlots {
        VaultSlots::open(dir.to_path_buf(), "FAKE.app".into())
    }

    /// A device whose registry lists Main and two more vaults, the last one the default.
    fn three_vault_device(dir: &Path) -> (SlotId, SlotId) {
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
        let second = registry.add_extra("Second").unwrap();
        let third = registry.add_extra("Third").unwrap();
        registry.set_default(third).unwrap();
        registry.save(dir).unwrap();
        (second, third)
    }

    fn make_vault(slots: &VaultSlots, slot: SlotId) {
        let store = slots.store_of(slot).unwrap();
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        store.lock();
    }

    #[test]
    fn given_no_registry_file_when_opened_then_main_alone_is_the_slot_and_nothing_is_written() {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        assert_eq!(slots.slots(), vec![SlotId::Main]);
        assert_eq!(slots.current_slot(), SlotId::Main);
        assert!(slots.registry_problem().is_none());
        assert_eq!(slots.all().len(), 1);
        // A one-vault device is byte for byte what it was: no registry, no lock file, no folders.
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
        // Main's ledger is where it has always been.
        assert_eq!(
            slots.current().notifications_ledger_path().unwrap(),
            temp.path()
                .join("vault-home")
                .join("document-notifications-v1.json")
        );
    }

    #[test]
    fn given_a_registry_with_three_vaults_when_opened_then_each_has_a_store_and_a_ledger_of_its_own(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        assert_eq!(slots.slots(), vec![SlotId::Main, second, third]);
        // The screen starts on the registry's default.
        assert_eq!(slots.current_slot(), third);
        assert!(Arc::ptr_eq(slots.current(), slots.store_of(third).unwrap()));
        let mut ledgers = Vec::new();
        for slot in slots.slots() {
            let ledger = slots
                .store_of(slot)
                .unwrap()
                .notifications_ledger_path()
                .unwrap();
            assert_eq!(
                ledger,
                slot_home(temp.path(), slot).join(NOTIFICATIONS_FILE)
            );
            ledgers.push(ledger);
        }
        ledgers.sort();
        ledgers.dedup();
        assert_eq!(ledgers.len(), 3, "no two vaults share a ledger");
    }

    #[test]
    fn given_a_registry_without_main_when_opened_then_main_is_not_added_back() {
        let temp = tempfile::tempdir().unwrap();
        let mut registry = Registry::new(HashCost::TEST).unwrap();
        let only = registry.add_extra("Only").unwrap();
        registry.save(temp.path()).unwrap();
        let slots = slots_in(temp.path());
        // The owner set Main's vault aside: it is not offered again as an unnamed default.
        assert_eq!(slots.slots(), vec![only]);
        assert_eq!(slots.current_slot(), only);
        assert!(slots.store_of(SlotId::Main).is_none());
    }

    #[test]
    fn given_a_session_mutex_poisoned_by_a_panic_when_asked_if_at_rest_then_it_reads_the_session() {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        let store = slots.current();
        store.test_poison_session();
        // No session was open when the holder panicked: at rest, not "busy" for ever.
        assert!(store.is_at_rest());
    }

    #[test]
    fn given_a_damaged_registry_when_opened_then_main_opens_and_the_file_is_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(FILE_NAME), b"scribble").unwrap();
        let slots = slots_in(temp.path());
        assert_eq!(slots.slots(), vec![SlotId::Main]);
        assert_eq!(slots.registry_problem(), Some(&RegistryError::Damaged));
        assert_eq!(fs::read(temp.path().join(FILE_NAME)).unwrap(), b"scribble");
    }

    #[test]
    fn given_two_vaults_when_switched_at_rest_then_commands_reach_the_other_and_work_is_stopped_once(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault(&slots, SlotId::Main);
        make_vault(&slots, second);
        // Start on Main (the third vault, the default, has nothing made yet and is at rest too).
        slots.switch(SlotId::Main, || {}).unwrap();
        let stopped = Cell::new(0);
        slots
            .switch(second, || stopped.set(stopped.get() + 1))
            .unwrap();
        assert_eq!(stopped.get(), 1);
        assert_eq!(slots.current_slot(), second);
        assert!(Arc::ptr_eq(
            slots.current(),
            slots.store_of(second).unwrap()
        ));
        // Switching to where it already is does nothing, and stops nothing.
        slots
            .switch(second, || stopped.set(stopped.get() + 1))
            .unwrap();
        assert_eq!(stopped.get(), 1);
        // The old vault is locked and the new one unlocks with its own passphrase.
        assert!(matches!(
            slots.store_of(SlotId::Main).unwrap().status(),
            Ok(VaultStatus::Locked)
        ));
        slots.current().unlock(PASSWORD).unwrap();
        assert!(matches!(
            slots.current().status(),
            Ok(VaultStatus::Unlocked)
        ));
    }

    #[test]
    fn given_a_vault_that_is_open_when_a_switch_is_asked_then_it_is_refused_and_nothing_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault(&slots, SlotId::Main);
        make_vault(&slots, second);
        slots.switch(SlotId::Main, || {}).unwrap();
        let ran = Cell::new(false);

        // The current vault is open.
        slots.current().unlock(PASSWORD).unwrap();
        assert_eq!(
            slots.switch(second, || ran.set(true)),
            Err(SwitchError::NotAtRest)
        );
        assert!(!ran.get(), "a refused switch stops nothing");
        assert_eq!(slots.current_slot(), SlotId::Main);
        assert!(matches!(
            slots.current().status(),
            Ok(VaultStatus::Unlocked)
        ));
        slots.current().lock();

        // The vault asked for is open (it should not be, but a switch must not make two).
        slots.store_of(second).unwrap().unlock(PASSWORD).unwrap();
        assert_eq!(
            slots.switch(second, || ran.set(true)),
            Err(SwitchError::NotAtRest)
        );
        assert!(!ran.get());
        assert_eq!(slots.current_slot(), SlotId::Main);
    }

    #[test]
    fn given_an_unknown_slot_when_a_switch_is_asked_then_it_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        let stranger = SlotId::Extra(uuid::Uuid::new_v4());
        assert_eq!(slots.switch(stranger, || {}), Err(SwitchError::UnknownSlot));
        assert_eq!(slots.current_slot(), SlotId::Main);
    }

    #[test]
    fn given_a_key_being_derived_when_a_switch_is_asked_then_it_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        slots.switch(SlotId::Main, || {}).unwrap();
        slots.current().test_hold_kdf(|| {
            assert_eq!(slots.switch(second, || {}), Err(SwitchError::NotAtRest));
        });
        assert_eq!(slots.switch(second, || {}), Ok(()));
    }

    #[test]
    fn given_a_new_slot_when_added_then_it_has_its_own_store_ledger_and_automatic_checks_off() {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        let new = SlotId::Extra(uuid::Uuid::new_v4());
        let store = Arc::clone(slots.add_slot(new));
        assert_eq!(slots.slots(), vec![SlotId::Main, new]);
        assert_eq!(slots.all().len(), 2);
        assert_eq!(
            store.notifications_ledger_path().unwrap(),
            slot_home(temp.path(), new).join(NOTIFICATIONS_FILE)
        );
        assert!(!store.automatic_collection_allowed());
        assert!(!slots.current().automatic_collection_allowed());
        // Adding it again returns the same store and adds nothing.
        assert!(Arc::ptr_eq(slots.add_slot(new), &store));
        assert_eq!(slots.all().len(), 2);
        // Adding a slot does not move the screen.
        assert_eq!(slots.current_slot(), SlotId::Main);
    }

    #[test]
    fn given_the_document_worker_when_a_switch_happens_then_it_ticks_the_new_vault_and_never_stops()
    {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        slots.switch(SlotId::Main, || {}).unwrap();
        assert!(slots.tick_documents());
        slots.switch(second, || {}).unwrap();
        // The old vault's collection was cancelled by its lock, not stopped for good.
        assert!(slots.store_of(SlotId::Main).unwrap().document_tick());
        assert!(slots.tick_documents());
        // At exit every store's collection is stopped and the worker ends.
        for store in slots.all() {
            store.stop_document_collection();
        }
        assert!(!slots.tick_documents());
    }

    #[test]
    fn given_two_vaults_when_one_locks_or_the_screen_switches_then_only_the_old_ones_resume_state_is_dropped(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        slots.switch(SlotId::Main, || {}).unwrap();
        let (a, b) = (
            Arc::clone(slots.store_of(SlotId::Main).unwrap()),
            Arc::clone(slots.store_of(second).unwrap()),
        );
        a.test_hold_resume_cache();
        b.test_hold_resume_cache();
        assert!(a.test_has_resume_cache() && b.test_has_resume_cache());
        // A lock of A drops A's cache and leaves B's alone.
        a.lock();
        assert!(!a.test_has_resume_cache());
        assert!(b.test_has_resume_cache());
        // A switch from A to B (A's lock) drops A's cache and leaves B's own where it was.
        a.test_hold_resume_cache();
        slots.switch(second, || {}).unwrap();
        assert!(
            !a.test_has_resume_cache(),
            "the old vault's cache is gone at the switch"
        );
        assert!(b.test_has_resume_cache());
        // Not covered here: that a cycle binds its cache to its own vault id (`ResumeCache::bind`,
        // tested in document_collection_pickup) and that the worker ticks the store that is current
        // (`document_tick`, above). The Windows tick itself runs only on Windows.
    }
}
