//! Remote "documents ready" notices (#192): the patient's consent and this vault's push
//! destinations. No I/O here: the vault keeps this state inside the encrypted manifest
//! (format 9, `remoteNotices`), so nothing outside the vault says which clinics, or how many,
//! a vault is linked to.
//!
//! A destination is reserved and saved BEFORE it is enrolled at the portal, so a later opt-out
//! always keeps its revocation, even while enrollment is still in flight. The portal tombstones a
//! revoked id it never saw, so a late enrollment cannot bring it back.
//!
//! A provider message carries one opaque notice token and nothing else (carlos-portal#80): the
//! device never sees a subscription id, epoch or sequence, and never decodes the portal's hint.
//! It reconciles through its own authenticated document check. Provider tokens and vault keys
//! never enter this state.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The portal allows 16 destinations per linked device, and a vault holds at most 16 links.
const MAX_ACTIVE: usize = 16;
// Active destinations plus pending revocations are bounded together. Opting out never needs
// extra room: it moves active entries into the revocation queue.
const MAX_ENTRIES: usize = 64;
/// The portal's notice token: 16 bytes of a keyed hash, base64url without padding.
const NOTICE_TOKEN_LEN: usize = 22;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Permission {
    #[default]
    Unknown,
    Granted,
    Denied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsentNext {
    RequestPermission,
    ConfigureDestinations,
    OpenSystemSettings,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidInput,
    InvalidState,
    Disabled,
    Capacity,
}

/// The push service a destination is registered with, named as the portal names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    AndroidFcm,
    IosApns,
    MacosApns,
    WindowsWns,
}

impl Platform {
    pub fn wire(self) -> &'static str {
        match self {
            Self::AndroidFcm => "android_fcm",
            Self::IosApns => "ios_apns",
            Self::MacosApns => "macos_apns",
            Self::WindowsWns => "windows_wns",
        }
    }
}

/// The link a destination belongs to. Native-owned, never taken from a notification payload.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    link_id: Uuid,
    device_key_id: String,
}

impl Owner {
    pub fn new(link_id: Uuid, device_key_id: String) -> Result<Self, Error> {
        let owner = Self {
            link_id,
            device_key_id,
        };
        if !owner.valid() {
            return Err(Error::InvalidInput);
        }
        Ok(owner)
    }

    pub fn link_id(&self) -> Uuid {
        self.link_id
    }

    pub fn device_key_id(&self) -> &str {
        &self.device_key_id
    }

    fn valid(&self) -> bool {
        !self.link_id.is_nil()
            && self.device_key_id.len() == 43
            && self
                .device_key_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}

/// One push destination: a device-made id, the push service, and the portal's subscription id
/// once the portal has enrolled it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Destination {
    owner: Owner,
    id: Uuid,
    platform: Platform,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    subscription_id: Option<Uuid>,
}

impl Destination {
    pub fn owner(&self) -> &Owner {
        &self.owner
    }
    pub fn id(&self) -> Uuid {
        self.id
    }
    pub fn platform(&self) -> Platform {
        self.platform
    }
    pub fn subscription_id(&self) -> Option<Uuid> {
        self.subscription_id
    }
    fn valid(&self) -> bool {
        self.owner.valid()
            && !self.id.is_nil()
            && self.subscription_id.is_none_or(|id| !id.is_nil())
    }
}

/// What the manifest keeps (format 9). Read it back only through `Policy::new`, which checks it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteNotices {
    opted_in: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    active: Vec<Destination>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    revocations: Vec<Destination>,
}

impl RemoteNotices {
    pub fn opted_in(&self) -> bool {
        self.opted_in
    }
    pub fn active(&self) -> &[Destination] {
        &self.active
    }
    pub fn revocations(&self) -> &[Destination] {
        &self.revocations
    }

    pub fn is_empty(&self) -> bool {
        !self.opted_in && self.active.is_empty() && self.revocations.is_empty()
    }

    /// The saved shape is consistent: bounded, unique ids, one active destination per link,
    /// nothing active without consent.
    pub fn valid(&self) -> bool {
        let entries = self
            .active
            .iter()
            .chain(&self.revocations)
            .collect::<Vec<_>>();
        let ids = entries
            .iter()
            .map(|d| d.id)
            .collect::<std::collections::HashSet<_>>();
        let links = self
            .active
            .iter()
            .map(|d| d.owner.link_id)
            .collect::<std::collections::HashSet<_>>();
        self.active.len() <= MAX_ACTIVE
            && entries.len() <= MAX_ENTRIES
            && ids.len() == entries.len()
            && links.len() == self.active.len()
            && (self.opted_in || self.active.is_empty())
            && entries.iter().all(|d| d.valid())
    }
}

