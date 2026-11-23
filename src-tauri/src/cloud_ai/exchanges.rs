//! The one prepared send the app holds between "Prepare" and "Send", and the cancel flags of the
//! sends and key tests running. Generic over what is held, so that its rules are tested with plain
//! values: one prepared send at a time (a new one replaces the old), it belongs to the unlocked
//! session it was made in, it expires, and it is taken exactly once. Nothing here is persisted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use uuid::Uuid;

/// A prepared send that was not sent is dropped after this long.
pub(crate) const PREPARED_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TakeError {
    /// Never prepared, already used, replaced, or from another unlocked session.
    Unknown,
    Expired,
}

struct Slot<T, O> {
    id: Uuid,
    origin: O,
    made: Instant,
    held: T,
}

pub(crate) struct Exchanges<T, O> {
    slot: Mutex<Option<Slot<T, O>>>,
    running: Mutex<HashMap<Uuid, Arc<AtomicBool>>>,
}

impl<T, O> Default for Exchanges<T, O> {
    fn default() -> Self {
        Self {
            slot: Mutex::new(None),
            running: Mutex::new(HashMap::new()),
        }
    }
}

impl<T, O: Copy + PartialEq> Exchanges<T, O> {
    /// Keeps `held` for one send; whatever was kept before is dropped (and zeroed by its own Drop).
    pub(crate) fn put(&self, origin: O, held: T, now: Instant) -> Uuid {
        let id = Uuid::new_v4();
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(Slot {
            id,
            origin,
            made: now,
            held,
        });
        id
    }

    /// Takes the prepared send for `id` and registers its cancel flag for as long as it runs.
    pub(crate) fn take(
        &self,
        id: Uuid,
        origin: O,
        now: Instant,
    ) -> Result<(T, Arc<AtomicBool>), TakeError> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        match slot.as_ref() {
            Some(held) if held.id == id && held.origin == origin => {}
            _ => return Err(TakeError::Unknown),
        }
        let held = slot.take().ok_or(TakeError::Unknown)?;
        if now.duration_since(held.made) > PREPARED_TTL {
            return Err(TakeError::Expired);
        }
        let flag = Arc::new(AtomicBool::new(false));
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, Arc::clone(&flag));
        Ok((held.held, flag))
    }

    /// A key test or a send starts that has no prepared text: only a cancel flag.
    pub(crate) fn start_running(&self) -> (Uuid, Arc<AtomicBool>) {
        let id = Uuid::new_v4();
        let flag = Arc::new(AtomicBool::new(false));
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, Arc::clone(&flag));
        (id, flag)
    }

    pub(crate) fn finish(&self, id: Uuid) {
        self.running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }

    /// Drops a prepared send, or asks a running one to stop.
    pub(crate) fn cancel(&self, id: Uuid) {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|held| held.id == id) {
            *slot = None;
        }
        drop(slot);
        if let Some(flag) = self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
        {
            flag.store(true, Ordering::Release);
        }
    }

    /// A lock: nothing prepared survives, and everything running is asked to stop.
    pub(crate) fn clear(&self) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = None;
        for flag in self
            .running
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            flag.store(true, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prepared_send_is_taken_once_in_its_own_session() {
        let ex: Exchanges<String, u8> = Exchanges::default();
        let now = Instant::now();
        let id = ex.put(1, "text".into(), now);
        assert_eq!(ex.take(id, 2, now).err(), Some(TakeError::Unknown));
        // A wrong session did not use it up... but it is dropped only when taken in its own.
        let (held, _) = ex.take(id, 1, now).unwrap();
        assert_eq!(held, "text");
        assert_eq!(ex.take(id, 1, now).err(), Some(TakeError::Unknown));
    }

    #[test]
    fn a_new_prepare_replaces_the_old_and_a_stale_one_expires() {
        let ex: Exchanges<String, u8> = Exchanges::default();
        let now = Instant::now();
        let first = ex.put(1, "a".into(), now);
        let second = ex.put(1, "b".into(), now);
        assert_eq!(ex.take(first, 1, now).err(), Some(TakeError::Unknown));
        let later = now + PREPARED_TTL + Duration::from_secs(1);
        assert_eq!(ex.take(second, 1, later).err(), Some(TakeError::Expired));
        assert_eq!(ex.take(second, 1, now).err(), Some(TakeError::Unknown));
    }

    #[test]
    fn cancel_drops_a_prepared_send_and_stops_a_running_one() {
        let ex: Exchanges<String, u8> = Exchanges::default();
        let now = Instant::now();
        let id = ex.put(1, "a".into(), now);
        ex.cancel(id);
        assert_eq!(ex.take(id, 1, now).err(), Some(TakeError::Unknown));
        let id = ex.put(1, "a".into(), now);
        let (_, flag) = ex.take(id, 1, now).unwrap();
        assert!(!flag.load(Ordering::Acquire));
        ex.cancel(id);
        assert!(flag.load(Ordering::Acquire));
        ex.finish(id);
    }

    #[test]
    fn a_lock_clears_what_is_prepared_and_stops_what_runs() {
        let ex: Exchanges<String, u8> = Exchanges::default();
        let now = Instant::now();
        let running = ex.put(1, "a".into(), now);
        let (_, flag) = ex.take(running, 1, now).unwrap();
        let waiting = ex.put(1, "b".into(), now);
        ex.clear();
        assert!(flag.load(Ordering::Acquire));
        assert_eq!(ex.take(waiting, 1, now).err(), Some(TakeError::Unknown));
        let (id, flag) = ex.start_running();
        ex.cancel(id);
        assert!(flag.load(Ordering::Acquire));
    }
}
