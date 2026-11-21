//! The tray poller (#230): while myCarlos sits in the tray with the vault locked, ask each linked
//! Portal, with its notice key alone, whether anything is waiting, and tell the patient with one
//! fixed sentence. It holds no vault key, no device key and no link key: all it has is what
//! `notice-keys.v1` gives (a Portal's address, a link id, a vault id, a key id and the notice
//! key), and what it learns is "waiting" or "not". Nothing about a clinic, a person or a
//! document reaches it, so none can reach the notice.
//!
//! Supervisor default while Ben is away (#230): every 5 minutes with up to 20 % jitter either
//! way, never sooner than 2 minutes (the Portal itself answers at most once in 120 s), doubling
//! after a failure up to an hour, and only in the tray: the poller is told whether it may run
//! (`Conditions`) and never starts a check on its own authority.
#![cfg_attr(not(test), allow(dead_code))]

use crate::notice_key::{NoticeKeyEntry, NoticeKeys, WrapKeyStore};
use crate::ui_text::UiLocale;
use crate::ui_text_ids::MessageId;
use std::collections::HashMap;
use std::time::Duration;
use uuid::Uuid;

/// The usual spacing between checks of one Portal.
pub(crate) const INTERVAL: Duration = Duration::from_secs(300);
/// The least spacing ever: the Portal answers each key at most once in 120 seconds.
pub(crate) const FLOOR: Duration = Duration::from_secs(120);
/// The longest wait after failures.
pub(crate) const CEILING: Duration = Duration::from_secs(3600);

/// What a check of one Portal came to.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Reply {
    /// A document is waiting.
    Waiting,
    /// Nothing is waiting.
    Nothing,
    /// Asked too soon; the Portal says to wait this many seconds.
    TooSoon(u64),
    /// The Portal does not know this key any more (a revoked key, a removed device, an unknown
    /// key all look alike): it is finished, and wiped.
    Gone,
    /// The Portal could not be reached or answered something else.
    Failed,
}

/// The Portal question, so the poller is tested without a network.
pub(crate) trait WaitingPortal {
    fn ask(&self, entry: &NoticeKeyEntry) -> Reply;
}

/// Whether the poller may run now. All four must hold; the tray is where it lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Conditions {
    /// Tray mode on, and the icon is there.
    pub(crate) in_tray: bool,
    /// The vault is locked (an open vault checks documents itself).
    pub(crate) locked: bool,
    /// Tray notices are wanted: tray mode on and notices on.
    pub(crate) wanted: bool,
}

impl Conditions {
    pub(crate) fn may_run(self) -> bool {
        self.in_tray && self.locked && self.wanted
    }
}

/// One tick's result.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Tick {
    /// A first "waiting" since the last unlock: the patient is told once.
    pub(crate) announce: bool,
    /// Keys wiped because the Portal no longer knows them.
    pub(crate) gone: usize,
    /// How many Portals were asked.
    pub(crate) asked: usize,
}

struct Slot {
    next_at: Duration,
    failures: u32,
}

/// What was last seen and when each key is next due. Time is a plain `Duration` since the poller
/// started, so tests control it.
pub(crate) struct Poller {
    slots: HashMap<Uuid, Slot>,
    announced: bool,
    waiting: bool,
}

/// The wait after `failures` failures in a row, before jitter: the usual interval, doubled for
/// each, to the ceiling.
pub(crate) fn backoff(failures: u32) -> Duration {
    let doubled = INTERVAL.saturating_mul(1_u32.checked_shl(failures.min(10)).unwrap_or(u32::MAX));
    doubled.min(CEILING)
}

/// `base` with up to 20 % added or taken away, by `unit` in `[-1.0, 1.0]`, never under the floor.
pub(crate) fn jittered(base: Duration, unit: f64) -> Duration {
    let unit = unit.clamp(-1.0, 1.0);
    let moved = base.as_secs_f64() * (1.0 + 0.2 * unit);
    Duration::from_secs_f64(moved.max(0.0)).max(FLOOR)
}

impl Poller {
    pub(crate) fn new() -> Self {
        Self {
            slots: HashMap::new(),
            announced: false,
            waiting: false,
        }
    }

