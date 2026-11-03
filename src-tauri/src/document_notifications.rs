//! Shared notification policy for foreground availability and remote-push adapters (#192).
//!
//! This module performs no I/O and enables no notification transport. The native owner must
//! verify native link ownership, refresh OS permission, serialize access, and atomically
//! persist `encode()` after mutations. Reserve a destination here BEFORE remote enrollment;
//! the server must tombstone revocations even if they arrive before enrollment completes.
//! Provider tokens and vault keys never enter this state.
//! `DisplayProvider` must replace the same opaque notification ID on retry. A crash between OS
//! display and persistence can retry that ID; exactly-once OS delivery is not promised.
//!
//! Closed-app display additionally requires a real provider and Portal after-commit outbox.
//! Platform adapters must apply the same generic template and identity to provider-managed
//! notifications. This policy and mocked tests are not proof of installed-device delivery.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

const VERSION: u8 = 1;
const MAX_HINT_BYTES: usize = 256;
const MAX_STATE_BYTES: usize = 32 * 1024;
const MAX_ACTIVE: usize = 16;
// Active registrations plus pending revocations are bounded together. Disabling never needs
// extra capacity: it moves active entries into the durable revocation queue.
const MAX_ENTRIES: usize = 64;

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
    DisplayFailed,
}

/// Native-owned link identity, never accepted from an untrusted notification payload.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Owner {
    vault_id: Uuid,
    link_id: Uuid,
    device_key_id: String,
}

impl Owner {
    pub fn new(vault_id: Uuid, link_id: Uuid, device_key_id: String) -> Result<Self, Error> {
        let owner = Self {
            vault_id,
            link_id,
            device_key_id,
        };
        if !owner.valid() {
            return Err(Error::InvalidInput);
        }
        Ok(owner)
    }

    fn valid(&self) -> bool {
        !self.vault_id.is_nil()
            && !self.link_id.is_nil()
            && self.device_key_id.len() == 43
            && self
                .device_key_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}

/// No freeform text, document IDs, patient data, links, or commands are permitted.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadyHint {
    version: u8,
    kind: HintKind,
    subscription_id: Uuid,
    epoch: Uuid,
    sequence: u64,
}

#[derive(Clone, Serialize, Deserialize)]
enum HintKind {
    #[serde(rename = "documents_ready")]
    DocumentsReady,
}

impl ReadyHint {
    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_HINT_BYTES {
            return Err(Error::InvalidInput);
        }
        let value: Self = serde_json::from_slice(bytes).map_err(|_| Error::InvalidInput)?;
        if value.version != VERSION
            || value.subscription_id.is_nil()
            || value.epoch.is_nil()
            || value.sequence == 0
            || value.sequence > i64::MAX as u64
        {
            return Err(Error::InvalidInput);
        }
        Ok(value)
    }

    #[cfg(feature = "android-push")]
    pub(crate) fn sequence(&self) -> u64 { self.sequence }

    #[cfg(feature = "android-push")]
    pub(crate) fn matches_destination(&self, id: Uuid, epoch: Uuid) -> bool {
        self.subscription_id == id && self.epoch == epoch
    }

    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(self).map_err(|_| Error::InvalidInput)
    }
}

/// The adapter receives only a fixed generic template and an opaque activation hint.
pub struct GenericNotice<'a> {
    hint: &'a ReadyHint,
}

impl GenericNotice<'_> {
    pub const fn title(&self) -> &'static str {
        "myCarlos"
    }
    pub const fn body(&self) -> &'static str {
        "A new document is available in myCarlos."
    }
    pub fn notification_id(&self) -> Uuid {
        self.hint.subscription_id
    }
    pub fn activation_hint(&self) -> Result<Vec<u8>, Error> {
        self.hint.encode()
    }
}

pub trait DisplayProvider {
    /// Replace this notification ID rather than creating another alert on retry. Map failures
    /// to the fixed error; do not log platform payloads, channel URIs or provider tokens.
    fn show(&mut self, notice: GenericNotice<'_>) -> Result<(), Error>;
}

/// Navigation only. Neither variant authorizes unlocking or collecting content. Keep the
/// original bounded hint and recheck it after unlock or a vault/link change; this enum must
/// never become a saved authorization for a later session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    UnlockThenClinicDocuments,
    ClinicDocuments,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Subscription {
    owner: Owner,
    id: Uuid,
    epoch: Uuid,
    last_notified: u64,
}

#[derive(Serialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    version: u8,
    opted_in: bool,
    active: Vec<Subscription>,
    revocations: Vec<Subscription>,
    // A saved permission observation never grants permission after restart.
    #[serde(skip)]
    permission: Permission,
}

