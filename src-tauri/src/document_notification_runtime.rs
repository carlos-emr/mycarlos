//! Best-effort LOCAL ARRIVAL notices for the running Windows evaluation app.
//! Not remote readiness, push delivery, an activation grant, or proof of display.
//! Native callers alone supply identities after durable authenticated custody.
use crate::ui_text::UiLocale;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Unavailable,
    Unknown,
    Allowed,
    Blocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Queued,
    OsAccepted,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    Storage,
    OsRejected,
    Cancelled,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub supported: bool,
    pub available: bool,
    pub enabled: bool,
    pub permission: Permission,
    pub automatic_checks_enabled: bool,
    pub automatic_checks_supported: bool,
    pub automatic_checks_paused: bool,
    pub last_outcome: Option<Outcome>,
}

impl Status {
    pub fn unavailable() -> Self {
        Self {
            supported: false,
            available: false,
            enabled: false,
            permission: Permission::Unavailable,
            automatic_checks_enabled: false,
            automatic_checks_supported: false,
            automatic_checks_paused: false,
            last_outcome: None,
        }
    }
}

#[cfg(any(test, windows))]
pub(crate) mod active {
    use super::*;
    use atomicwrites::{AllowOverwrite, AtomicFile};
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{Read, Write},
        sync::{
            atomic::{AtomicBool, AtomicU64, Ordering},
            Mutex,
        },
    };
    use uuid::Uuid;

    const MAX_BYTES: usize = 64 * 1024;
    /// Dedupe window: the newest settled arrivals kept on disk. Older entries are dropped as
    /// new ones arrive, so a full ledger never stops notices; a delivery older than the window
    /// could be noticed again if it were verified again, which is bounded and harmless.
    const MAX_EVENTS: usize = 512;

    pub trait Backend: Send + Sync {
        fn permission(&self) -> Permission;
        /// A successful OS API acceptance, never a claim that a person saw it. `body` is the
        /// fixed catalogue sentence for the language the app last reported, never data.
        fn accept(&self, body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error>;
    }

    /// The notice sentence for `locale`, falling back to English; identical for every arrival.
    /// `None` means no catalogue text could be rendered: the arrival is then recorded as Failed
    /// and nothing reaches the OS.
    fn arrival_notice(locale: Option<UiLocale>) -> Option<String> {
        let id = crate::ui_text_ids::MessageId::NativeNoticeArrival;
        locale
            .unwrap_or_default()
            .text(id)
            .ok()
            .or_else(|| UiLocale::default().text(id).ok())
    }

    #[derive(Clone, Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Entry {
        key: String,
        outcome: Outcome,
    }

    /// Fields a later build adds (as `locale` was) are ignored by this one, so a downgrade of the
    /// evaluation app keeps reading the file; the version number and the legacy probe below still
    /// decide the shape. Entries keep their strict shape.
    #[derive(Clone, Serialize, Deserialize)]
    struct Ledger {
        version: u8,
        enabled: bool,
        events: Vec<Entry>,
        automatic_checks_enabled: bool,
        automatic_consent_version: u8,
        /// The language the app last reported through the Settings page; absent in older files.
        #[serde(default)]
        locale: Option<UiLocale>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct LegacyLedger {
        version: u8,
        enabled: bool,
        events: Vec<Entry>,
    }

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum SavedLedger {
        V2(Ledger),
        V1(LegacyLedger),
    }

    impl Default for Ledger {
        fn default() -> Self {
            Self {
                version: 2,
                automatic_checks_enabled: false,
                automatic_consent_version: 0,
                enabled: false,
                events: Vec::new(),
                locale: None,
            }
        }
    }

    pub struct Runtime {
        path: PathBuf,
        state: Mutex<Option<Ledger>>,
        backend: Box<dyn Backend>,
        /// The catalogue lookup for the notice sentence; tests swap in one that fails.
        notice: fn(Option<UiLocale>) -> Option<String>,
        supported: bool,
        accepting: AtomicBool,
        automatic_ready: AtomicBool,
        consent_epoch: AtomicU64,
    }

    impl Runtime {
        #[cfg(windows)]
        pub fn new(path: PathBuf, app_id: String) -> Self {
            Self::load(
                path,
                Box::new(crate::document_notification_windows::WindowsBackend::new(
                    app_id,
                )),
            )
        }

        #[cfg(all(test, not(windows)))]
        pub fn new(path: PathBuf, _app_id: String) -> Self {
            struct Unavailable;
            impl Backend for Unavailable {
                fn permission(&self) -> Permission {
                    Permission::Unavailable
                }
                fn accept(
                    &self,
                    _body: &str,
                    _still_current: &dyn Fn() -> bool,
                ) -> Result<(), Error> {
                    Err(Error::Unavailable)
                }
            }
            Self {
                path,
                state: Mutex::new(None),
                notice: arrival_notice,
                backend: Box::new(Unavailable),
                supported: false,
                accepting: AtomicBool::new(false),
                automatic_ready: AtomicBool::new(false),
                consent_epoch: AtomicU64::new(0),
            }
        }

        fn load(path: PathBuf, backend: Box<dyn Backend>) -> Self {
            let read = || -> Result<Ledger, ()> {
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(value) => value,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        return Ok(Ledger::default())
                    }
                    Err(_) => return Err(()),
                };
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(());
                }
                let mut bytes = Vec::new();
                fs::File::open(&path)
                    .map_err(|_| ())?
                    .take((MAX_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|_| ())?;
                if bytes.len() > MAX_BYTES {
                    return Err(());
                }
                let mut ledger =
                    match serde_json::from_slice::<SavedLedger>(&bytes).map_err(|_| ())? {
                        SavedLedger::V1(old) if old.version == 1 => Ledger {
                            enabled: old.enabled,
                            events: old.events,
                            ..Ledger::default()
                        },
                        SavedLedger::V2(current) if current.version == 2 => current,
                        _ => return Err(()),
                    };
                let mut keys = std::collections::HashSet::new();
                if ledger.version != 2
                    || ledger.automatic_consent_version > 1
                    || (ledger.automatic_checks_enabled
                        && (!ledger.enabled || ledger.automatic_consent_version != 1))
                    || ledger.events.len() > MAX_EVENTS
                    || ledger.events.iter().any(|e| {
                        e.key.len() != 64
                            || !e
                                .key
                                .bytes()
                                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                            || !keys.insert(e.key.clone())
                    })
                {
                    return Err(());
                }
                // No automatic retry across an ambiguous crash window.
                for entry in &mut ledger.events {
                    if entry.outcome == Outcome::Queued {
                        entry.outcome = Outcome::Unknown;
                    }
                }
                Ok(ledger)
            };
            let state = read().ok();
            let accepting = state.as_ref().is_some_and(|s| s.enabled);
            let automatic_ready = state.as_ref().is_some_and(|s| {
                s.enabled && s.automatic_checks_enabled && s.automatic_consent_version == 1
            });
            Self {
                path,
                state: Mutex::new(state),
                backend,
                notice: arrival_notice,
                supported: true,
                accepting: AtomicBool::new(accepting),
                automatic_ready: AtomicBool::new(automatic_ready),
                consent_epoch: AtomicU64::new(0),
            }
        }

        fn persist(&self, ledger: &Ledger) -> Result<(), ()> {
            let parent = self.path.parent().ok_or(())?;
            fs::create_dir_all(parent).map_err(|_| ())?;
            let metadata = fs::symlink_metadata(parent).map_err(|_| ())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(());
            }
            if let Ok(metadata) = fs::symlink_metadata(&self.path) {
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(());
                }
            }
            let bytes = serde_json::to_vec(ledger).map_err(|_| ())?;
            if bytes.len() > MAX_BYTES {
                return Err(());
            }
            AtomicFile::new(&self.path, AllowOverwrite)
                .write(|f| f.write_all(&bytes))
                .map_err(|_| ())
        }

        /// Safe inside network/OS stop predicates: no ledger mutex or API call.
        pub fn automatic_eligible(&self) -> bool {
            self.supported
                && !self.state.is_poisoned()
                && self.accepting.load(Ordering::Acquire)
                && self.automatic_ready.load(Ordering::Acquire)
        }
        fn update_automatic(&self, s: &Ledger) {
            self.automatic_ready.store(
                self.accepting.load(Ordering::Acquire)
                    && s.enabled
                    && s.automatic_checks_enabled
                    && s.automatic_consent_version == 1,
                Ordering::Release,
            );
        }
        #[cfg(test)]
        pub(crate) fn load_for_test(path: PathBuf, backend: Box<dyn Backend>) -> Self {
            Self::load(path, backend)
        }
        #[cfg(test)]
        fn with_notice(mut self, notice: fn(Option<UiLocale>) -> Option<String>) -> Self {
            self.notice = notice;
            self
        }

        pub fn status(&self) -> Status {
            if !self.supported {
                return Status::unavailable();
            }
            let Ok(guard) = self.state.lock() else {
                return Status {
                    supported: true,
                    available: false,
                    enabled: false,
                    permission: Permission::Unknown,
                    automatic_checks_enabled: false,
                    automatic_checks_supported: false,
                    automatic_checks_paused: false,
                    last_outcome: Some(Outcome::Unknown),
                };
            };
            Status {
                supported: true,
                available: guard.as_ref().is_some(),
                enabled: self.accepting.load(Ordering::Acquire)
                    && guard.as_ref().is_some_and(|s| s.enabled),
                automatic_checks_enabled: self.accepting.load(Ordering::Acquire)
                    && guard.as_ref().is_some_and(|s| {
                        s.enabled && s.automatic_checks_enabled && s.automatic_consent_version == 1
                    }),
                automatic_checks_supported: cfg!(any(test, windows)),
                automatic_checks_paused: false,
                permission: self.backend.permission(),
                last_outcome: guard
                    .as_ref()
                    .and_then(|s| s.events.last().map(|e| e.outcome)),
            }
        }

        /// Remembers the language the app reports so a later notice is worded in it. Not
        /// consent: a failed write keeps notices running with the language already on disk.
        pub(crate) fn observe_locale(&self, locale: Option<UiLocale>) {
            let Some(locale) = locale else {
                return;
            };
            let Ok(mut guard) = self.state.lock() else {
                return;
            };
            let Some(state) = guard.as_mut() else {
                return;
            };
            if state.locale == Some(locale) {
                return;
            }
            let mut next = state.clone();
            next.locale = Some(locale);
            if self.persist(&next).is_ok() {
                *state = next;
            }
        }

        pub fn suspend_notices(&self) {
            self.accepting.store(false, Ordering::Release);
            self.automatic_ready.store(false, Ordering::Release);
            self.consent_epoch.fetch_add(1, Ordering::AcqRel);
        }

        pub fn set_enabled(&self, enabled: bool) -> Result<Status, Error> {
            if !enabled {
                // This happens before any blocking ledger write/lock.
                self.suspend_notices();
            }
            let mut guard = self.state.lock().map_err(|_| Error::Storage)?;
            let mut next = guard.as_ref().ok_or(Error::Unavailable)?.clone();
            next.enabled = enabled;
            if !enabled {
                next.automatic_checks_enabled = false;
            }
            if self.persist(&next).is_err() {
                // Stop notices in this process rather than continue with an unsaved preference.
                self.accepting.store(false, Ordering::Release);
                self.automatic_ready.store(false, Ordering::Release);
                *guard = None;
                return Err(Error::Storage);
            }
            self.accepting.store(enabled, Ordering::Release);
            self.update_automatic(&next);
            *guard = Some(next);
            drop(guard);
            Ok(self.status())
        }

        /// Caller must cancel the active automatic token BEFORE entering this
        /// method on opt-out; persistence failure never authorizes more work.
        pub fn set_automatic_checks(&self, enabled: bool) -> Result<Status, Error> {
            if !enabled {
                self.automatic_ready.store(false, Ordering::Release);
            }
            let mut guard = self.state.lock().map_err(|_| Error::Storage)?;
            let mut next = guard.as_ref().ok_or(Error::Unavailable)?.clone();
            if enabled && (!next.enabled || !self.accepting.load(Ordering::Acquire)) {
                return Err(Error::Unavailable);
            }
            next.automatic_checks_enabled = enabled;
            next.automatic_consent_version = if enabled {
                1
            } else {
                next.automatic_consent_version
            };
            if self.persist(&next).is_err() {
                self.accepting.store(false, Ordering::Release);
                self.automatic_ready.store(false, Ordering::Release);
                *guard = None;
                return Err(Error::Storage);
            }
            self.update_automatic(&next);
            *guard = Some(next);
            drop(guard);
            Ok(self.status())
        }

        /// Native recheck occurs after permission observation and immediately before acceptance.
        /// Identity fields never arrive through renderer IPC or an external notification intent.
        pub fn arrived(
            &self,
            vault: Uuid,
            link: Uuid,
            device: &str,
            delivery: &str,
            record: Uuid,
            still_current: impl Fn() -> bool,
        ) {
            let epoch = self.consent_epoch.load(Ordering::Acquire);
            let current = || {
                self.accepting.load(Ordering::Acquire)
                    && self.consent_epoch.load(Ordering::Acquire) == epoch
                    && still_current()
            };
            if vault.is_nil()
                || link.is_nil()
                || record.is_nil()
                || device.len() != 43
                || !device
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                || Uuid::parse_str(delivery).is_err()
            {
                return;
            }
            // Local record identity proves custody above, but the durable notice identity is
            // the actual delivery and owner, even if a local record is later reconstructed.
            let Ok(identity) = serde_json::to_vec(&(vault, link, device, delivery)) else {
                return;
            };
            let key = format!("{:x}", Sha256::digest(identity));
            let Ok(mut guard) = self.state.lock() else {
                return;
            };
            let Some(state) = guard.as_ref() else {
                return;
            };
            if !state.enabled || state.events.iter().any(|e| e.key == key) {
                return;
            }
            let mut next = state.clone();
            if next.events.len() >= MAX_EVENTS {
                // Every entry is settled (the lock is held for the whole acceptance below), so
                // the oldest ones leave the dedupe window to make room.
                let excess = next.events.len() + 1 - MAX_EVENTS;
                next.events.drain(..excess);
            }
            next.events.push(Entry {
                key,
                outcome: Outcome::Queued,
            });
            if self.persist(&next).is_err() {
                self.automatic_ready.store(false, Ordering::Release);
                self.accepting.store(false, Ordering::Release);
                *guard = None;
                return;
            }
            // Serialize the opt-out and side effect. No detached task can revive a disabled notice.
            let outcome = match self.backend.permission() {
                Permission::Allowed if current() => match (self.notice)(next.locale) {
                    Some(body) => match self.backend.accept(&body, &current) {
                        Ok(()) => Outcome::OsAccepted,
                        Err(Error::Cancelled) => Outcome::Unknown,
                        Err(_) => Outcome::Failed,
                    },
                    None => Outcome::Failed,
                },
                _ => Outcome::Unknown,
            };
            next.events.last_mut().unwrap().outcome = outcome;
            if self.persist(&next).is_err() {
                self.automatic_ready.store(false, Ordering::Release);
                self.accepting.store(false, Ordering::Release);
                *guard = None;
                return;
            }
            self.update_automatic(&next);
            *guard = Some(next);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        struct Mock {
            calls: Arc<AtomicUsize>,
            fail: bool,
        }
        impl Backend for Mock {
            fn permission(&self) -> Permission {
                Permission::Allowed
            }
            fn accept(&self, _body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error> {
                if !still_current() {
                    return Err(Error::Cancelled);
                }
                self.calls.fetch_add(1, Ordering::SeqCst);
                if self.fail {
                    Err(Error::OsRejected)
                } else {
                    Ok(())
                }
            }
        }
        fn arrival(runtime: &Runtime) {
            runtime.arrived(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                &"A".repeat(43),
                "00000000-0000-4000-8000-000000000003",
                Uuid::from_u128(4),
                || true,
            );
        }
        #[test]
        fn opt_in_and_durable_dedupe_do_not_claim_display() {
            let temp = tempfile::tempdir().unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let path = temp.path().join("state.json");
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: false,
                }),
            );
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            runtime.set_enabled(true).ok().unwrap();
            arrival(&runtime);
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::OsAccepted));
            let restarted = Runtime::load(
                path,
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: false,
                }),
            );
            arrival(&restarted);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
        #[test]
        fn failed_acceptance_is_recorded_and_not_automatically_retried() {
            let temp = tempfile::tempdir().unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                temp.path().join("state.json"),
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: true,
                }),
            );
            runtime.set_enabled(true).ok().unwrap();
            arrival(&runtime);
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Failed));
        }
        #[test]
        fn ambiguous_queued_restart_stays_unknown_without_retry() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let calls = Arc::new(AtomicUsize::new(0));
            let ledger = Ledger {
                enabled: true,
                events: vec![Entry {
                    key: "a".repeat(64),
                    outcome: Outcome::Queued,
                }],
                ..Ledger::default()
            };
            fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
            let runtime = Runtime::load(
                path,
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: false,
                }),
            );
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Unknown));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn stale_native_owner_after_permission_never_calls_os_or_retries() {
            let temp = tempfile::tempdir().unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                temp.path().join("state.json"),
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: false,
                }),
            );
            runtime.set_enabled(true).ok().unwrap();
            runtime.arrived(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                &"A".repeat(43),
                "00000000-0000-4000-8000-000000000003",
                Uuid::from_u128(4),
                || false,
            );
            arrival(&runtime);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Unknown));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn corrupt_state_is_not_overwritten_and_never_enables_notices() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            fs::write(&path, b"not-json").unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: false,
                }),
            );
            assert!(!runtime.status().available);
            assert!(matches!(runtime.set_enabled(true), Err(Error::Unavailable)));
            arrival(&runtime);
            assert_eq!(fs::read(path).unwrap(), b"not-json");
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn legacy_manual_consent_never_authorizes_automatic_checks() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let original = br#"{"version":1,"enabled":true,"events":[]}"#;
            fs::write(&path, original).unwrap();
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: Arc::new(AtomicUsize::new(0)),
                    fail: false,
                }),
            );
            assert!(runtime.status().enabled);
            assert!(!runtime.status().automatic_checks_enabled);
            // Loading alone never overwrites a ledger or starts a network task.
            assert_eq!(fs::read(&path).unwrap(), original);
            runtime.set_automatic_checks(true).ok().unwrap();
            let saved: Ledger = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(saved.version, 2);
            assert_eq!(saved.automatic_consent_version, 1);
            assert!(saved.automatic_checks_enabled);
            runtime.set_enabled(false).ok().unwrap();
            assert!(!runtime.status().automatic_checks_enabled);
            assert!(runtime.set_automatic_checks(true).is_err());
        }

        #[test]
        fn final_backend_preparation_cancellation_is_unknown_without_os_acceptance() {
            use std::sync::atomic::AtomicBool;
            struct Preparing {
                current: Arc<AtomicBool>,
                calls: Arc<AtomicUsize>,
            }
            impl Backend for Preparing {
                fn permission(&self) -> Permission {
                    Permission::Allowed
                }
                fn accept(&self, _body: &str, current: &dyn Fn() -> bool) -> Result<(), Error> {
                    assert!(current());
                    self.current.store(false, Ordering::Release);
                    if !current() {
                        return Err(Error::Cancelled);
                    }
                    self.calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }
            let temp = tempfile::tempdir().unwrap();
            let current = Arc::new(AtomicBool::new(true));
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                temp.path().join("state.json"),
                Box::new(Preparing {
                    current: current.clone(),
                    calls: calls.clone(),
                }),
            );
            runtime.set_enabled(true).ok().unwrap();
            runtime.arrived(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                &"A".repeat(43),
                "00000000-0000-4000-8000-000000000003",
                Uuid::from_u128(4),
                || current.load(Ordering::Acquire),
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Unknown));
        }

        #[test]
        fn unknown_consent_schema_preserves_bytes_and_remains_unavailable() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let original=br#"{"version":2,"enabled":true,"events":[],"automatic_checks_enabled":true,"automatic_consent_version":99}"#;
            fs::write(&path, original).unwrap();
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: Arc::new(AtomicUsize::new(0)),
                    fail: false,
                }),
            );
            assert!(!runtime.status().available);
            assert!(runtime.set_automatic_checks(true).is_err());
            assert_eq!(fs::read(&path).unwrap(), original);
        }

        #[test]
        fn actual_opt_out_while_queued_and_observing_permission_never_accepts_or_retries() {
            use std::sync::{
                mpsc::{sync_channel, SyncSender},
                OnceLock, Weak,
            };
            struct DuringPermission {
                owner: Arc<OnceLock<Weak<Runtime>>>,
                started: SyncSender<()>,
                armed: Arc<AtomicBool>,
                calls: Arc<AtomicUsize>,
            }
            impl Backend for DuringPermission {
                fn permission(&self) -> Permission {
                    if self.armed.swap(false, Ordering::AcqRel) {
                        self.started.try_send(()).expect("bounded opt-out receiver");
                        let owner = self.owner.get().unwrap().upgrade().unwrap();
                        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
                        while owner.accepting.load(Ordering::Acquire) {
                            assert!(
                                std::time::Instant::now() < until,
                                "native opt-out did not reach its pre-lock gate"
                            );
                            std::thread::yield_now();
                        }
                    }
                    Permission::Allowed
                }
                fn accept(&self, _body: &str, current: &dyn Fn() -> bool) -> Result<(), Error> {
                    if !current() {
                        return Err(Error::Cancelled);
                    }
                    self.calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            }
            let temp = tempfile::tempdir().unwrap();
            let owner = Arc::new(OnceLock::new());
            let (started, started_rx) = sync_channel(1);
            let armed = Arc::new(AtomicBool::new(false));
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Arc::new(Runtime::load(
                temp.path().join("state.json"),
                Box::new(DuringPermission {
                    owner: owner.clone(),
                    started: started.clone(),
                    armed: armed.clone(),
                    calls: calls.clone(),
                }),
            ));
            assert!(owner.set(Arc::downgrade(&runtime)).is_ok());
            runtime.set_enabled(true).ok().unwrap();
            armed.store(true, Ordering::Release);
            std::thread::scope(|scope| {
                let stopping_runtime = &runtime;
                let stopping = scope.spawn(move || {
                    if started_rx
                        .recv_timeout(std::time::Duration::from_secs(2))
                        .is_err()
                    {
                        return Err(Error::Storage);
                    }
                    stopping_runtime.set_enabled(false)
                });
                arrival(&runtime);
                stopping.join().unwrap().ok().unwrap();
            });
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(!runtime.status().enabled);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Unknown));
            runtime.set_enabled(true).ok().unwrap();
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }

        #[test]
        #[allow(clippy::disallowed_methods)] // Deliberately make the synthetic state unwritable.
        fn capacity_and_failed_opt_out_persistence_revoke_atomic_readiness() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: Arc::new(AtomicUsize::new(0)),
                    fail: false,
                }),
            );
            runtime.set_enabled(true).ok().unwrap();
            runtime.set_automatic_checks(true).ok().unwrap();
            assert!(runtime.automatic_eligible());
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
            assert!(matches!(runtime.set_enabled(false), Err(Error::Storage)));
            assert!(!runtime.automatic_eligible());
            assert!(!runtime.status().available);
            fs::remove_dir(&path).unwrap();
            let ledger = Ledger {
                enabled: true,
                automatic_checks_enabled: true,
                automatic_consent_version: 1,
                events: (0..MAX_EVENTS)
                    .map(|i| Entry {
                        key: format!("{i:064x}"),
                        outcome: Outcome::Unknown,
                    })
                    .collect(),
                ..Ledger::default()
            };
            fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
            let runtime = Runtime::load(
                path,
                Box::new(Mock {
                    calls: Arc::new(AtomicUsize::new(0)),
                    fail: false,
                }),
            );
            // A full dedupe window is not a fault: notices and automatic checks stay available,
            // and an explicit opt-out still works.
            assert!(runtime.automatic_eligible());
            assert!(runtime.status().available);
            assert!(runtime.status().automatic_checks_enabled);
            runtime.set_automatic_checks(false).ok().unwrap();
            assert!(!runtime.status().automatic_checks_enabled);
            assert!(runtime.status().enabled);
        }

        struct Recording {
            bodies: Arc<Mutex<Vec<String>>>,
        }
        impl Backend for Recording {
            fn permission(&self) -> Permission {
                Permission::Allowed
            }
            fn accept(&self, body: &str, current: &dyn Fn() -> bool) -> Result<(), Error> {
                if !current() {
                    return Err(Error::Cancelled);
                }
                self.bodies.lock().unwrap().push(body.to_string());
                Ok(())
            }
        }
        fn saved(path: &std::path::Path) -> Ledger {
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
        }

        #[test]
        fn full_ledger_keeps_the_newest_entries_and_still_notifies() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let ledger = Ledger {
                enabled: true,
                events: (0..MAX_EVENTS)
                    .map(|i| Entry {
                        key: format!("{i:064x}"),
                        outcome: Outcome::Unknown,
                    })
                    .collect(),
                ..Ledger::default()
            };
            fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: Arc::clone(&calls),
                    fail: false,
                }),
            );
            assert!(runtime.status().available);
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            let after = saved(&path);
            assert_eq!(after.events.len(), MAX_EVENTS);
            assert_ne!(
                after.events[0].key,
                format!("{:064x}", 0),
                "the oldest entry left"
            );
            assert_eq!(after.events[1].key, format!("{:064x}", 2));
            assert_eq!(after.events.last().unwrap().outcome, Outcome::OsAccepted);
            // The newest entries still deduplicate.
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(saved(&path).events.len(), MAX_EVENTS);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::OsAccepted));
        }

        #[test]
        fn a_ledger_with_a_field_this_build_does_not_know_still_loads() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let newer = serde_json::json!({
                "version": 2, "enabled": true, "events": [],
                "automatic_checks_enabled": false, "automatic_consent_version": 0,
                "locale": "fr", "a_field_from_a_later_build": {"x": 1}
            });
            fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Recording {
                    bodies: Arc::clone(&bodies),
                }),
            );
            assert!(runtime.status().enabled);
            assert!(runtime.status().available);
            // The language in that file is in force: an arrival gets the French sentence.
            arrival(&runtime);
            let french = UiLocale::Fr
                .text(crate::ui_text_ids::MessageId::NativeNoticeArrival)
                .unwrap();
            assert_eq!(*bodies.lock().unwrap(), vec![french]);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::OsAccepted));
            // An entry keeps its strict shape: an unknown field there is still a corrupt file.
            let bad_entry = serde_json::json!({
                "version": 2, "enabled": true,
                "events": [{"key": format!("{:064x}", 1), "outcome": "unknown", "extra": true}],
                "automatic_checks_enabled": false, "automatic_consent_version": 0
            });
            fs::write(&path, serde_json::to_vec(&bad_entry).unwrap()).unwrap();
            let runtime = Runtime::load(
                path,
                Box::new(Mock {
                    calls: Arc::new(AtomicUsize::new(0)),
                    fail: false,
                }),
            );
            assert!(!runtime.status().available);
        }

        #[test]
        fn an_unrenderable_notice_is_recorded_as_failed_and_never_reaches_the_os() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Mock {
                    calls: Arc::clone(&calls),
                    fail: false,
                }),
            )
            .with_notice(|_| None);
            runtime.set_enabled(true).ok().unwrap();
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert_eq!(saved(&path).events.len(), 1);
            assert_eq!(saved(&path).events[0].outcome, Outcome::Failed);
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Failed));
            // The real lookup renders for every shipped language and never falls through to None.
            for locale in UiLocale::ALL {
                assert!(arrival_notice(Some(locale)).is_some_and(|s| s.contains("myCarlos")));
            }
        }

        #[test]
        fn notice_is_worded_in_the_language_the_app_last_reported() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let runtime = Runtime::load(
                path.clone(),
                Box::new(Recording {
                    bodies: Arc::clone(&bodies),
                }),
            );
            runtime.set_enabled(true).ok().unwrap();
            assert_eq!(saved(&path).locale, None);
            // Reporting no language changes nothing; reporting one is remembered on disk.
            runtime.observe_locale(None);
            assert_eq!(saved(&path).locale, None);
            runtime.observe_locale(Some(UiLocale::Fr));
            assert_eq!(saved(&path).locale, Some(UiLocale::Fr));
            arrival(&runtime);
            let french = UiLocale::Fr
                .text(crate::ui_text_ids::MessageId::NativeNoticeArrival)
                .unwrap();
            let english = UiLocale::En
                .text(crate::ui_text_ids::MessageId::NativeNoticeArrival)
                .unwrap();
            assert_ne!(french, english);
            // The backend got the French sentence and nothing else.
            assert_eq!(*bodies.lock().unwrap(), vec![french.clone()]);
            assert_eq!(saved(&path).events.len(), 1);
            assert_eq!(saved(&path).events[0].outcome, Outcome::OsAccepted);
            // A later language is used from the next arrival on; an unchanged one writes nothing new.
            runtime.observe_locale(Some(UiLocale::Fr));
            runtime.observe_locale(Some(UiLocale::ZhTw));
            assert_eq!(saved(&path).locale, Some(UiLocale::ZhTw));
            // A ledger written before the language field is still read, with no language.
            let old = serde_json::json!({
                "version": 2, "enabled": true, "events": [],
                "automatic_checks_enabled": false, "automatic_consent_version": 0
            });
            fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
            let reloaded = Runtime::load(
                path.clone(),
                Box::new(Recording {
                    bodies: Arc::new(Mutex::new(Vec::new())),
                }),
            );
            assert!(reloaded.status().enabled);
            assert_eq!(saved(&path).locale, None);
            assert_eq!(arrival_notice(None).as_deref(), Some(english.as_str()));
            assert_eq!(
                arrival_notice(Some(UiLocale::Fr)).as_deref(),
                Some(french.as_str())
            );
        }
    }
}

#[cfg(any(test, windows))]
pub use active::Runtime;

#[cfg(not(any(test, windows)))]
pub struct Runtime;
#[cfg(not(any(test, windows)))]
impl Runtime {
    pub fn new(_path: PathBuf, _app_id: String) -> Self {
        Self
    }
    pub fn automatic_eligible(&self) -> bool {
        false
    }
    pub fn status(&self) -> Status {
        Status::unavailable()
    }
    pub fn suspend_notices(&self) {}
    pub(crate) fn observe_locale(&self, _locale: Option<UiLocale>) {}
    pub fn set_enabled(&self, _enabled: bool) -> Result<Status, Error> {
        Err(Error::Unavailable)
    }
    pub fn set_automatic_checks(&self, _enabled: bool) -> Result<Status, Error> {
        Err(Error::Unavailable)
    }
}