    /// The patient unlocked (or the tray went away): the next "waiting" is news again.
    pub(crate) fn reset(&mut self) {
        self.announced = false;
        self.waiting = false;
        self.slots.clear();
    }

    /// Whether the last answers said something is waiting (the tooltip and the unlock screen).
    pub(crate) fn waiting(&self) -> bool {
        self.waiting
    }

    /// When the next check is due, from `now`, or `None` with nothing to ask.
    pub(crate) fn next_due(&self, now: Duration) -> Option<Duration> {
        self.slots
            .values()
            .map(|slot| slot.next_at.saturating_sub(now))
            .min()
    }

    /// Asks every Portal that is due. `jitter` gives a unit in `[-1.0, 1.0]` for each schedule.
    pub(crate) fn tick<S: WrapKeyStore>(
        &mut self,
        now: Duration,
        conditions: Conditions,
        keys: &NoticeKeys<S>,
        portal: &dyn WaitingPortal,
        jitter: &mut dyn FnMut() -> f64,
    ) -> Tick {
        let mut tick = Tick::default();
        if !conditions.may_run() {
            return tick;
        }
        let Ok(entries) = keys.entries() else {
            return tick;
        };
        // Keys that were wiped since are forgotten.
        self.slots
            .retain(|link, _| entries.iter().any(|entry| entry.link_id == *link));
        let mut any_waiting = false;
        for entry in &entries {
            let slot = self.slots.entry(entry.link_id).or_insert(Slot {
                next_at: now,
                failures: 0,
            });
            if slot.next_at > now {
                // Not due: keep what it last said.
                any_waiting |= self.waiting;
                continue;
            }
            tick.asked += 1;
            let reply = portal.ask(entry);
            let slot = self.slots.get_mut(&entry.link_id).expect("slot made above");
            match reply {
                Reply::Waiting | Reply::Nothing => {
                    slot.failures = 0;
                    slot.next_at = now + jittered(INTERVAL, jitter());
                    any_waiting |= reply == Reply::Waiting;
                }
                Reply::TooSoon(seconds) => {
                    slot.next_at = now + Duration::from_secs(seconds).max(FLOOR);
                }
                Reply::Gone => {
                    let id = entry.link_id;
                    let _ = keys.wipe(|e| e.link_id == id);
                    self.slots.remove(&id);
                    tick.gone += 1;
                }
                Reply::Failed => {
                    slot.failures = slot.failures.saturating_add(1);
                    slot.next_at = now + jittered(backoff(slot.failures), jitter());
                }
            }
        }
        self.waiting = any_waiting;
        if any_waiting && !self.announced {
            self.announced = true;
            tick.announce = true;
        }
        tick
    }
}

/// The one sentence the OS notice, the tray tooltip and the unlock screen carry: "A new document
/// is waiting. Unlock myCarlos to see it." It takes **only the language**. Nothing the poller
/// holds (a Portal's address, a link or key id, the answer) is a parameter, so none of it, and
/// nothing from the vault, can appear in the words: the catalogue sentence has no placeholder
/// and this function has nowhere to put one.
pub(crate) fn waiting_notice_text(locale: Option<UiLocale>) -> String {
    crate::desktop_background::tray_text(locale, MessageId::NativeTrayWaiting)
}

/// Where the notice goes (an OS toast, the tooltip, the unlock screen). It is only ever given
/// `waiting_notice_text`.
pub(crate) trait Notify {
    fn show(&self, text: &str);
}

/// What a tick asks of the patient's screen: the one sentence, once, when there is news.
pub(crate) fn act_on(tick: &Tick, locale: Option<UiLocale>, notify: &dyn Notify) {
    if tick.announce {
        notify.show(&waiting_notice_text(locale));
    }
}

/// The real Portal question: a POST signed by the notice key. Where the build has no Portal
/// client, every check fails.
pub(crate) struct HttpWaiting;

impl WaitingPortal for HttpWaiting {
    fn ask(&self, entry: &NoticeKeyEntry) -> Reply {
        #[cfg(not(target_os = "android"))]
        {
            match crate::portal_client::waiting_api(entry, "POST", &|| false) {
                Ok(reply) => reply_from(reply.status, &reply.body, reply.retry_after),
                Err(_) => Reply::Failed,
            }
        }
        #[cfg(target_os = "android")]
        {
            let _ = entry;
            Reply::Failed
        }
    }
}