/// The opaque token a provider message carries. Only its shape is checked: it is never decoded.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NoticeToken(String);

impl NoticeToken {
    pub fn parse(value: &str) -> Result<Self, Error> {
        if value.len() != NOTICE_TOKEN_LEN
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(Error::InvalidInput);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Navigation only. Neither variant authorizes unlocking or collecting content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    UnlockThenClinicDocuments,
    ClinicDocuments,
}

impl Activation {
    pub fn for_vault(unlocked: bool) -> Self {
        if unlocked {
            Self::ClinicDocuments
        } else {
            Self::UnlockThenClinicDocuments
        }
    }
}

/// The saved state plus the OS permission seen in this run, which is never saved: a saved
/// observation must not grant permission after a restart.
#[derive(Clone, Debug)]
pub struct Policy {
    saved: RemoteNotices,
    permission: Permission,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            saved: RemoteNotices::default(),
            permission: Permission::Unknown,
        }
    }
}

impl Policy {
    pub fn new(saved: RemoteNotices) -> Result<Self, Error> {
        if !saved.valid() {
            return Err(Error::InvalidState);
        }
        Ok(Self {
            saved,
            permission: Permission::Unknown,
        })
    }

    pub fn saved(&self) -> &RemoteNotices {
        &self.saved
    }

    pub fn opted_in(&self) -> bool {
        self.saved.opted_in
    }

    pub fn can_notify(&self) -> bool {
        self.saved.opted_in && self.permission == Permission::Granted
    }

    /// Invoke only for the patient's explicit opt-in action, never during startup or polling.
    pub fn opt_in(&mut self) -> ConsentNext {
        self.saved.opted_in = true;
        match self.permission {
            Permission::Unknown => ConsentNext::RequestPermission,
            Permission::Granted => ConsentNext::ConfigureDestinations,
            Permission::Denied => ConsentNext::OpenSystemSettings,
        }
    }

    pub fn opt_out(&mut self) {
        self.saved.opted_in = false;
        self.saved.revocations.append(&mut self.saved.active);
    }

    pub fn permission_changed(&mut self, permission: Permission) {
        self.permission = permission;
        if permission == Permission::Denied {
            self.saved.revocations.append(&mut self.saved.active);
        }
    }

    /// The link's active destination, if it has one.
    pub fn destination_for(&self, link_id: Uuid) -> Option<&Destination> {
        self.saved
            .active
            .iter()
            .find(|d| d.owner.link_id == link_id)
    }

    /// Reserve a fresh native-made destination for a link; save BEFORE enrolling it. A link
    /// keeps one destination: reserving another sends the old one to revocation.
    pub fn reserve_destination(
        &mut self,
        owner: Owner,
        id: Uuid,
        platform: Platform,
    ) -> Result<(), Error> {
        if !self.can_notify() {
            return Err(Error::Disabled);
        }
        if !owner.valid() || id.is_nil() {
            return Err(Error::InvalidInput);
        }
        if self
            .saved
            .active
            .iter()
            .chain(&self.saved.revocations)
            .any(|d| d.id == id)
        {
            return Err(Error::InvalidInput);
        }
        let replace = self
            .saved
            .active
            .iter()
            .position(|d| d.owner.link_id == owner.link_id);
        if self.saved.active.len() + self.saved.revocations.len() >= MAX_ENTRIES
            || (replace.is_none() && self.saved.active.len() >= MAX_ACTIVE)
        {
            return Err(Error::Capacity);
        }
        if let Some(index) = replace {
            let old = self.saved.active.remove(index);
            self.saved.revocations.push(old);
        }
        self.saved.active.push(Destination {
            owner,
            id,
            platform,
            subscription_id: None,
        });
        Ok(())
    }

    /// The portal enrolled this destination as `subscription_id`.
    pub fn enrolled(&mut self, id: Uuid, subscription_id: Uuid) -> Result<(), Error> {
        if subscription_id.is_nil() {
            return Err(Error::InvalidInput);
        }
        let destination = self
            .saved
            .active
            .iter_mut()
            .find(|d| d.id == id)
            .ok_or(Error::InvalidInput)?;
        match destination.subscription_id {
            Some(known) if known != subscription_id => Err(Error::InvalidInput),
            _ => {
                destination.subscription_id = Some(subscription_id);
                Ok(())
            }
        }
    }

