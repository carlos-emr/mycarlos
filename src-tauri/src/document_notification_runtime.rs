//! Two independent settings of the running desktop app, kept in one small file per vault:
//! the AUTOMATIC DOCUMENT CHECKS while unlocked (every desktop OS; its own consent), and the
//! best-effort LOCAL ARRIVAL notices (an add-on, only where the OS can show one: Windows today).
//! Neither needs the other.
//! Not remote readiness, push delivery, an activation grant, or proof of display.
//! Native callers alone supply identities after durable authenticated custody.
use crate::ui_text::UiLocale;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The system this build runs on, for the wording of the permission lines.
pub(crate) const fn system_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "other"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Unavailable,
    /// The operating system could not be asked at all (no notifier could be made): nothing is shown.
    Unknown,
    /// The system has no setting for this app yet. Windows makes one only when an unpackaged app
    /// first shows a notice, and until then asking for it fails. Nothing has been refused, so
    /// notices are tried; the first one shown makes the setting.
    NotYetAsked,
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

/// What a "Show a test notice" press came to. Never written to the ledger: a test is not an arrival.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TestNotice {
    /// The operating system accepted it.
    Shown,
    /// The operating system is blocking this app's notices.
    Blocked,
    /// Notices are not allowed in myCarlos, or not available here.
    NotAllowed,
    /// Pressed again within a few seconds of the last press.
    TooSoon,
    /// The system could not show it.
    Failed,
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
    /// Whether this computer can show a notice at all (Windows today): the notice switch is an
    /// add-on offered only where it is true. The automatic checks do not depend on it.
    pub notices_supported: bool,
    /// Which system's words the page uses for the permission lines ("windows", "macos", "other").
    pub system: &'static str,
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
            notices_supported: false,
            system: system_name(),
            last_outcome: None,
        }
    }
}