/// How an answer reads: 200 with `{"waiting": true|false}`, 429 with a wait, 404 for a key the
/// Portal does not know. Anything else is a failure, never a "waiting".
pub(crate) fn reply_from(status: u16, body: &[u8], retry_after: Option<u64>) -> Reply {
    match status {
        200 => match serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .as_ref()
            .and_then(|value| value.as_object())
            .filter(|object| object.len() == 1)
            .and_then(|object| object.get("waiting"))
            .and_then(|waiting| waiting.as_bool())
        {
            Some(true) => Reply::Waiting,
            Some(false) => Reply::Nothing,
            None => Reply::Failed,
        },
        429 => Reply::TooSoon(retry_after.unwrap_or(120)),
        404 => Reply::Gone,
        _ => Reply::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notice_key::FakeWrapKeyStore;
    use std::cell::RefCell;

    const ORIGIN: &str = "https://portal.example.invalid";
    const SECOND: Duration = Duration::from_secs(1);

    fn uuid(n: u128) -> Uuid {
        Uuid::from_u128(0xFAC0_0000_0000_4000_8000_0000_0000_0000 + n)
    }

    fn keys(count: u128) -> (tempfile::TempDir, NoticeKeys<FakeWrapKeyStore>) {
        let temp = tempfile::tempdir().unwrap();
        let keys = NoticeKeys::new(temp.path(), FakeWrapKeyStore::default());
        for n in 0..count {
            keys.make_for(uuid(1), uuid(10 + n), ORIGIN).unwrap();
        }
        (temp, keys)
    }

    const IN_TRAY: Conditions = Conditions {
        in_tray: true,
        locked: true,
        wanted: true,
    };

    /// A Portal that answers from a script and counts what it was asked.
    struct Script {
        replies: RefCell<Vec<Reply>>,
        asked: RefCell<Vec<Uuid>>,
    }
    impl Script {
        fn new(replies: &[Reply]) -> Self {
            Self {
                replies: RefCell::new(replies.iter().rev().copied().collect()),
                asked: RefCell::new(Vec::new()),
            }
        }
    }
    impl WaitingPortal for Script {
        fn ask(&self, entry: &NoticeKeyEntry) -> Reply {
            self.asked.borrow_mut().push(entry.link_id);
            self.replies.borrow_mut().pop().unwrap_or(Reply::Nothing)
        }
    }

    fn no_jitter() -> f64 {
        0.0
    }

    #[test]
    fn it_asks_nothing_unless_in_the_tray_locked_and_wanted() {
        let (_temp, keys) = keys(1);
        let portal = Script::new(&[]);
        for conditions in [
            Conditions {
                in_tray: false,
                ..IN_TRAY
            },
            Conditions {
                locked: false,
                ..IN_TRAY
            },
            Conditions {
                wanted: false,
                ..IN_TRAY
            },
        ] {
            let mut poller = Poller::new();
            let tick = poller.tick(Duration::ZERO, conditions, &keys, &portal, &mut no_jitter);
            assert_eq!(tick, Tick::default());
        }
        assert!(portal.asked.borrow().is_empty());
    }

    #[test]
    fn it_asks_each_portal_once_then_waits_the_interval_and_never_under_the_floor() {
        let (_temp, keys) = keys(2);
        let portal = Script::new(&[]);
        let mut poller = Poller::new();
        let first = poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(first.asked, 2);
        // Not due again until the interval has passed.
        let soon = poller.tick(INTERVAL - SECOND, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(soon.asked, 0);
        let due = poller.tick(INTERVAL, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(due.asked, 2);
        // The most jitter pulls an interval no lower than the floor, and never past 20 %.
        assert!(jittered(INTERVAL, -1.0) >= FLOOR);
        let near = |a: Duration, seconds: f64| (a.as_secs_f64() - seconds).abs() < 1e-6;
        assert!(near(jittered(INTERVAL, -1.0), 240.0));
        assert!(near(jittered(INTERVAL, 1.0), 360.0));
        assert_eq!(jittered(Duration::from_secs(60), -1.0), FLOOR);
        assert_eq!(poller.next_due(INTERVAL), Some(INTERVAL));
    }

    #[test]
    fn a_waiting_answer_announces_once_until_the_patient_unlocks() {
        let (_temp, keys) = keys(1);
        let portal = Script::new(&[Reply::Waiting, Reply::Waiting, Reply::Waiting]);
        let mut poller = Poller::new();
        let first = poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert!(first.announce && poller.waiting());
        let second = poller.tick(INTERVAL, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert!(!second.announce, "the same news is not announced again");
        assert!(poller.waiting());
        // Unlocking resets it: a new waiting document is news again.
        poller.reset();
        assert!(!poller.waiting());
        let again = poller.tick(INTERVAL * 2, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert!(again.announce);
    }

    #[test]
    fn nothing_waiting_announces_nothing() {
        let (_temp, keys) = keys(1);
        let portal = Script::new(&[Reply::Nothing]);
        let mut poller = Poller::new();
        let tick = poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert!(!tick.announce && !poller.waiting());
    }

    #[test]
    fn failures_back_off_by_doubling_to_the_ceiling_and_a_success_resets_them() {
        assert_eq!(backoff(0), INTERVAL);
        assert_eq!(backoff(1), INTERVAL * 2);
        assert_eq!(backoff(2), INTERVAL * 4);
        assert_eq!(backoff(30), CEILING);
        let (_temp, keys) = keys(1);
        let portal = Script::new(&[Reply::Failed, Reply::Failed, Reply::Nothing]);
        let mut poller = Poller::new();
        poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        // After one failure the next check is two intervals away.
        assert_eq!(poller.next_due(Duration::ZERO), Some(INTERVAL * 2));
        let at = INTERVAL * 2;
        poller.tick(at, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(poller.next_due(at), Some(INTERVAL * 4));
        let at = at + INTERVAL * 4;
        poller.tick(at, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(poller.next_due(at), Some(INTERVAL), "a success starts over");
    }

    #[test]
    fn too_soon_waits_what_the_portal_says_but_never_under_the_floor() {
        let (_temp, keys) = keys(1);
        let portal = Script::new(&[Reply::TooSoon(30), Reply::TooSoon(600)]);
        let mut poller = Poller::new();
        poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(poller.next_due(Duration::ZERO), Some(FLOOR));
        poller.tick(FLOOR, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(poller.next_due(FLOOR), Some(Duration::from_secs(600)));
    }

    #[test]
    fn a_portal_that_no_longer_knows_the_key_gets_it_wiped_and_is_never_asked_again() {
        let (_temp, keys) = keys(2);
        let portal = Script::new(&[Reply::Gone, Reply::Nothing]);
        let mut poller = Poller::new();
        let tick = poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(tick.gone, 1);
        assert_eq!(keys.entries().unwrap().len(), 1);
        let kept = keys.entries().unwrap()[0].link_id;
        let later = poller.tick(INTERVAL, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(later.asked, 1);
        assert_eq!(portal.asked.borrow().last(), Some(&kept));
    }

    #[test]
    fn answers_are_read_strictly() {
        assert_eq!(
            reply_from(200, br#"{"waiting": true}"#, None),
            Reply::Waiting
        );
        assert_eq!(
            reply_from(200, br#"{"waiting":false}"#, None),
            Reply::Nothing
        );
        // Anything that is not exactly that one boolean is a failure, never "waiting".
        for body in [
            &br#"{"waiting": "yes"}"#[..],
            br#"{"waiting": true, "count": 3}"#,
            br#"{}"#,
            b"waiting",
            b"",
        ] {
            assert_eq!(reply_from(200, body, None), Reply::Failed, "{body:?}");
        }
        assert_eq!(reply_from(429, b"", Some(45)), Reply::TooSoon(45));
        assert_eq!(reply_from(429, b"", None), Reply::TooSoon(120));
        assert_eq!(reply_from(404, b"", None), Reply::Gone);
        for status in [400, 401, 403, 500, 503] {
            assert_eq!(reply_from(status, b"", None), Reply::Failed);
        }
    }

    /// Remembers every text it was asked to show.
    struct Shown(RefCell<Vec<String>>);
    impl Notify for Shown {
        fn show(&self, text: &str) {
            self.0.borrow_mut().push(text.to_owned());
        }
    }

    #[test]
    fn the_notice_is_exactly_the_catalogue_sentence_in_every_language() {
        let expected = [
            (
                UiLocale::En,
                "A new document is waiting. Unlock myCarlos to see it.",
            ),
            (
                UiLocale::Fr,
                "Un nouveau document est en attente. Déverrouillez myCarlos pour le voir.",
            ),
            (
                UiLocale::Es,
                "Hay un documento nuevo esperando. Desbloquee myCarlos para verlo.",
            ),
            (
                UiLocale::Pl,
                "Czeka nowy dokument. Odblokuj myCarlos, aby go zobaczyć.",
            ),
            (
                UiLocale::PtBr,
                "Há um novo documento esperando. Desbloqueie o myCarlos para vê-lo.",
            ),
            (UiLocale::ZhCn, "有一份新文档在等待。请解锁 myCarlos 查看。"),
            (
                UiLocale::ZhTw,
                "有一份新文件正在等待。請解鎖 myCarlos 查看。",
            ),
        ];
        assert_eq!(expected.len(), UiLocale::ALL.len());
        for (locale, sentence) in expected {
            assert_eq!(waiting_notice_text(Some(locale)), sentence, "{locale:?}");
        }
        // No language, or one that cannot be read: the English sentence, never an empty one.
        assert_eq!(
            waiting_notice_text(None),
            "A new document is waiting. Unlock myCarlos to see it."
        );
    }

    #[test]
    fn no_field_derived_from_vault_data_can_reach_the_notice() {
        // By type: the only way to word the notice takes the language and nothing else, so
        // nothing a key, a link, a Portal or an answer holds can be put into it.
        let _: fn(Option<UiLocale>) -> String = waiting_notice_text;
        // By behaviour: keys that carry a recognisable clinic address, link and vault ids, and a
        // Portal that answers "waiting", produce exactly the catalogue sentence and nothing else.
        let temp = tempfile::tempdir().unwrap();
        let keys = NoticeKeys::new(temp.path(), FakeWrapKeyStore::default());
        let vault = Uuid::from_u128(0xFAC0_DEAD_0000_4000_8000_0000_0000_0001);
        let link = Uuid::from_u128(0xFAC0_BEEF_0000_4000_8000_0000_0000_0002);
        let origin = "https://FAKE-Riverside-Clinic.example.invalid/patient";
        let made = keys.make_for(vault, link, origin).unwrap();
        let portal = Script::new(&[Reply::Waiting]);
        let mut poller = Poller::new();
        let tick = poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert!(tick.announce);
        for locale in UiLocale::ALL {
            let shown = Shown(RefCell::new(Vec::new()));
            act_on(&tick, Some(locale), &shown);
            let texts = shown.0.borrow();
            assert_eq!(texts.len(), 1);
            assert_eq!(texts[0], waiting_notice_text(Some(locale)));
            for secret in [
                origin,
                "FAKE-Riverside",
                &link.to_string(),
                &vault.to_string(),
                &made.key_id,
            ] {
                assert!(!texts[0].contains(secret), "{locale:?} leaked {secret}");
            }
        }
        // No news, nothing shown.
        let quiet = Shown(RefCell::new(Vec::new()));
        act_on(&Tick::default(), None, &quiet);
        assert!(quiet.0.borrow().is_empty());
    }

    #[test]
    fn a_key_that_was_wiped_is_forgotten_by_the_schedule() {
        let (_temp, keys) = keys(1);
        let portal = Script::new(&[]);
        let mut poller = Poller::new();
        poller.tick(Duration::ZERO, IN_TRAY, &keys, &portal, &mut no_jitter);
        keys.wipe_all().unwrap();
        let tick = poller.tick(INTERVAL, IN_TRAY, &keys, &portal, &mut no_jitter);
        assert_eq!(tick, Tick::default());
        assert_eq!(poller.next_due(INTERVAL), None);
    }
}