    /// Active destinations the portal has not enrolled yet.
    pub fn unenrolled(&self) -> Vec<Destination> {
        self.saved
            .active
            .iter()
            .filter(|d| d.subscription_id.is_none())
            .cloned()
            .collect()
    }

    /// The portal will never enrol this id (it is revoked there, or another device holds it).
    /// It leaves the active list without a revocation: there is nothing to stop.
    pub fn forget_destination(&mut self, id: Uuid) {
        self.saved.active.retain(|d| d.id != id);
    }

    /// The link is gone from this vault: its destination waits for its revocation.
    pub fn remove_link(&mut self, link_id: Uuid) {
        if let Some(index) = self
            .saved
            .active
            .iter()
            .position(|d| d.owner.link_id == link_id)
        {
            let old = self.saved.active.remove(index);
            self.saved.revocations.push(old);
        }
    }

    /// Pending revocations survive locking and restarts; acknowledge each only after the portal
    /// has committed it.
    pub fn pending_revocations(&self) -> Vec<Destination> {
        self.saved.revocations.clone()
    }

    pub fn revocation_acknowledged(&mut self, id: Uuid) {
        self.saved.revocations.retain(|d| d.id != id);
    }
}

/// Tokens already handled in this run, newest last. A duplicate push (a provider retry, or the
/// same token on two destinations) reconciles once. Not saved: after a restart a repeat only
/// costs one more document check.
#[derive(Debug, Default)]
pub struct RecentTokens(std::collections::VecDeque<NoticeToken>);

impl RecentTokens {
    const MAX: usize = 64;