// Private decode shape keeps callers from bypassing restore() with public Deserialize.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedState {
    version: u8,
    opted_in: bool,
    active: Vec<Subscription>,
    revocations: Vec<Subscription>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            version: VERSION,
            opted_in: false,
            active: Vec::new(),
            revocations: Vec::new(),
            permission: Permission::Unknown,
        }
    }
}

impl Policy {
    pub fn restore(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_STATE_BYTES {
            return Err(Error::InvalidState);
        }
        let state: SavedState = serde_json::from_slice(bytes).map_err(|_| Error::InvalidState)?;
        let entries = state
            .active
            .iter()
            .chain(&state.revocations)
            .collect::<Vec<_>>();
        let ids = entries
            .iter()
            .map(|s| s.id)
            .collect::<std::collections::HashSet<_>>();
        let owners = state
            .active
            .iter()
            .map(|s| (s.owner.vault_id, s.owner.link_id))
            .collect::<std::collections::HashSet<_>>();
        if state.version != VERSION
            || state.active.len() > MAX_ACTIVE
            || entries.len() > MAX_ENTRIES
            || ids.len() != entries.len()
            || owners.len() != state.active.len()
            || (!state.opted_in && !state.active.is_empty())
            || entries.iter().any(|s| {
                !s.owner.valid()
                    || s.id.is_nil()
                    || s.epoch.is_nil()
                    || s.last_notified > i64::MAX as u64
            })
        {
            return Err(Error::InvalidState);
        }
        Ok(Self {
            version: state.version,
            opted_in: state.opted_in,
            active: state.active,
            revocations: state.revocations,
            permission: Permission::Unknown,
        })
    }

    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(self).map_err(|_| Error::InvalidState)
    }

    pub fn opted_in(&self) -> bool {
        self.opted_in
    }
    pub fn can_notify(&self) -> bool {
        self.opted_in && self.permission == Permission::Granted
    }

    /// Invoke only for the patient's explicit opt-in action, never during startup or polling.
    pub fn opt_in(&mut self) -> ConsentNext {
        self.opted_in = true;
        match self.permission {
            Permission::Unknown => ConsentNext::RequestPermission,
            Permission::Granted => ConsentNext::ConfigureDestinations,
            Permission::Denied => ConsentNext::OpenSystemSettings,
        }
    }

    pub fn opt_out(&mut self) {
        self.opted_in = false;
        self.revocations.append(&mut self.active);
    }

    pub fn permission_changed(&mut self, permission: Permission) {
        self.permission = permission;
        if permission == Permission::Denied {
            self.revocations.append(&mut self.active);
        }
    }

    /// Reserve a fresh native-generated destination under a verified active link, then persist
    /// BEFORE provider/Portal enrollment. A later opt-out therefore retains its revocation even
    /// if enrollment is still in flight. Server revocation must tombstone unknown IDs, so a late
    /// enrollment cannot resurrect an already revoked destination. This is not server approval.
    /// New epochs require fresh IDs; repeating this intent preserves the cursor.
    pub fn reserve_destination(
        &mut self,
        owner: Owner,
        id: Uuid,
        epoch: Uuid,
    ) -> Result<(), Error> {
        if !self.can_notify() {
            return Err(Error::Disabled);
        }
        if !owner.valid() || id.is_nil() || epoch.is_nil() {
            return Err(Error::InvalidInput);
        }
        if let Some(old) = self.active.iter().find(|s| s.id == id) {
            return if old.owner == owner && old.epoch == epoch {
                Ok(())
            } else {
                Err(Error::InvalidInput)
            };
        }
        if self.revocations.iter().any(|s| s.id == id) {
            return Err(Error::InvalidInput);
        }
        let replace = self
            .active
            .iter()
            .position(|s| s.owner.vault_id == owner.vault_id && s.owner.link_id == owner.link_id);
        if self.active.len() + self.revocations.len() >= MAX_ENTRIES
            || (replace.is_none() && self.active.len() >= MAX_ACTIVE)
        {
            return Err(Error::Capacity);
        }
        if let Some(index) = replace {
            self.revocations.push(self.active.remove(index));
        }
        self.active.push(Subscription {
            owner,
            id,
            epoch,
            last_notified: 0,
        });
        Ok(())
    }

    pub fn remove_owner(&mut self, owner: &Owner) {
        if let Some(index) = self.active.iter().position(|s| &s.owner == owner) {
            self.revocations.push(self.active.remove(index));
        }
    }

    /// Invoke when a vault is replaced or reset, including while offline.
    pub fn remove_vault(&mut self, vault_id: Uuid) {
        let mut kept = Vec::new();
        for subscription in self.active.drain(..) {
            if subscription.owner.vault_id == vault_id {
                self.revocations.push(subscription);
            } else {
                kept.push(subscription);
            }
        }
        self.active = kept;
    }

    /// Pending destinations survive offline/restart. Acknowledge only after server revocation
    /// commits; revocation authorization/credentials live in the native adapter, not this hint.
    pub fn pending_revocations(&self) -> Vec<Uuid> {
        self.revocations.iter().map(|s| s.id).collect()
    }
    pub fn revocation_owner(&self, id: Uuid) -> Option<&Owner> {
        self.revocations
            .iter()
            .find(|s| s.id == id)
            .map(|s| &s.owner)
    }
    pub fn revocation_acknowledged(&mut self, id: Uuid) {
        self.revocations.retain(|s| s.id != id);
    }

    pub fn display_hint(
        &mut self,
        bytes: &[u8],
        provider: &mut impl DisplayProvider,
    ) -> Result<bool, Error> {
        let hint = ReadyHint::decode(bytes)?;
        if !self.can_notify() {
            return Ok(false);
        }
        let Some(subscription) = self
            .active
            .iter_mut()
            .find(|s| s.id == hint.subscription_id && s.epoch == hint.epoch)
        else {
            return Ok(false);
        };
        if hint.sequence <= subscription.last_notified {
            return Ok(false);
        }
        provider
            .show(GenericNotice { hint: &hint })
            .map_err(|_| Error::DisplayFailed)?;
        subscription.last_notified = hint.sequence;
        Ok(true)
    }

    pub fn activate(
        &mut self,
        bytes: &[u8],
        current_vault: Uuid,
        unlocked: bool,
    ) -> Result<Option<Activation>, Error> {
        let hint = ReadyHint::decode(bytes)?;
        if !self.can_notify() {
            return Ok(None);
        }
        let Some(subscription) = self.active.iter_mut().find(|s| {
            s.id == hint.subscription_id
                && s.epoch == hint.epoch
                && s.owner.vault_id == current_vault
        }) else {
            return Ok(None);
        };
        subscription.last_notified = subscription.last_notified.max(hint.sequence);
        Ok(Some(if unlocked {
            Activation::ClinicDocuments
        } else {
            Activation::UnlockThenClinicDocuments
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> Owner {
        Owner::new(Uuid::from_u128(1), Uuid::from_u128(2), "A".repeat(43)).unwrap()
    }
    fn hint(id: u128, epoch: u128, sequence: u64) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"version":1,"kind":"documents_ready","subscription_id":Uuid::from_u128(id),"epoch":Uuid::from_u128(epoch),"sequence":sequence})).unwrap()
    }
    fn enabled() -> Policy {
        let mut p = Policy::default();
        assert_eq!(p.opt_in(), ConsentNext::RequestPermission);
        p.permission_changed(Permission::Granted);
        p.reserve_destination(owner(), Uuid::from_u128(3), Uuid::from_u128(4))
            .unwrap();
        p
    }
    #[derive(Default)]
    struct RecordingProvider {
        notices: Vec<(Uuid, String, String, Vec<u8>)>,
        fail: bool,
    }
    impl DisplayProvider for RecordingProvider {
        fn show(&mut self, notice: GenericNotice<'_>) -> Result<(), Error> {
            if self.fail {
                return Err(Error::DisplayFailed);
            }
            self.notices.push((
                notice.notification_id(),
                notice.title().into(),
                notice.body().into(),
                notice.activation_hint()?,
            ));
            Ok(())
        }
    }

    #[test]
    fn os_permission_does_not_opt_in_or_prompt_on_restore() {
        let mut p = Policy::default();
        p.permission_changed(Permission::Granted);
        assert!(!p.opted_in());
        assert!(!p
            .display_hint(&hint(3, 4, 1), &mut RecordingProvider::default())
            .unwrap());
        assert_eq!(
            p.reserve_destination(owner(), Uuid::from_u128(3), Uuid::from_u128(4)),
            Err(Error::Disabled)
        );
        p.permission_changed(Permission::Denied);
        assert_eq!(p.opt_in(), ConsentNext::OpenSystemSettings);
        let restored = Policy::restore(&p.encode().unwrap()).unwrap();
        assert!(restored.opted_in());
        assert!(!restored.can_notify());
        assert_eq!(restored.permission, Permission::Unknown);
    }

    #[test]
    fn hints_reject_patient_text_urls_oversize_and_future_schemas() {
        let mut value: serde_json::Value = serde_json::from_slice(&hint(3, 4, 1)).unwrap();
        value["filename"] = "FAKE_private_document.pdf".into();
        assert!(ReadyHint::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        value.as_object_mut().unwrap().remove("filename");
        value["url"] = "https://untrusted.invalid/document".into();
        assert!(ReadyHint::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        let mut oversized = hint(3, 4, 1);
        oversized.resize(MAX_HINT_BYTES + 1, b' '); // Otherwise valid JSON with trailing whitespace.
        assert!(ReadyHint::decode(&oversized).is_err());
        value.as_object_mut().unwrap().remove("url");
        value["version"] = 2.into();
        assert!(ReadyHint::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(ReadyHint::decode(&hint(3, 4, 0)).is_err());
        assert!(ReadyHint::decode(&hint(3, 4, u64::MAX)).is_err());
    }

    #[test]
    fn foreground_and_push_share_cursor_and_generic_replacement_identity() {
        let mut p = enabled();
        let mut provider = RecordingProvider::default();
        assert!(p.display_hint(&hint(3, 4, 10), &mut provider).unwrap());
        assert!(!p.display_hint(&hint(3, 4, 10), &mut provider).unwrap());
        assert!(!p.display_hint(&hint(3, 4, 9), &mut provider).unwrap());
        assert!(p.display_hint(&hint(3, 4, 11), &mut provider).unwrap());
        assert_eq!(provider.notices.len(), 2);
        for (id, title, body, payload) in provider.notices {
            assert_eq!(id, Uuid::from_u128(3));
            assert_eq!(title, "myCarlos");
            assert_eq!(body, "A new document is available in myCarlos.");
            assert!(ReadyHint::decode(&payload).is_ok());
        }
    }

    #[test]
    fn failed_display_retries_and_saved_cursor_survives_reconnect() {
        let mut p = enabled();
        let mut provider = RecordingProvider {
            fail: true,
            ..Default::default()
        };
        assert_eq!(
            p.display_hint(&hint(3, 4, 1), &mut provider),
            Err(Error::DisplayFailed)
        );
        provider.fail = false;
        assert!(p.display_hint(&hint(3, 4, 1), &mut provider).unwrap());
        let mut restored = Policy::restore(&p.encode().unwrap()).unwrap();
        assert!(!restored
            .display_hint(&hint(3, 4, 2), &mut provider)
            .unwrap());
        restored.permission_changed(Permission::Granted);
        assert!(!restored
            .display_hint(&hint(3, 4, 1), &mut provider)
            .unwrap());
        assert!(restored
            .display_hint(&hint(3, 4, 2), &mut provider)
            .unwrap());
        assert_eq!(provider.notices.len(), 2);
    }

    #[test]
    fn activation_only_routes_current_owner_through_normal_unlock() {
        let mut p = enabled();
        assert_eq!(
            p.activate(&hint(3, 4, 1), Uuid::from_u128(99), true)
                .unwrap(),
            None
        );
        assert_eq!(
            p.activate(&hint(3, 99, 1), owner().vault_id, true).unwrap(),
            None
        );
        assert_eq!(
            p.activate(&hint(3, 4, 1), owner().vault_id, false).unwrap(),
            Some(Activation::UnlockThenClinicDocuments)
        );
        assert_eq!(
            p.activate(&hint(3, 4, 1), owner().vault_id, true).unwrap(),
            Some(Activation::ClinicDocuments)
        );
        assert!(!p
            .display_hint(&hint(3, 4, 1), &mut RecordingProvider::default())
            .unwrap());
    }

    #[test]
    fn removal_and_opt_out_suppress_queued_delivery_and_preserve_revocation() {
        let mut p = enabled();
        let other = Owner::new(owner().vault_id, Uuid::from_u128(20), "B".repeat(43)).unwrap();
        p.reserve_destination(other, Uuid::from_u128(30), Uuid::from_u128(40))
            .unwrap();
        p.remove_owner(&owner());
        assert_eq!(p.pending_revocations(), vec![Uuid::from_u128(3)]);
        assert!(p.revocation_owner(Uuid::from_u128(3)) == Some(&owner()));
        assert_eq!(
            p.activate(&hint(3, 4, 1), owner().vault_id, false).unwrap(),
            None
        );
        let mut provider = RecordingProvider::default();
        assert!(!p.display_hint(&hint(3, 4, 1), &mut provider).unwrap());
        assert!(p.display_hint(&hint(30, 40, 1), &mut provider).unwrap());
        p.opt_out();
        let mut restored = Policy::restore(&p.encode().unwrap()).unwrap();
        restored.permission_changed(Permission::Granted);
        assert!(!restored
            .display_hint(&hint(30, 40, 2), &mut provider)
            .unwrap());
        assert_eq!(restored.pending_revocations().len(), 2);
        restored.revocation_acknowledged(Uuid::from_u128(3));
        assert_eq!(restored.pending_revocations(), vec![Uuid::from_u128(30)]);
    }

    #[test]
    fn denied_permission_revokes_without_clearing_product_preference() {
        let mut p = enabled();
        p.permission_changed(Permission::Denied);
        assert!(p.opted_in());
        assert!(!p.can_notify());
        assert_eq!(p.pending_revocations(), vec![Uuid::from_u128(3)]);
        p.permission_changed(Permission::Granted);
        assert!(!p
            .display_hint(&hint(3, 4, 1), &mut RecordingProvider::default())
            .unwrap());
    }

    #[test]
    fn reset_revokes_old_vault_and_cannot_route_its_pending_activation() {
        let mut p = enabled();
        p.remove_vault(owner().vault_id);
        assert_eq!(p.pending_revocations(), vec![Uuid::from_u128(3)]);
        assert_eq!(
            p.activate(&hint(3, 4, 1), owner().vault_id, true).unwrap(),
            None
        );
        assert!(!p
            .display_hint(&hint(3, 4, 1), &mut RecordingProvider::default())
            .unwrap());
    }

    #[test]
    fn repeated_enrollment_intent_keeps_cursor_and_rotation_rejects_old_epoch() {
        let mut p = enabled();
        let mut provider = RecordingProvider::default();
        assert!(p.display_hint(&hint(3, 4, 1), &mut provider).unwrap());
        p.reserve_destination(owner(), Uuid::from_u128(3), Uuid::from_u128(4))
            .unwrap();
        assert!(!p.display_hint(&hint(3, 4, 1), &mut provider).unwrap());
        assert_eq!(
            p.reserve_destination(owner(), Uuid::from_u128(3), Uuid::from_u128(5)),
            Err(Error::InvalidInput)
        );
        p.reserve_destination(owner(), Uuid::from_u128(5), Uuid::from_u128(6))
            .unwrap();
        assert!(!p.display_hint(&hint(3, 4, 2), &mut provider).unwrap());
        assert!(!p.display_hint(&hint(5, 4, 1), &mut provider).unwrap());
        assert!(p.display_hint(&hint(5, 6, 1), &mut provider).unwrap());
    }

    #[test]
    fn offline_rotation_bound_never_prevents_opt_out() {
        let mut p = enabled();
        for n in 1..MAX_ENTRIES {
            p.reserve_destination(
                owner(),
                Uuid::from_u128(100 + n as u128),
                Uuid::from_u128(500 + n as u128),
            )
            .unwrap();
        }
        assert_eq!(
            p.reserve_destination(owner(), Uuid::from_u128(999), Uuid::from_u128(1000)),
            Err(Error::Capacity)
        );
        p.opt_out();
        assert_eq!(p.pending_revocations().len(), MAX_ENTRIES);
        assert!(Policy::restore(&p.encode().unwrap()).is_ok());
    }

    #[test]
    fn saved_state_cannot_enable_an_opted_out_registration() {
        let mut value = serde_json::to_value(enabled()).unwrap();
        value["opted_in"] = false.into();
        assert!(Policy::restore(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}
