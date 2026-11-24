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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::unlock_plan::{run_plan, RealOutcome};
use crate::vault::{derive_decoy, VaultError, VaultStore};
use crate::vault_registry::{
    slot_home, slot_store_root, HashCost, Registry, RegistryError, SlotId, UnlockPlan,
};
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
    /// The registry as read at start (or, when there is none or it cannot be read, Main alone with
    /// no name, in memory only and never saved): what a typed name is looked up in.
    registry: Mutex<Registry>,
    /// Set while an unlock by name is under way: one per device at a time (see `unlock_named`).
    named_attempt: AtomicBool,
}

/// Held by the one unlock by name that is under way; releases the device on every path, a panic
/// included.
struct NamedAttempt<'a>(&'a AtomicBool);

impl Drop for NamedAttempt<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
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
        // A registry that cannot be used is not shown to the unlock screen as anything: no typed
        // name matches, as on a device with one vault.
        let registry = registry.unwrap_or_else(|| {
            Registry::with_main(HashCost::DEVICE).expect("the device cost is acceptable")
        });
        VaultSlots {
            registry: Mutex::new(registry),
            data_dir,
            app_id,
            head,
            current: AtomicUsize::new(current),
            changing: Mutex::new(()),
            registry_problem: problem,
            named_attempt: AtomicBool::new(false),
        }
    }

    /// Takes the device's one place for an unlock by name, or `None` when one is already under way.
    fn begin_named_attempt(&self) -> Option<NamedAttempt<'_>> {
        self.named_attempt
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .ok()
            .map(|_| NamedAttempt(&self.named_attempt))
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

    /// What an unlock attempt with a typed name must do (`Registry::plan_for`).
    pub(crate) fn plan_for(&self, typed: &str) -> UnlockPlan {
        self.registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .plan_for(typed)
    }

    /// Unlocks the vault a typed name and passphrase stand for, makes it the current one and gives
    /// its store. **Every named attempt makes the same derivations** (`UnlockPlan`, `run_plan`): one
    /// per vault the name matched, then decoys up to the cap, with no early exit, so the time says
    /// nothing about the name; an unknown name, a name whose vault was never made and a wrong
    /// passphrase are all `WrongPassphrase`.
    ///
    /// **One unlock by name at a time per device, taken before the name is looked up:** a second
    /// attempt that overlaps gets `Busy` whatever it typed. Without that, two overlapping attempts
    /// would answer `Busy` for a name that exists (its vault's derivation is already running) and
    /// `WrongPassphrase` for one that does not, which would tell a name apart without a passphrase.
    /// For the same reason a matched vault that cannot be read or derived for now (it is open, or
    /// another derivation is running on it) is the same `WrongPassphrase` as an unknown name. Only
    /// the refusal AFTER the right passphrase opened a vault is `Busy` again (the vault the screen
    /// is on, or a transfer, is not at rest, `unlock_into`): whoever has both the name and the
    /// passphrase is told. Derivations happen with no lock held; only the final install and the
    /// move of the pointer are done under [`unlock_into`]'s mutex.
    pub(crate) fn unlock_named(
        &self,
        typed: &str,
        passphrase: &str,
        stop_work: impl FnOnce(),
    ) -> Result<Arc<VaultStore>, VaultError> {
        let Some(_attempt) = self.begin_named_attempt() else {
            return Err(VaultError::Busy);
        };
        let plan = self.plan_for(typed);
        // Read what every vault of the device keeps on disk BEFORE any derivation, whatever the name
        // matched, so the attempt's disk reads do not grow with the matches (decoys read nothing).
        let mut pre_read: Vec<_> = self
            .nodes()
            .map(|node| (node.slot, node.store.pre_read_headers()))
            .collect();
        let run = run_plan(
            &plan,
            |slot| {
                let Some(store) = self.store_of(slot) else {
                    return RealOutcome::NotThere;
                };
                let Some(at) = pre_read.iter().position(|(s, _)| *s == slot) else {
                    return RealOutcome::NotThere;
                };
                // A vault that cannot be read for now (open, busy) is "not there": the answer is
                // the same as for a name that matched nothing.
                let Ok(headers) = pre_read.swap_remove(at).1 else {
                    return RealOutcome::NotThere;
                };
                match store.derive_for_unlock(passphrase, headers) {
                    Ok(derived) => RealOutcome::Derived {
                        cost: derived.cost(),
                        opened: Some(derived),
                    },
                    // The passphrase did not open it: a derivation was made, at the cost every
                    // header has (`valid_kdf_config` allows no other), and nothing is held.
                    Err(failure) if failure.derived => RealOutcome::Derived {
                        cost: crate::vault::DeriveCost::DECOY,
                        opened: None,
                    },
                    Err(_) => RealOutcome::NotThere,
                }
            },
            |cost| {
                // A decoy that fails to run still counts as run; the result is nothing.
                let _ = derive_decoy(passphrase, cost);
            },
        );
        match run.winner {
            Some((slot, derived)) => self.unlock_into(slot, derived, stop_work),
            None => Err(VaultError::WrongPassphrase),
        }
    }

    /// Installs a key derived for `slot` and makes `slot` the current vault, when both the vault
    /// the screen is on and `slot`'s are at rest (or `slot` already is the screen's). Under the
    /// mutex a switch and an add also take, so **a key is only ever installed in the vault the
    /// screen is moving to, and at most one vault is open**. A refusal (`Busy`) opens nothing and
    /// drops the key (it is zeroized with the value). Order: stop the app's work for the old vault,
    /// lock it, install the new key, move the pointer; and if the old vault began something between
    /// the check and the install, the new vault is locked again and the pointer stays.
    pub(crate) fn unlock_into(
        &self,
        slot: SlotId,
        derived: crate::vault::DerivedUnlock,
        stop_work: impl FnOnce(),
    ) -> Result<Arc<VaultStore>, VaultError> {
        let _changing = self.changing.lock().unwrap_or_else(|p| p.into_inner());
        let Some(target) = self.nodes().position(|node| node.slot == slot) else {
            return Err(VaultError::Storage);
        };
        let from = self.current.load(Ordering::Acquire);
        let new = Arc::clone(&self.node_at(target).store);
        if target == from {
            new.install_unlock(derived)?;
            return Ok(new);
        }
        let old = &self.node_at(from).store;
        if !old.is_at_rest() || !new.is_at_rest() {
            return Err(VaultError::Busy);
        }
        stop_work();
        old.lock();
        new.install_unlock(derived)?;
        if !old.is_at_rest() {
            new.lock();
            return Err(VaultError::Busy);
        }
        self.current.store(target, Ordering::Release);
        Ok(new)
    }

    /// Makes a new vault the owner will find by `name`, creates it with `passphrase` and its first
    /// person, and makes it the vault the screen is on (#357 4c). The order is the registry first,
    /// then the vault: **the entry is written under the device lock (`Registry::update`, which
    /// refuses a damaged or newer file untouched), the in-memory registry is read again so the name
    /// finds the vault at once, the slot's store is added, the vault is created in it, and only then
    /// does the screen move.** If the vault cannot be created (a weak passphrase, no room) the entry
    /// is taken out again by a second `update` and the screen stays where it was; a folder the
    /// attempt half made is left for `unregistered_slot_folders` to report, and the store the list
    /// gained stays in memory until the app restarts, reachable by nothing (no name or slot finds
    /// it).
    ///
    /// Nothing is written unless the screen's vault is at rest (an add opens a vault and moves the
    /// screen: it would otherwise leave two open), and one add or unlock by name runs at a time per
    /// device, so an add cannot overlap a guess. An add is not a guess and is not counted (the
    /// command refuses it while a wait is running). A name already shared by four vaults is
    /// `AlreadyExists`, a name that cannot be a name is `Invalid`, and a registry that cannot be read
    /// or written is `Storage`; the typed name is hashed (never stored) by the registry.
    pub(crate) fn add_vault(
        &self,
        name: &str,
        passphrase: &str,
        initial_profile_name: &str,
        now_ms: u64,
        stop_work: impl FnOnce(),
    ) -> Result<Arc<VaultStore>, VaultError> {
        let Some(_attempt) = self.begin_named_attempt() else {
            return Err(VaultError::Busy);
        };
        // A passphrase or name `create` would refuse registers nothing.
        crate::vault::check_new_vault_inputs(passphrase, initial_profile_name)?;
        // Whatever the registry could not be read as at start is left exactly as it is.
        if self.registry_problem.is_some() {
            return Err(VaultError::Storage);
        }
        if !self.current().is_at_rest() {
            return Err(VaultError::Busy);
        }
        let slot = Registry::update(
            &self.data_dir,
            || Registry::with_main(HashCost::DEVICE),
            |registry| registry.add_extra(name),
        )
        .map_err(registry_refusal)?;
        self.reload_registry();
        let store = Arc::clone(self.add_slot(slot));
        if let Err(error) = store.create(passphrase, initial_profile_name, now_ms) {
            // The entry goes again: a vault that was never made must not be a name that matches.
            let _ = Registry::update(
                &self.data_dir,
                || Registry::with_main(HashCost::DEVICE),
                |registry| registry.remove(slot),
            );
            self.reload_registry();
            return Err(error);
        }
        let _changing = self.changing.lock().unwrap_or_else(|p| p.into_inner());
        let target = self
            .nodes()
            .position(|node| node.slot == slot)
            .ok_or(VaultError::Storage)?;
        let from = self.current.load(Ordering::Acquire);
        if !self.node_at(from).store.is_at_rest() {
            // The old vault began something while the new one was being made. The new vault
            // exists and is registered; it is locked again, and the screen stays where it was.
            store.lock();
            return Err(VaultError::Busy);
        }
        stop_work();
        self.node_at(from).store.lock();
        self.current.store(target, Ordering::Release);
        Ok(store)
    }

    /// Reads the registry again from disk, so that what was just written (or taken out) is what a
    /// typed name is matched against from now on. A registry that cannot be read leaves the one in
    /// memory as it is.
    fn reload_registry(&self) {
        if let Ok(Some(registry)) = Registry::load(&self.data_dir) {
            *self.registry.lock().unwrap_or_else(|p| p.into_inner()) = registry;
        }
    }

    /// Moves the screen back to the registry's default vault after a lock (Ben's Q2: a locked
    /// screen starts on the default), running `stop_work` first if it moves. Nothing happens when it
    /// is already there, or the default is not a slot this device has. A refusal leaves it where it
    /// was, and the next lock tries again.
    pub(crate) fn return_to_default(&self, stop_work: impl FnOnce()) {
        let default = self
            .registry
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .default_slot();
        if let Some(default) = default.filter(|slot| *slot != self.current_slot()) {
            let _ = self.switch(default, stop_work);
        }
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

/// What a registry refusal is to the app: the owner's own mistakes keep their words, and everything
/// about the file (damaged, newer, unreadable) is the one storage refusal, never named.
fn registry_refusal(error: RegistryError) -> VaultError {
    match error {
        RegistryError::Name(_) => VaultError::Invalid,
        RegistryError::NameTaken => VaultError::AlreadyExists,
        _ => VaultError::Storage,
    }
}

impl VaultSource for VaultSlots {
    fn current(&self) -> &Arc<VaultStore> {
        &self.node_at(self.current.load(Ordering::Acquire)).store
    }

    fn all(&self) -> Vec<Arc<VaultStore>> {
        self.nodes().map(|node| Arc::clone(&node.store)).collect()
    }

    fn return_to_default(&self, stop_work: &mut dyn FnMut()) {
        VaultSlots::return_to_default(self, stop_work);
    }

    fn unlock_named(
        &self,
        name: &str,
        passphrase: &str,
        stop_work: &mut dyn FnMut(),
    ) -> Result<Arc<VaultStore>, VaultError> {
        VaultSlots::unlock_named(self, name, passphrase, stop_work)
    }

    fn add_vault(
        &self,
        name: &str,
        passphrase: &str,
        initial_profile_name: &str,
        now_ms: u64,
        stop_work: &mut dyn FnMut(),
    ) -> Result<Arc<VaultStore>, VaultError> {
        VaultSlots::add_vault(
            self,
            name,
            passphrase,
            initial_profile_name,
            now_ms,
            stop_work,
        )
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

    const OTHER_PASSWORD: &str = "lantern-orbit-willow-cascade-572";

    /// Makes a vault in `slot` with its own passphrase and locks it.
    fn make_vault_with(slots: &VaultSlots, slot: SlotId, passphrase: &str) {
        let store = slots.store_of(slot).unwrap();
        store.create(passphrase, "FAKE Person", 1).unwrap();
        store.lock();
    }

    fn reset_counters() {
        crate::vault::DERIVATIONS.with(|count| count.set(0));
        crate::vault::HEADER_READS.with(|count| count.set(0));
    }

    fn counters() -> (usize, usize) {
        (
            crate::vault::DERIVATIONS.with(Cell::get),
            crate::vault::HEADER_READS.with(Cell::get),
        )
    }

    fn open_vaults(slots: &VaultSlots) -> Vec<SlotId> {
        slots
            .slots()
            .into_iter()
            .filter(|slot| {
                !slots.store_of(*slot).unwrap().is_at_rest()
                    && matches!(
                        slots.store_of(*slot).unwrap().status(),
                        Ok(VaultStatus::Unlocked)
                    )
            })
            .collect()
    }

    #[test]
    fn given_two_vaults_with_different_passphrases_when_unlocked_by_name_then_the_right_one_opens()
    {
        let temp = tempfile::tempdir().unwrap();
        let (second, third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        // The screen starts on the default (the third vault, none made yet).
        assert_eq!(slots.current_slot(), third);
        let stopped = Cell::new(0);

        reset_counters();
        let opened = slots
            .unlock_named("  SECOND ", OTHER_PASSWORD, || {
                stopped.set(stopped.get() + 1)
            })
            .unwrap();
        assert!(Arc::ptr_eq(&opened, slots.store_of(second).unwrap()));
        assert_eq!(slots.current_slot(), second);
        assert_eq!(open_vaults(&slots), vec![second]);
        assert_eq!(stopped.get(), 1, "the old vault's work was stopped once");
        // One real derivation and the decoys: four, whatever the name matched; every vault's header
        // files were read once, before any derivation.
        assert_eq!(counters(), (DUPLICATE_NAME_CAP_FOR_TEST, 3));
    }

    const DUPLICATE_NAME_CAP_FOR_TEST: usize = crate::vault_registry::DUPLICATE_NAME_CAP;

    #[test]
    fn given_a_wrong_passphrase_or_an_unknown_name_when_unlocked_by_name_then_the_work_and_the_answer_are_the_same(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        let before = slots.current_slot();
        for (name, passphrase) in [
            ("second", "a wrong passphrase 3318"),
            ("nobody", OTHER_PASSWORD),
            ("nobody", "a wrong passphrase 3318"),
            // A name whose vault was never made ("Third" is registered, its folder is empty).
            ("third", OTHER_PASSWORD),
        ] {
            reset_counters();
            let outcome = slots.unlock_named(name, passphrase, || {});
            assert!(
                matches!(outcome, Err(VaultError::WrongPassphrase)),
                "{name}"
            );
            assert_eq!(
                counters(),
                (DUPLICATE_NAME_CAP_FOR_TEST, 3),
                "{name} with {passphrase}"
            );
            assert!(open_vaults(&slots).is_empty());
            assert_eq!(slots.current_slot(), before);
        }
    }

    #[test]
    fn given_0_1_and_2_vaults_with_the_name_when_unlocked_then_derivations_and_header_reads_are_equal(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
        let first = registry.add_extra("Sam").unwrap();
        let second = registry.add_extra("Sam").unwrap();
        let lone = registry.add_extra("Lone").unwrap();
        registry.save(temp.path()).unwrap();
        let slots = slots_in(temp.path());
        make_vault_with(&slots, first, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        make_vault_with(&slots, lone, "orchard-tundra-violin-meadow-215");
        let mut seen = Vec::new();
        // 0 matches, 1 match, 2 matches; each with a wrong passphrase so nothing opens or moves.
        for name in ["Nobody", "Lone", "SAM"] {
            reset_counters();
            assert!(slots
                .unlock_named(name, "wrong 99887766 passphrase", || {})
                .is_err());
            seen.push(counters());
        }
        assert_eq!(seen, vec![(DUPLICATE_NAME_CAP_FOR_TEST, 4); 3]);
        // Two vaults share "Sam": the passphrase of either opens THAT one.
        let opened = slots.unlock_named("sam", OTHER_PASSWORD, || {}).unwrap();
        assert!(Arc::ptr_eq(&opened, slots.store_of(second).unwrap()));
    }

    #[test]
    fn given_a_named_attempt_in_flight_when_another_comes_then_it_is_busy_whatever_the_name() {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        let held = slots.begin_named_attempt().expect("the device is free");
        assert!(
            slots.begin_named_attempt().is_none(),
            "one attempt at a time"
        );
        reset_counters();
        // A name that exists, one that does not, with the right and with a wrong passphrase: the
        // same answer, so an overlapping attempt tells no name apart.
        for (name, passphrase) in [
            ("second", OTHER_PASSWORD),
            ("second", "a wrong passphrase 3318"),
            ("nobody", OTHER_PASSWORD),
            ("nobody", "a wrong passphrase 3318"),
            ("", PASSWORD),
        ] {
            assert!(
                matches!(
                    slots.unlock_named(name, passphrase, || {}),
                    Err(VaultError::Busy)
                ),
                "{name:?} with {passphrase}"
            );
        }
        assert_eq!(
            counters(),
            (0, 0),
            "a refused attempt reads and derives nothing"
        );
        assert!(open_vaults(&slots).is_empty());
        // Once the first is over the device is free again, and the answers are the usual ones.
        drop(held);
        assert!(matches!(
            slots.unlock_named("nobody", "a wrong passphrase 3318", || {}),
            Err(VaultError::WrongPassphrase)
        ));
        assert!(slots.unlock_named("second", OTHER_PASSWORD, || {}).is_ok());
    }

    #[test]
    fn given_an_attempt_that_ends_by_any_path_when_another_comes_then_the_device_is_free() {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, second, OTHER_PASSWORD);
        // A refused one, a successful one, and then another.
        assert!(slots
            .unlock_named("second", "wrong 1234 passphrase", || {})
            .is_err());
        assert!(slots.begin_named_attempt().is_some());
        assert!(slots.unlock_named("second", OTHER_PASSWORD, || {}).is_ok());
        assert!(slots.begin_named_attempt().is_some());
        // A panic while it is held releases it too.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _held = slots.begin_named_attempt().unwrap();
            panic!("FAKE: an attempt that panics");
        }));
        assert!(slots.begin_named_attempt().is_some());
    }

    #[test]
    fn given_a_matched_vault_that_cannot_be_read_now_when_unlocked_by_name_then_it_is_wrong_passphrase_like_an_unknown_name(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, second, OTHER_PASSWORD);
        // Another derivation is running on the vault the name matches (even with the right
        // passphrase): not `Busy`, which would tell the name exists.
        let held = slots.store_of(second).unwrap().hold_kdf_work_for_test();
        let existing = slots.unlock_named("second", OTHER_PASSWORD, || {});
        let unknown = slots.unlock_named("nobody", OTHER_PASSWORD, || {});
        assert!(matches!(existing, Err(VaultError::WrongPassphrase)));
        assert!(matches!(unknown, Err(VaultError::WrongPassphrase)));
        assert!(open_vaults(&slots).is_empty());
        drop(held);
        assert!(slots.unlock_named("second", OTHER_PASSWORD, || {}).is_ok());
    }

    #[test]
    fn given_the_vault_the_name_matches_is_the_open_one_when_unlocked_by_name_then_it_is_wrong_passphrase_like_an_unknown_name(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        slots.current().unlock(PASSWORD).unwrap();
        // The empty name is the default vault, which is open: it cannot be read for an unlock.
        let open = slots.unlock_named("", PASSWORD, || {});
        let unknown = slots.unlock_named("nobody", PASSWORD, || {});
        assert!(matches!(open, Err(VaultError::WrongPassphrase)));
        assert!(matches!(unknown, Err(VaultError::WrongPassphrase)));
        assert_eq!(open_vaults(&slots), vec![SlotId::Main]);
    }

    #[test]
    fn given_the_slot_machinery_when_read_then_it_never_touches_the_notice_keys() {
        // A wrong named attempt (and a right one) must not wipe another vault's notice keys: only the
        // command, after the unlock succeeded, reaches `notice_key::after_open` (see lib.rs). The
        // notice-key store is a process-wide singleton that a unit test cannot install, so this
        // guards the structure; PR 5 makes the keys per vault and adds the behavior test.
        for (file, text) in [
            ("vault_slots.rs", include_str!("vault_slots.rs")),
            ("vault_source.rs", include_str!("vault_source.rs")),
        ] {
            let production = text.split_once("\n#[cfg(test)]\nmod tests {").unwrap().0;
            assert!(
                !production.contains("notice_key"),
                "{file} touches the notice keys"
            );
        }
    }

    #[test]
    fn given_an_empty_name_when_unlocked_then_it_is_the_default_vault_with_one_derivation() {
        let temp = tempfile::tempdir().unwrap();
        let (_second, third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, third, PASSWORD);
        reset_counters();
        let opened = slots.unlock_named("", PASSWORD, || {}).unwrap();
        assert!(Arc::ptr_eq(&opened, slots.store_of(third).unwrap()));
        assert_eq!(counters().0, 1);
        assert_eq!(open_vaults(&slots), vec![third]);
    }

    #[test]
    fn given_a_vault_that_is_open_when_another_is_unlocked_by_name_then_it_is_refused_and_nothing_changes(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, _third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        slots.switch(SlotId::Main, || {}).unwrap();
        slots.current().unlock(PASSWORD).unwrap();
        let ran = Cell::new(false);
        let outcome = slots.unlock_named("second", OTHER_PASSWORD, || ran.set(true));
        assert!(matches!(outcome, Err(VaultError::Busy)));
        assert!(!ran.get());
        // The open vault is still open, the other still locked, the screen where it was.
        assert_eq!(open_vaults(&slots), vec![SlotId::Main]);
        assert_eq!(slots.current_slot(), SlotId::Main);
    }

    #[test]
    fn given_a_switch_between_the_derivation_and_the_install_when_the_key_is_installed_then_only_the_winner_is_open(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (second, third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        make_vault_with(&slots, third, "orchard-tundra-violin-meadow-215");
        slots.switch(SlotId::Main, || {}).unwrap();
        let derive = |slot: SlotId, passphrase: &str| {
            let store = slots.store_of(slot).unwrap();
            store
                .derive_for_unlock(passphrase, store.pre_read_headers().unwrap())
                .ok()
                .unwrap()
        };

        // The key for `second` is derived while the screen is on Main; then the screen switches to
        // `third`; the install then finds the screen on `third`, locks it, and opens `second`.
        let key = derive(second, OTHER_PASSWORD);
        slots.switch(third, || {}).unwrap();
        slots.unlock_into(second, key, || {}).unwrap();
        assert_eq!(open_vaults(&slots), vec![second]);
        assert_eq!(slots.current_slot(), second);

        // The same, but the vault the screen moved to was opened meanwhile: the install is refused,
        // the key is dropped, and still only one vault is open.
        slots.current().lock();
        slots.switch(SlotId::Main, || {}).unwrap();
        let key = derive(second, OTHER_PASSWORD);
        slots.current().unlock(PASSWORD).unwrap();
        assert!(matches!(
            slots.unlock_into(second, key, || {}),
            Err(VaultError::Busy)
        ));
        assert_eq!(open_vaults(&slots), vec![SlotId::Main]);
        assert_eq!(slots.current_slot(), SlotId::Main);
    }

    #[test]
    fn given_a_lock_when_the_screen_returns_to_the_default_then_it_moves_unless_something_is_open()
    {
        let temp = tempfile::tempdir().unwrap();
        let (second, third) = three_vault_device(temp.path());
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        slots.switch(second, || {}).unwrap();
        // Already off the default: it goes back, stopping the work once.
        let stopped = Cell::new(0);
        slots.return_to_default(|| stopped.set(stopped.get() + 1));
        assert_eq!(slots.current_slot(), third);
        assert_eq!(stopped.get(), 1);
        // Already there: nothing runs.
        slots.return_to_default(|| stopped.set(stopped.get() + 1));
        assert_eq!(stopped.get(), 1);
        // A vault open on the screen is never left behind: the move is refused.
        slots.switch(second, || {}).unwrap();
        slots.current().unlock(OTHER_PASSWORD).unwrap();
        slots.return_to_default(|| stopped.set(stopped.get() + 1));
        assert_eq!(slots.current_slot(), second);
        assert_eq!(stopped.get(), 1);
    }

    #[test]
    fn given_one_vault_and_no_registry_when_a_name_is_typed_then_only_the_empty_name_opens_it() {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        // Through the source the app uses, as `vault_unlock_named` does.
        let handle = crate::vault_source::StoreHandle::single(Arc::clone(
            slots.store_of(SlotId::Main).unwrap(),
        ));
        assert!(matches!(
            handle.unlock_named("anyone", PASSWORD, || {}),
            Err(VaultError::WrongPassphrase)
        ));
        let opened = handle.unlock_named("", PASSWORD, || {}).unwrap();
        assert!(Arc::ptr_eq(&opened, slots.store_of(SlotId::Main).unwrap()));
        // And through VaultSlots itself, with no registry file: a typed name matches nothing.
        slots.current().lock();
        assert!(matches!(
            slots.unlock_named("anyone", PASSWORD, || {}),
            Err(VaultError::WrongPassphrase)
        ));
        assert!(slots.unlock_named("", PASSWORD, || {}).is_ok());
    }

    // ---- add a vault (#357 4c) ----

    fn registry_slots(dir: &Path) -> Vec<SlotId> {
        Registry::load(dir).unwrap().unwrap().slots()
    }

    /// A device with Main and one more vault, both made and locked, on the test hashing cost.
    fn two_vault_device(dir: &Path) -> (VaultSlots, SlotId) {
        let mut registry = Registry::with_main(HashCost::TEST).unwrap();
        let second = registry.add_extra("Second").unwrap();
        registry.save(dir).unwrap();
        let slots = slots_in(dir);
        make_vault_with(&slots, SlotId::Main, PASSWORD);
        make_vault_with(&slots, second, OTHER_PASSWORD);
        (slots, second)
    }

    #[test]
    fn given_a_device_when_a_vault_is_added_then_it_is_registered_made_open_and_found_by_its_name()
    {
        let temp = tempfile::tempdir().unwrap();
        let (slots, second) = two_vault_device(temp.path());
        assert_eq!(slots.current_slot(), SlotId::Main);
        let stopped = Cell::new(0);
        let store = slots
            .add_vault("  Garden ", PASSWORD, "FAKE Gardener", 5, || {
                stopped.set(stopped.get() + 1)
            })
            .unwrap();
        // Written first: the registry lists three, the new one last, and the default is unchanged.
        let listed = registry_slots(temp.path());
        assert_eq!(listed.len(), 3);
        let added = listed[2];
        assert!(!listed[..2].contains(&added));
        assert_eq!(
            Registry::load(temp.path()).unwrap().unwrap().default_slot(),
            Some(SlotId::Main)
        );
        // The device has it, the screen is on it, it is open, and the old vault is locked.
        assert!(Arc::ptr_eq(&store, slots.store_of(added).unwrap()));
        assert_eq!(slots.current_slot(), added);
        assert_eq!(open_vaults(&slots), vec![added]);
        assert_eq!(stopped.get(), 1);
        assert!(matches!(
            slots.store_of(second).unwrap().status(),
            Ok(VaultStatus::Locked)
        ));
        // Locked again, its name finds it at once (the registry in memory was read again).
        store.lock();
        let opened = slots.unlock_named("GARDEN", PASSWORD, || {}).unwrap();
        assert!(Arc::ptr_eq(&opened, &store));
        // Its home is its own folder, apart from Main's and the second vault's.
        assert!(slot_home(temp.path(), added).is_dir());
        assert_ne!(
            slot_home(temp.path(), added),
            slot_home(temp.path(), second)
        );
    }

    #[test]
    fn given_no_registry_when_a_vault_is_added_then_main_is_listed_first_and_stays_the_default() {
        let temp = tempfile::tempdir().unwrap();
        let slots = slots_in(temp.path());
        make_vault(&slots, SlotId::Main);
        let store = slots
            .add_vault("Garden", OTHER_PASSWORD, "FAKE Gardener", 5, || {})
            .unwrap();
        let listed = registry_slots(temp.path());
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0], SlotId::Main);
        assert_eq!(
            Registry::load(temp.path()).unwrap().unwrap().default_slot(),
            Some(SlotId::Main)
        );
        assert!(Arc::ptr_eq(&store, slots.store_of(listed[1]).unwrap()));
        assert_eq!(slots.current_slot(), listed[1]);
    }

    #[test]
    fn given_a_name_four_vaults_share_when_a_fifth_is_added_then_it_is_refused_and_nothing_changes()
    {
        let temp = tempfile::tempdir().unwrap();
        let (slots, _) = two_vault_device(temp.path());
        for n in 0..DUPLICATE_NAME_CAP_FOR_TEST {
            slots
                .add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {})
                .unwrap_or_else(|e| panic!("add {n}: {e:?}"))
                .lock();
            // The screen is on the new vault, which is locked: it is at rest for the next add.
        }
        let before = fs::read(temp.path().join("vaults.v1")).unwrap();
        let slot_count = slots.slots().len();
        let current = slots.current_slot();
        assert!(matches!(
            slots.add_vault("garden", PASSWORD, "FAKE Gardener", 5, || {}),
            Err(VaultError::AlreadyExists)
        ));
        assert_eq!(fs::read(temp.path().join("vaults.v1")).unwrap(), before);
        assert_eq!(slots.slots().len(), slot_count);
        assert_eq!(slots.current_slot(), current);
    }

    #[test]
    fn given_inputs_create_would_refuse_when_a_vault_is_added_then_nothing_is_registered() {
        let temp = tempfile::tempdir().unwrap();
        let (slots, _) = two_vault_device(temp.path());
        let before = fs::read(temp.path().join("vaults.v1")).unwrap();
        for (name, passphrase, person) in [
            ("Garden", "short", "FAKE Gardener"),
            ("Garden", PASSWORD, ""),
            ("", PASSWORD, "FAKE Gardener"),
            ("Gar\u{7}den", PASSWORD, "FAKE Gardener"),
        ] {
            assert!(
                slots.add_vault(name, passphrase, person, 5, || {}).is_err(),
                "{name:?} {passphrase:?} {person:?}"
            );
        }
        assert_eq!(fs::read(temp.path().join("vaults.v1")).unwrap(), before);
        assert_eq!(slots.slots().len(), 2);
        assert_eq!(slots.current_slot(), SlotId::Main);
    }

    #[test]
    fn given_a_vault_that_cannot_be_made_when_a_vault_is_added_then_its_entry_is_taken_out_again() {
        let temp = tempfile::tempdir().unwrap();
        let (slots, _) = two_vault_device(temp.path());
        let before = registry_slots(temp.path());
        // The vault's first history write fails, after the entry was written.
        let outcome = {
            let _fail = crate::vault::FailAtForTest::boundary(&["history.objects-sync"]);
            slots.add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {})
        };
        assert!(outcome.is_err());
        assert_eq!(registry_slots(temp.path()), before);
        assert_eq!(slots.current_slot(), SlotId::Main);
        assert!(open_vaults(&slots).is_empty());
        // The name finds nothing, and the owner can add it again.
        assert!(slots.unlock_named("Garden", PASSWORD, || {}).is_err());
        assert!(slots
            .add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {})
            .is_ok());
    }

    #[test]
    fn given_a_registry_that_cannot_be_used_when_a_vault_is_added_then_the_file_is_left_untouched()
    {
        for bytes in [b"not a registry".to_vec(), {
            let mut newer = Registry::with_main(HashCost::TEST).unwrap().to_bytes();
            newer[8] = 0xff;
            newer
        }] {
            let temp = tempfile::tempdir().unwrap();
            fs::write(temp.path().join("vaults.v1"), &bytes).unwrap();
            let slots = slots_in(temp.path());
            assert!(slots.registry_problem().is_some());
            make_vault(&slots, SlotId::Main);
            assert!(matches!(
                slots.add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {}),
                Err(VaultError::Storage)
            ));
            assert_eq!(fs::read(temp.path().join("vaults.v1")).unwrap(), bytes);
            assert_eq!(slots.slots(), vec![SlotId::Main]);
        }
    }

    #[test]
    fn given_the_screens_vault_is_open_or_a_try_is_under_way_when_a_vault_is_added_then_it_is_refused(
    ) {
        let temp = tempfile::tempdir().unwrap();
        let (slots, second) = two_vault_device(temp.path());
        let before = fs::read(temp.path().join("vaults.v1")).unwrap();
        // An open vault is not left open beside a new one.
        slots.current().unlock(PASSWORD).unwrap();
        assert!(matches!(
            slots.add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {}),
            Err(VaultError::Busy)
        ));
        slots.current().lock();
        // One add or unlock by name at a time per device.
        let _taken = slots.begin_named_attempt().unwrap();
        assert!(matches!(
            slots.add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {}),
            Err(VaultError::Busy)
        ));
        assert_eq!(fs::read(temp.path().join("vaults.v1")).unwrap(), before);
        assert!(slots.store_of(second).is_some());
    }

    #[test]
    fn given_two_adds_at_once_when_they_finish_then_neither_is_lost_from_the_registry() {
        // Two windows or two instances: the registry is read, changed and written under the device
        // lock, so both entries are there. (In one process the second add is refused as Busy by the
        // device's one-at-a-time rule, which is the other half of the same guarantee.)
        let temp = tempfile::tempdir().unwrap();
        let (slots, _) = two_vault_device(temp.path());
        let other = Registry::update(
            temp.path(),
            || Registry::with_main(HashCost::TEST),
            |registry| registry.add_extra("Elsewhere"),
        )
        .unwrap();
        slots
            .add_vault("Garden", PASSWORD, "FAKE Gardener", 5, || {})
            .unwrap();
        let listed = registry_slots(temp.path());
        assert_eq!(listed.len(), 4);
        assert!(listed.contains(&other));
    }
}