    /// Whether this token is new; it is remembered either way.
    pub fn first_time(&mut self, token: &NoticeToken) -> bool {
        if self.0.contains(token) {
            return false;
        }
        if self.0.len() == Self::MAX {
            self.0.pop_front();
        }
        self.0.push_back(token.clone());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(link: u128) -> Owner {
        Owner::new(Uuid::from_u128(link), "A".repeat(43)).unwrap()
    }
    fn enabled() -> Policy {
        let mut p = Policy::default();
        assert_eq!(p.opt_in(), ConsentNext::RequestPermission);
        p.permission_changed(Permission::Granted);
        p.reserve_destination(owner(2), Uuid::from_u128(3), Platform::WindowsWns)
            .unwrap();
        p
    }
    fn restored(p: &Policy) -> Policy {
        let json = serde_json::to_vec(p.saved()).unwrap();
        Policy::new(serde_json::from_slice(&json).unwrap()).unwrap()
    }

    #[test]
    fn os_permission_neither_opts_in_nor_survives_a_restart() {
        let mut p = Policy::default();
        p.permission_changed(Permission::Granted);
        assert!(!p.opted_in());
        assert_eq!(
            p.reserve_destination(owner(2), Uuid::from_u128(3), Platform::WindowsWns),
            Err(Error::Disabled)
        );
        p.permission_changed(Permission::Denied);
        assert_eq!(p.opt_in(), ConsentNext::OpenSystemSettings);
        let restored = restored(&p);
        assert!(restored.opted_in());
        assert!(!restored.can_notify());
        assert_eq!(restored.permission, Permission::Unknown);
    }

    #[test]
    fn notice_tokens_are_checked_for_shape_only() {
        assert!(NoticeToken::parse("AbCdEfGhIjKlMnOpQr-_01").is_ok());
        for bad in [
            "",
            "AbCdEfGhIjKlMnOpQr-_0",
            "AbCdEfGhIjKlMnOpQr-_012",
            "AbCdEfGhIjKlMnOpQr+/01",
            "AbCdEfGhIjKlMnOpQr-_0=",
            "{\"subscription_id\":1}..",
        ] {
            assert_eq!(NoticeToken::parse(bad), Err(Error::InvalidInput), "{bad}");
        }
    }

    #[test]
    fn a_token_reconciles_once_and_the_oldest_are_forgotten() {
        let mut recent = RecentTokens::default();
        let token = |n: usize| NoticeToken::parse(&format!("{n:0>22}")).unwrap();
        assert!(recent.first_time(&token(1)));
        assert!(!recent.first_time(&token(1)));
        for n in 2..=RecentTokens::MAX + 1 {
            assert!(recent.first_time(&token(n)));
        }
        // token 1 fell out of the window: a very late repeat only costs one more check.
        assert!(recent.first_time(&token(1)));
    }

    #[test]
    fn a_destination_is_saved_before_enrollment_and_keeps_one_subscription() {
        let mut p = enabled();
        assert_eq!(p.unenrolled().len(), 1);
        p.enrolled(Uuid::from_u128(3), Uuid::from_u128(30)).unwrap();
        assert!(p.unenrolled().is_empty());
        // The same answer again is harmless; a different one is refused.
        p.enrolled(Uuid::from_u128(3), Uuid::from_u128(30)).unwrap();
        assert_eq!(
            p.enrolled(Uuid::from_u128(3), Uuid::from_u128(31)),
            Err(Error::InvalidInput)
        );
        assert_eq!(
            p.enrolled(Uuid::from_u128(99), Uuid::from_u128(30)),
            Err(Error::InvalidInput)
        );
        let restored = restored(&p);
        assert_eq!(
            restored
                .destination_for(Uuid::from_u128(2))
                .unwrap()
                .subscription_id(),
            Some(Uuid::from_u128(30))
        );
    }

    #[test]
    fn opt_out_and_denied_permission_queue_every_destination_for_revocation() {
        let mut p = enabled();
        p.reserve_destination(owner(20), Uuid::from_u128(30), Platform::WindowsWns)
            .unwrap();
        p.opt_out();
        assert!(!p.can_notify());
        assert_eq!(p.pending_revocations().len(), 2);
        let mut p = restored(&p);
        p.revocation_acknowledged(Uuid::from_u128(3));
        assert_eq!(
            p.pending_revocations()
                .iter()
                .map(Destination::id)
                .collect::<Vec<_>>(),
            [Uuid::from_u128(30)]
        );

        let mut p = enabled();
        p.permission_changed(Permission::Denied);
        assert!(p.opted_in());
        assert!(!p.can_notify());
        assert_eq!(p.pending_revocations().len(), 1);
    }

    #[test]
    fn a_link_keeps_one_destination_and_an_old_id_never_comes_back() {
        let mut p = enabled();
        p.reserve_destination(owner(2), Uuid::from_u128(5), Platform::WindowsWns)
            .unwrap();
        assert_eq!(
            p.destination_for(Uuid::from_u128(2)).unwrap().id(),
            Uuid::from_u128(5)
        );
        assert_eq!(p.pending_revocations()[0].id(), Uuid::from_u128(3));
        for reused in [3, 5] {
            assert_eq!(
                p.reserve_destination(owner(7), Uuid::from_u128(reused), Platform::WindowsWns),
                Err(Error::InvalidInput)
            );
        }
        p.remove_link(Uuid::from_u128(2));
        assert!(p.destination_for(Uuid::from_u128(2)).is_none());
        assert_eq!(p.pending_revocations().len(), 2);
        p.reserve_destination(owner(8), Uuid::from_u128(9), Platform::WindowsWns)
            .unwrap();
        p.forget_destination(Uuid::from_u128(9));
        assert!(p.destination_for(Uuid::from_u128(8)).is_none());
        assert_eq!(p.pending_revocations().len(), 2);
    }

    #[test]
    fn the_bound_never_prevents_opt_out() {
        let mut p = enabled();
        for n in 1..MAX_ENTRIES {
            p.reserve_destination(
                owner(2),
                Uuid::from_u128(100 + n as u128),
                Platform::WindowsWns,
            )
            .unwrap();
        }
        assert_eq!(
            p.reserve_destination(owner(2), Uuid::from_u128(999), Platform::WindowsWns),
            Err(Error::Capacity)
        );
        p.opt_out();
        assert_eq!(p.pending_revocations().len(), MAX_ENTRIES);
        let _ = restored(&p);
    }

    #[test]
    fn a_saved_state_is_checked_before_it_is_used() {
        let mut value = serde_json::to_value(enabled().saved()).unwrap();
        value["optedIn"] = false.into();
        let opted_out: RemoteNotices = serde_json::from_value(value.clone()).unwrap();
        assert!(!opted_out.valid());
        assert_eq!(Policy::new(opted_out).unwrap_err(), Error::InvalidState);
        value["optedIn"] = true.into();
        value["active"][0]["subscriptionId"] = Uuid::nil().to_string().into();
        assert!(!serde_json::from_value::<RemoteNotices>(value.clone())
            .unwrap()
            .valid());
        value["active"][0]["providerToken"] = "FAKE".into();
        assert!(serde_json::from_value::<RemoteNotices>(value).is_err());
        assert!(RemoteNotices::default().is_empty());
        assert!(!enabled().saved().is_empty());
        assert_eq!(
            serde_json::to_value(Platform::MacosApns).unwrap(),
            Platform::MacosApns.wire()
        );
    }
}