#[cfg(any(test, desktop))]
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

    /// What the operating system said when asked whether this app may show notices. Only the
    /// Windows and macOS backends ask (and the tests): elsewhere there is no notice to ask about.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    #[cfg_attr(not(any(test, windows, target_os = "macos")), allow(dead_code))]
    pub(crate) enum OsSetting {
        Enabled,
        /// Turned off by the person, an administrator, the app's own manifest or "do not disturb".
        Disabled,
        /// The question itself failed (Windows throws it for an app it has never shown a notice
        /// for), which is not a refusal.
        Failed,
    }

    /// How an answer reads. Only a definite "disabled" blocks: a failed question is "not yet asked".
    #[cfg_attr(not(any(test, windows, target_os = "macos")), allow(dead_code))]
    pub(crate) fn permission_for(setting: OsSetting) -> Permission {
        match setting {
            OsSetting::Enabled => Permission::Allowed,
            OsSetting::Disabled => Permission::Blocked,
            OsSetting::Failed => Permission::NotYetAsked,
        }
    }

    /// How a macOS `UNAuthorizationStatus` reads: not determined (0) is "not yet asked", denied (1)
    /// is blocked, authorized (2), provisional (3) and ephemeral (4) allow it. Anything else is not
    /// understood, so nothing is shown.
    #[cfg_attr(not(any(test, windows, target_os = "macos")), allow(dead_code))]
    pub(crate) fn permission_for_authorization(status: isize) -> Permission {
        match status {
            0 => Permission::NotYetAsked,
            1 => Permission::Blocked,
            2..=4 => Permission::Allowed,
            _ => Permission::Unknown,
        }
    }

    /// Whether a macOS notice may be posted for what the system says now. Only an allowed answer
    /// does: a posting never asks the question (that is `Backend::request_permission`, asked when
    /// the patient turns notices on), so a not-yet-asked, blocked or unknown answer is refused.
    #[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
    pub(crate) fn may_post(permission: Permission) -> Result<(), Error> {
        if permission == Permission::Allowed {
            Ok(())
        } else {
            Err(Error::OsRejected)
        }
    }

    /// Whether a notice may be tried now: yes unless the system said it is disabled.
    #[cfg_attr(not(any(test, windows, target_os = "macos")), allow(dead_code))]
    pub(crate) fn may_show(setting: OsSetting) -> bool {
        permission_for(setting) != Permission::Blocked
    }

    pub trait Backend: Send + Sync {
        fn permission(&self) -> Permission;
        /// Asks the system for permission, where it has a question to ask (macOS shows its own
        /// prompt, once). Called when the patient turns notices on, so the prompt comes with the
        /// choice. Where there is no question (Windows allows by default), it only reads.
        fn request_permission(&self) -> Permission {
            self.permission()
        }
        /// A successful OS API acceptance, never a claim that a person saw it. `body` is the
        /// fixed catalogue sentence for the language the app last reported, never data.
        fn accept(&self, body: &str, still_current: &dyn Fn() -> bool) -> Result<(), Error>;
    }

    /// The fixed sentence of a test notice, for `locale`, falling back to English.
    fn test_notice_text(locale: Option<UiLocale>) -> Option<String> {
        let id = crate::ui_text_ids::MessageId::NativeNoticeTest;
        locale
            .unwrap_or_default()
            .text(id)
            .ok()
            .or_else(|| UiLocale::default().text(id).ok())
    }

    /// Two presses of the test button closer than this are one: the second is refused.
    const TEST_NOTICE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

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
        /// The fixed test sentence; tests swap in one that fails.
        test_notice: fn(Option<UiLocale>) -> Option<String>,
        /// When the test button was last let through: any press that passed the too-soon check
        /// starts the wait, whatever came of it (shown, blocked or failed). And how long it waits.
        last_test: Mutex<Option<std::time::Instant>>,
        test_interval: std::time::Duration,
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

        #[cfg(target_os = "macos")]
        pub fn new(path: PathBuf, _app_id: String) -> Self {
            Self::load(
                path,
                Box::new(crate::document_notification_macos::MacBackend::new()),
            )
        }

        /// Where the OS cannot show a notice (Linux, and any other desktop): the checks are still
        /// supported, and a notice is never attempted.
        #[cfg(not(any(windows, target_os = "macos")))]
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
            Self::load(path, Box::new(Unavailable))
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
                    // The automatic checks need their own consent, not the notices: a file with
                    // them on and notices off is a valid state.
                    || (ledger.automatic_checks_enabled && ledger.automatic_consent_version != 1)
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
            let automatic_ready = state
                .as_ref()
                .is_some_and(|s| s.automatic_checks_enabled && s.automatic_consent_version == 1);
            Self {
                path,
                state: Mutex::new(state),
                backend,
                notice: arrival_notice,
                test_notice: test_notice_text,
                last_test: Mutex::new(None),
                test_interval: TEST_NOTICE_INTERVAL,
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
                && self.automatic_ready.load(Ordering::Acquire)
        }
        fn update_automatic(&self, s: &Ledger) {
            self.automatic_ready.store(
                s.automatic_checks_enabled && s.automatic_consent_version == 1,
                Ordering::Release,
            );
        }
        #[cfg(test)]
        pub(crate) fn load_for_test(path: PathBuf, backend: Box<dyn Backend>) -> Self {
            Self::load(path, backend)
        }
        /// Where this runtime keeps its ledger, for the tests that check each vault has its own.
        #[cfg(test)]
        pub(crate) fn ledger_path(&self) -> &std::path::Path {
            &self.path
        }
        #[cfg(test)]
        fn with_test_interval(mut self, interval: std::time::Duration) -> Self {
            self.test_interval = interval;
            self
        }
        #[cfg(test)]
        fn with_test_notice(mut self, notice: fn(Option<UiLocale>) -> Option<String>) -> Self {
            self.test_notice = notice;
            self
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
            // Asked once, and before the state lock is taken: on Linux the answer comes from a bus
            // call that can take its full timeout, and the lock must not be held across it (turning
            // notices off, or an arrival, would wait behind a status poll).
            let permission = self.backend.permission();
            let Ok(guard) = self.state.lock() else {
                return Status {
                    supported: true,
                    available: false,
                    enabled: false,
                    permission: Permission::Unknown,
                    automatic_checks_enabled: false,
                    automatic_checks_supported: false,
                    automatic_checks_paused: false,
                    notices_supported: false,
                    system: system_name(),
                    last_outcome: Some(Outcome::Unknown),
                };
            };
            Status {
                supported: true,
                available: guard.as_ref().is_some(),
                enabled: self.accepting.load(Ordering::Acquire)
                    && guard.as_ref().is_some_and(|s| s.enabled),
                automatic_checks_enabled: guard.as_ref().is_some_and(|s| {
                    s.automatic_checks_enabled && s.automatic_consent_version == 1
                }),
                automatic_checks_supported: true,
                automatic_checks_paused: false,
                notices_supported: permission != Permission::Unavailable,
                system: system_name(),
                permission,
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

        /// Stops the notices only (the add-on): the automatic document checks are a separate
        /// choice and keep running.
        pub fn suspend_notices(&self) {
            self.accepting.store(false, Ordering::Release);
            self.consent_epoch.fetch_add(1, Ordering::AcqRel);
        }

        pub fn set_enabled(&self, enabled: bool) -> Result<Status, Error> {
            // Where the OS cannot show a notice there is nothing to turn on.
            if enabled && self.backend.permission() == Permission::Unavailable {
                return Err(Error::Unavailable);
            }
            if enabled {
                // The system's own question, where it has one (macOS), is asked now: with the
                // choice, never at launch, and before the ledger lock is taken, because the
                // patient may take a while to answer. A refusal is not an error: the notice is
                // saved as wanted and the status says honestly that the system blocks it.
                self.backend.request_permission();
            }
            if !enabled {
                // This happens before any blocking ledger write/lock.
                self.suspend_notices();
            }
            let mut guard = self.state.lock().map_err(|_| Error::Storage)?;
            let mut next = guard.as_ref().ok_or(Error::Unavailable)?.clone();
            next.enabled = enabled;
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

        /// "Show a test notice": the same generic notice an arrival shows, with a fixed sentence and
        /// no document or clinic data, so a person can see that the system lets myCarlos notify.
        /// Only while notices are allowed; no ledger entry, no effect on the checks. The disable
        /// path takes the same lock, so a notice cannot be raised after notices were turned off.
        pub fn send_test_notice(&self) -> TestNotice {
            if !self.supported {
                return TestNotice::NotAllowed;
            }
            // Asked before the state lock is taken: on a Mac the answer is a round trip of up to
            // five seconds, and nothing else may wait behind it. Only the notice itself is posted
            // with the lock held (`accept` is bounded and never asks).
            let permission = self.backend.permission();
            let Ok(guard) = self.state.lock() else {
                return TestNotice::Failed;
            };
            let Some(state) = guard.as_ref() else {
                return TestNotice::NotAllowed;
            };
            if !state.enabled || !self.accepting.load(Ordering::Acquire) {
                return TestNotice::NotAllowed;
            }
            // `state` stays locked through the OS call on purpose: turning notices off takes the
            // same lock, so a notice cannot be raised after notices were turned off.
            {
                let Ok(mut last) = self.last_test.lock() else {
                    return TestNotice::Failed;
                };
                if last.is_some_and(|at| at.elapsed() < self.test_interval) {
                    return TestNotice::TooSoon;
                }
                *last = Some(std::time::Instant::now());
            }
            match permission {
                Permission::Allowed | Permission::NotYetAsked => {
                    match (self.test_notice)(state.locale) {
                        Some(body) => {
                            let still_enabled = || self.accepting.load(Ordering::Acquire);
                            match self.backend.accept(&body, &still_enabled) {
                                Ok(()) => TestNotice::Shown,
                                Err(_) => TestNotice::Failed,
                            }
                        }
                        None => TestNotice::Failed,
                    }
                }
                Permission::Blocked => TestNotice::Blocked,
                _ => TestNotice::Failed,
            }
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
            // Asked before the state lock is taken (see `send_test_notice`); only `accept`, which
            // is bounded and never asks, runs with the lock held.
            let permission = self.backend.permission();
            let Ok(mut guard) = self.state.lock() else {
                return;
            };
            let Some(state) = guard.as_ref() else {
                return;
            };
            // Notices turned off or on while the permission was being asked (it is asked before the
            // lock): the arrival is still recorded, as never accepted, so that it is not shown
            // later either.
            let consent_changed = self.consent_epoch.load(Ordering::Acquire) != epoch;
            if (!state.enabled && !consent_changed) || state.events.iter().any(|e| e.key == key) {
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
            let outcome = match permission {
                Permission::Allowed | Permission::NotYetAsked if current() => {
                    match (self.notice)(next.locale) {
                        Some(body) => match self.backend.accept(&body, &current) {
                            Ok(()) => Outcome::OsAccepted,
                            Err(Error::Cancelled) => Outcome::Unknown,
                            Err(_) => Outcome::Failed,
                        },
                        None => Outcome::Failed,
                    }
                }
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
        /// A second, different delivery (its own identity, so it is not a repeat).
        fn arrival_other(runtime: &Runtime) {
            runtime.arrived(
                Uuid::from_u128(1),
                Uuid::from_u128(2),
                &"B".repeat(43),
                "00000000-0000-4000-8000-000000000005",
                Uuid::from_u128(6),
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
            // Turning the notices off is not turning the automatic checks off.
            runtime.set_enabled(false).ok().unwrap();
            assert!(runtime.status().automatic_checks_enabled);
            assert!(runtime.automatic_eligible());
            assert!(!runtime.status().enabled);
        }

        fn mock_runtime(path: std::path::PathBuf) -> (Runtime, Arc<AtomicUsize>) {
            let calls = Arc::new(AtomicUsize::new(0));
            let runtime = Runtime::load(
                path,
                Box::new(Mock {
                    calls: calls.clone(),
                    fail: false,
                }),
            );
            (runtime, calls)
        }

        #[test]
        fn automatic_checks_work_with_the_notices_off_and_a_notice_is_never_shown() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let (runtime, calls) = mock_runtime(path.clone());
            assert!(!runtime.automatic_eligible());
            // No notice switch was ever turned on: the automatic check can still be.
            let status = runtime.set_automatic_checks(true).ok().unwrap();
            assert!(status.automatic_checks_enabled && !status.enabled);
            assert!(runtime.automatic_eligible());
            let on_disk: Ledger = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert!(on_disk.automatic_checks_enabled && !on_disk.enabled);
            assert_eq!(on_disk.automatic_consent_version, 1);
            // A document arriving through an automatic check raises no notice and is not recorded.
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 0);
            assert!(saved(&path).events.is_empty());
            // It is still on after a restart.
            let (again, _) = mock_runtime(path);
            assert!(again.automatic_eligible());
            assert!(again.status().automatic_checks_enabled && !again.status().enabled);
        }

        #[test]
        fn each_switch_turns_the_other_neither_on_nor_off() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, calls) = mock_runtime(temp.path().join("state.json"));
            runtime.set_enabled(true).ok().unwrap();
            // Notices alone: no automatic check.
            assert!(runtime.status().enabled && !runtime.status().automatic_checks_enabled);
            assert!(!runtime.automatic_eligible());
            runtime.set_automatic_checks(true).ok().unwrap();
            // Both on: an arrival raises its notice.
            assert!(runtime.status().enabled && runtime.status().automatic_checks_enabled);
            arrival(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            // Notices off: the checks go on and nothing more is shown.
            runtime.set_enabled(false).ok().unwrap();
            assert!(!runtime.status().enabled && runtime.status().automatic_checks_enabled);
            assert!(runtime.automatic_eligible());
            arrival_other(&runtime);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            // Notices on again, checks off: the notice add-on stays, the checks stop.
            runtime.set_enabled(true).ok().unwrap();
            runtime.set_automatic_checks(false).ok().unwrap();
            assert!(runtime.status().enabled && !runtime.status().automatic_checks_enabled);
            assert!(!runtime.automatic_eligible());
        }

        #[test]
        fn a_saved_file_keeps_what_was_on_whichever_way_it_was() {
            let temp = tempfile::tempdir().unwrap();
            for (name, enabled, automatic) in [
                ("both", true, true),
                ("notices-only", true, false),
                ("automatic-only", false, true),
            ] {
                let path = temp.path().join(format!("{name}.json"));
                let file = format!(
                    r#"{{"version":2,"enabled":{enabled},"events":[],"automatic_checks_enabled":{automatic},"automatic_consent_version":{}}}"#,
                    u8::from(automatic)
                );
                fs::write(&path, &file).unwrap();
                let (runtime, _) = mock_runtime(path.clone());
                let status = runtime.status();
                assert!(status.available, "{name}");
                assert_eq!(status.enabled, enabled, "{name}");
                assert_eq!(status.automatic_checks_enabled, automatic, "{name}");
                assert_eq!(runtime.automatic_eligible(), automatic, "{name}");
                // Loading rewrites nothing.
                assert_eq!(fs::read(&path).unwrap(), file.as_bytes(), "{name}");
            }
        }

        #[test]
        fn automatic_checks_without_their_own_consent_are_not_a_valid_file() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let original = br#"{"version":2,"enabled":false,"events":[],"automatic_checks_enabled":true,"automatic_consent_version":0}"#;
            fs::write(&path, original).unwrap();
            let (runtime, _) = mock_runtime(path.clone());
            assert!(!runtime.status().available);
            assert!(!runtime.automatic_eligible());
            assert_eq!(fs::read(&path).unwrap(), original);
        }

        #[cfg(not(windows))]
        #[test]
        fn where_no_notice_can_be_shown_the_automatic_checks_still_work() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join("state.json");
            let runtime = Runtime::new(path.clone(), "FAKE.app".to_owned());
            let status = runtime.status();
            assert!(status.supported && status.available);
            assert!(status.automatic_checks_supported && !status.notices_supported);
            assert!(!status.enabled && !status.automatic_checks_enabled);
            // There is no notice to turn on, and nothing is saved by trying.
            assert!(matches!(runtime.set_enabled(true), Err(Error::Unavailable)));
            assert!(!path.exists());
            // The automatic checks have their own consent and need no notice.
            let status = runtime.set_automatic_checks(true).ok().unwrap();
            assert!(status.automatic_checks_enabled && !status.notices_supported);
            assert!(runtime.automatic_eligible());
            assert!(Runtime::new(path, "FAKE.app".to_owned()).automatic_eligible());
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

        /// A backend whose permission is chosen, recording the sentences it was asked to show.
        struct Chosen {
            permission: Permission,
            bodies: Arc<Mutex<Vec<String>>>,
            reject: bool,
        }
        impl Backend for Chosen {
            fn permission(&self) -> Permission {
                self.permission
            }
            fn accept(&self, body: &str, current: &dyn Fn() -> bool) -> Result<(), Error> {
                if !current() {
                    return Err(Error::Cancelled);
                }
                self.bodies.lock().unwrap().push(body.to_string());
                if self.reject {
                    Err(Error::OsRejected)
                } else {
                    Ok(())
                }
            }
        }
        fn test_runtime(
            dir: &std::path::Path,
            permission: Permission,
            reject: bool,
        ) -> (Runtime, Arc<Mutex<Vec<String>>>) {
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let runtime = Runtime::load(
                dir.join("state.json"),
                Box::new(Chosen {
                    permission,
                    bodies: Arc::clone(&bodies),
                    reject,
                }),
            );
            (runtime, bodies)
        }

        #[test]
        fn a_test_notice_shows_the_fixed_sentence_and_nothing_of_a_document() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, bodies) = test_runtime(temp.path(), Permission::Allowed, false);
            runtime.set_enabled(true).ok().unwrap();
            assert_eq!(runtime.send_test_notice(), TestNotice::Shown);
            let sentence = UiLocale::default()
                .text(crate::ui_text_ids::MessageId::NativeNoticeTest)
                .unwrap();
            assert_eq!(*bodies.lock().unwrap(), vec![sentence.clone()]);
            assert_eq!(sentence, "This is a test notice from myCarlos.");
            // Not an arrival: the ledger holds no event and the last outcome is unchanged.
            let saved = fs::read_to_string(runtime.ledger_path()).unwrap();
            assert!(saved.contains("\"events\":[]"), "{saved}");
            assert_eq!(runtime.status().last_outcome, None);
        }

        #[test]
        fn a_test_notice_is_in_the_language_the_app_reported_and_falls_back_to_english() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, bodies) = test_runtime(temp.path(), Permission::Allowed, false);
            runtime.set_enabled(true).ok().unwrap();
            runtime.observe_locale(Some(UiLocale::Fr));
            let runtime = runtime.with_test_interval(std::time::Duration::ZERO);
            assert_eq!(runtime.send_test_notice(), TestNotice::Shown);
            let french = UiLocale::Fr
                .text(crate::ui_text_ids::MessageId::NativeNoticeTest)
                .unwrap();
            assert_eq!(bodies.lock().unwrap().last(), Some(&french));
            // No catalogue text at all: nothing reaches the system, and it says it failed.
            let runtime = runtime.with_test_notice(|_| None);
            assert_eq!(runtime.send_test_notice(), TestNotice::Failed);
            assert_eq!(bodies.lock().unwrap().len(), 1);
        }

        #[test]
        fn a_test_notice_waits_for_notices_to_be_allowed_and_stops_when_they_are_turned_off() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, bodies) = test_runtime(temp.path(), Permission::Allowed, false);
            let runtime = runtime.with_test_interval(std::time::Duration::ZERO);
            // Never allowed: nothing is shown.
            assert_eq!(runtime.send_test_notice(), TestNotice::NotAllowed);
            runtime.set_enabled(true).ok().unwrap();
            assert_eq!(runtime.send_test_notice(), TestNotice::Shown);
            runtime.set_enabled(false).ok().unwrap();
            assert_eq!(runtime.send_test_notice(), TestNotice::NotAllowed);
            assert_eq!(bodies.lock().unwrap().len(), 1);
        }

        #[test]
        fn a_test_notice_is_rate_limited_and_a_refused_press_does_not_extend_the_wait() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, bodies) = test_runtime(temp.path(), Permission::Allowed, false);
            runtime.set_enabled(true).ok().unwrap();
            assert_eq!(runtime.send_test_notice(), TestNotice::Shown);
            assert_eq!(runtime.send_test_notice(), TestNotice::TooSoon);
            assert_eq!(runtime.send_test_notice(), TestNotice::TooSoon);
            assert_eq!(bodies.lock().unwrap().len(), 1);
            // After the wait it works again (the wait is a constant of a few seconds).
            assert!(TEST_NOTICE_INTERVAL >= std::time::Duration::from_secs(2));
            let runtime = runtime.with_test_interval(std::time::Duration::ZERO);
            assert_eq!(runtime.send_test_notice(), TestNotice::Shown);
            assert_eq!(bodies.lock().unwrap().len(), 2);
        }

        #[test]
        fn only_a_definite_disabled_blocks_and_a_failed_question_is_not_yet_asked() {
            assert_eq!(permission_for(OsSetting::Enabled), Permission::Allowed);
            assert_eq!(permission_for(OsSetting::Disabled), Permission::Blocked);
            assert_eq!(permission_for(OsSetting::Failed), Permission::NotYetAsked);
            assert!(may_show(OsSetting::Enabled));
            assert!(may_show(OsSetting::Failed));
            assert!(!may_show(OsSetting::Disabled));
        }

        #[test]
        fn an_app_the_system_has_no_setting_for_yet_still_shows_its_first_test_notice() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, shown) = test_runtime(temp.path(), Permission::NotYetAsked, false);
            runtime.set_enabled(true).ok().unwrap();
            assert_eq!(runtime.status().permission, Permission::NotYetAsked);
            assert_eq!(runtime.send_test_notice(), TestNotice::Shown);
            assert_eq!(shown.lock().unwrap().len(), 1);
        }

        #[test]
        fn an_app_the_system_has_no_setting_for_yet_still_shows_an_arrival() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, shown) = test_runtime(temp.path(), Permission::NotYetAsked, false);
            runtime.set_enabled(true).ok().unwrap();
            let device = "A".repeat(43);
            runtime.arrived(
                Uuid::new_v4(),
                Uuid::new_v4(),
                &device,
                &Uuid::new_v4().to_string(),
                Uuid::new_v4(),
                || true,
            );
            assert_eq!(runtime.status().last_outcome, Some(Outcome::OsAccepted));
            assert_eq!(shown.lock().unwrap().len(), 1);
        }

        #[test]
        fn a_blocked_or_unreachable_system_still_shows_no_arrival() {
            for permission in [
                Permission::Blocked,
                Permission::Unknown,
                Permission::Unavailable,
            ] {
                let temp = tempfile::tempdir().unwrap();
                if permission == Permission::Unavailable {
                    // Where no notice can be shown the switch cannot be turned on, but a saved
                    // file (from another build, or a roaming profile) can still say it is on.
                    fs::write(
                        temp.path().join("state.json"),
                        br#"{"version":2,"enabled":true,"events":[],"automatic_checks_enabled":false,"automatic_consent_version":0}"#,
                    )
                    .unwrap();
                }
                let (runtime, shown) = test_runtime(temp.path(), permission, false);
                if permission != Permission::Unavailable {
                    runtime.set_enabled(true).ok().unwrap();
                }
                let device = "A".repeat(43);
                runtime.arrived(
                    Uuid::new_v4(),
                    Uuid::new_v4(),
                    &device,
                    &Uuid::new_v4().to_string(),
                    Uuid::new_v4(),
                    || true,
                );
                assert_eq!(runtime.status().last_outcome, Some(Outcome::Unknown));
                assert!(shown.lock().unwrap().is_empty(), "{permission:?}");
            }
        }

        #[test]
        fn the_not_yet_asked_state_reaches_the_page_by_its_own_name() {
            let json = serde_json::to_string(&Permission::NotYetAsked).unwrap();
            assert_eq!(json, "\"not_yet_asked\"");
        }

        #[test]
        fn a_macos_authorization_status_reads_as_the_matching_permission() {
            // notDetermined, denied, authorized, provisional, ephemeral, and one nobody knows.
            assert_eq!(permission_for_authorization(0), Permission::NotYetAsked);
            assert_eq!(permission_for_authorization(1), Permission::Blocked);
            assert_eq!(permission_for_authorization(2), Permission::Allowed);
            assert_eq!(permission_for_authorization(3), Permission::Allowed);
            assert_eq!(permission_for_authorization(4), Permission::Allowed);
            assert_eq!(permission_for_authorization(5), Permission::Unknown);
            assert_eq!(permission_for_authorization(-1), Permission::Unknown);
        }

        /// A backend that says what it was asked: how many times the system's question was put.
        struct Asking {
            before: Permission,
            after: Permission,
            asked: Arc<AtomicU64>,
        }
        impl Backend for Asking {
            fn permission(&self) -> Permission {
                if self.asked.load(Ordering::SeqCst) > 0 {
                    self.after
                } else {
                    self.before
                }
            }
            fn request_permission(&self) -> Permission {
                self.asked.fetch_add(1, Ordering::SeqCst);
                self.after
            }
            // Posts as the macOS backend does: only on an allowed answer, and never asking.
            fn accept(&self, _body: &str, _current: &dyn Fn() -> bool) -> Result<(), Error> {
                may_post(self.permission())
            }
        }

        fn asking_runtime(
            dir: &std::path::Path,
            before: Permission,
            after: Permission,
        ) -> (Runtime, Arc<AtomicU64>) {
            let asked = Arc::new(AtomicU64::new(0));
            let runtime = Runtime::load(
                dir.join("state.json"),
                Box::new(Asking {
                    before,
                    after,
                    asked: Arc::clone(&asked),
                }),
            );
            (runtime, asked)
        }

        #[test]
        fn the_system_is_asked_when_notices_are_turned_on_and_not_before() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, asked) =
                asking_runtime(temp.path(), Permission::NotYetAsked, Permission::Allowed);
            // Reading the status never asks: not at launch, not when the page looks.
            assert_eq!(runtime.status().permission, Permission::NotYetAsked);
            assert_eq!(asked.load(Ordering::SeqCst), 0);
            // Turning notices on is the moment.
            let status = runtime.set_enabled(true).ok().unwrap();
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            assert!(status.enabled);
            assert_eq!(status.permission, Permission::Allowed);
            // Turning them off asks nothing.
            runtime.set_enabled(false).ok().unwrap();
            assert_eq!(asked.load(Ordering::SeqCst), 1);
        }

        #[test]
        fn a_refused_question_is_said_honestly_and_the_choice_is_still_saved() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, asked) =
                asking_runtime(temp.path(), Permission::NotYetAsked, Permission::Blocked);
            let status = runtime.set_enabled(true).ok().unwrap();
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            // The patient's choice stands; the system's refusal is shown, not hidden.
            assert!(status.enabled);
            assert_eq!(status.permission, Permission::Blocked);
            assert_eq!(runtime.send_test_notice(), TestNotice::Blocked);
        }

        #[test]
        fn where_the_system_has_no_notice_to_ask_for_nothing_is_asked() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, asked) = asking_runtime(
                temp.path(),
                Permission::Unavailable,
                Permission::Unavailable,
            );
            assert!(matches!(runtime.set_enabled(true), Err(Error::Unavailable)));
            assert_eq!(asked.load(Ordering::SeqCst), 0);
        }

        #[test]
        fn only_an_allowed_answer_lets_a_notice_be_posted_and_posting_never_asks() {
            assert!(may_post(Permission::Allowed).is_ok());
            for permission in [
                Permission::NotYetAsked,
                Permission::Blocked,
                Permission::Unknown,
                Permission::Unavailable,
            ] {
                assert!(matches!(may_post(permission), Err(Error::OsRejected)));
            }
        }

        #[test]
        fn an_arrival_or_a_test_notice_before_the_question_is_answered_never_asks_it() {
            let temp = tempfile::tempdir().unwrap();
            // The patient turned notices on and left macOS's question unanswered.
            let (runtime, asked) = asking_runtime(
                temp.path(),
                Permission::NotYetAsked,
                Permission::NotYetAsked,
            );
            runtime.set_enabled(true).ok().unwrap();
            assert_eq!(asked.load(Ordering::SeqCst), 1);
            let device = "A".repeat(43);
            runtime.arrived(
                Uuid::new_v4(),
                Uuid::new_v4(),
                &device,
                &Uuid::new_v4().to_string(),
                Uuid::new_v4(),
                || true,
            );
            assert_eq!(runtime.status().last_outcome, Some(Outcome::Failed));
            assert_eq!(runtime.send_test_notice(), TestNotice::Failed);
            assert_eq!(
                asked.load(Ordering::SeqCst),
                1,
                "only turning notices on asks the system"
            );
        }

        #[test]
        fn the_status_names_the_system_for_the_words_of_the_permission_lines() {
            let temp = tempfile::tempdir().unwrap();
            let (runtime, _) = test_runtime(temp.path(), Permission::Allowed, false);
            let system = serde_json::to_value(runtime.status()).unwrap()["system"].clone();
            assert!(["windows", "macos", "other"].contains(&system.as_str().unwrap()));
        }

        #[test]
        fn a_test_notice_says_when_windows_blocks_notices_or_rejects_it() {
            let temp = tempfile::tempdir().unwrap();
            let (blocked, shown) = test_runtime(temp.path(), Permission::Blocked, false);
            blocked.set_enabled(true).ok().unwrap();
            assert_eq!(blocked.send_test_notice(), TestNotice::Blocked);
            assert!(shown.lock().unwrap().is_empty());
            let other = tempfile::tempdir().unwrap();
            let (unknown, shown) = test_runtime(other.path(), Permission::Unknown, false);
            unknown.set_enabled(true).ok().unwrap();
            assert_eq!(unknown.send_test_notice(), TestNotice::Failed);
            assert!(shown.lock().unwrap().is_empty());
            let third = tempfile::tempdir().unwrap();
            let (rejecting, _) = test_runtime(third.path(), Permission::Allowed, true);
            rejecting.set_enabled(true).ok().unwrap();
            assert_eq!(rejecting.send_test_notice(), TestNotice::Failed);
        }

        #[test]
        fn the_test_notice_result_has_stable_wire_names() {
            for (value, name) in [
                (TestNotice::Shown, "shown"),
                (TestNotice::Blocked, "blocked"),
                (TestNotice::NotAllowed, "notAllowed"),
                (TestNotice::TooSoon, "tooSoon"),
                (TestNotice::Failed, "failed"),
            ] {
                assert_eq!(serde_json::to_value(value).unwrap(), name);
            }
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

#[cfg(any(test, desktop))]
pub use active::Runtime;

/// Phones: no notices and no automatic checks.
#[cfg(not(any(test, desktop)))]
pub struct Runtime;
#[cfg(not(any(test, desktop)))]
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
    pub fn send_test_notice(&self) -> TestNotice {
        TestNotice::NotAllowed
    }
    pub(crate) fn observe_locale(&self, _locale: Option<UiLocale>) {}
    pub fn set_enabled(&self, _enabled: bool) -> Result<Status, Error> {
        Err(Error::Unavailable)
    }
    pub fn set_automatic_checks(&self, _enabled: bool) -> Result<Status, Error> {
        Err(Error::Unavailable)
    }
}
