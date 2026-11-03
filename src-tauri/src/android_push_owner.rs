//! Durable native lifecycle seam for Android push. No IPC, network or vault decryption.
//! Methods return work only AFTER a successful atomic persistence callback. The host serializes
//! calls and supplies links checked against current native vault state, never renderer identity.
use crate::document_notifications::{Activation, Owner, ReadyHint};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

const MAX_DESTINATIONS: usize = 16;
const MAX_TOTAL: usize = 64;
const MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeLink {
    vault_id: Uuid,
    link_id: Uuid,
    device_key_id: String,
}
impl NativeLink {
    /// Call only after the native vault confirms current active-link ownership. This function
    /// validates shape; it does not substitute for that check or prove the vault is unlocked.
    pub fn from_verified_native(
        vault_id: Uuid,
        link_id: Uuid,
        device_key_id: String,
    ) -> Result<Self, Error> {
        Owner::new(vault_id, link_id, device_key_id.clone()).map_err(|_| Error::Invalid)?;
        Ok(Self {
            vault_id,
            link_id,
            device_key_id,
        })
    }
    fn valid(&self) -> bool {
        Owner::new(self.vault_id, self.link_id, self.device_key_id.clone()).is_ok()
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Destination {
    link: NativeLink,
    id: Uuid,
    epoch: Uuid,
    desired_generation: u64,
    enrolled_generation: u64,
    #[serde(default)]
    last_notified: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    installation_id: Uuid,
    active: Vec<Destination>,
    revocations: Vec<Destination>,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Error {
    Invalid,
    Capacity,
    Disabled,
    Persist,
    Display,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Permission {
    Unknown,
    Granted,
    Denied,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConsentAction {
    RequestPermission,
    ConfigureDestination,
    OpenSystemSettings,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TransportAction {
    Disabled,
    PermissionRequired,
    CredentialRequired,
    Enable,
}

/// Schema only. Portal must reject stale generations and tombstone revocations, including
/// revocations arriving before the first enrollment. No secret/provider token is serializable.
#[derive(Clone, Serialize)]
pub struct DestinationRef {
    pub subscription_id: Uuid,
    pub epoch: Uuid,
    pub installation_id: Uuid,
}
pub struct Enrollment {
    pub destination: DestinationRef,
    pub token_generation: u64,
    pub provider_token: Zeroizing<String>,
}
/// Constructed only inside validated Lifecycle display. No raw hint constructor/IPC grant.
pub struct ForegroundNotice {
    hint: Vec<u8>,
}
impl ForegroundNotice {
    pub(crate) fn hint(&self) -> &[u8] {
        &self.hint
    }
}
pub struct Lifecycle {
    saved: Saved,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            saved: Saved {
                version: 1,
                installation_id: Uuid::new_v4(),
                active: vec![],
                revocations: vec![],
            },
        }
    }
}
impl Lifecycle {
    pub fn restore(raw: &[u8]) -> Result<Self, Error> {
        if raw.len() > MAX_BYTES {
            return Err(Error::Invalid);
        }
        let saved: Saved = serde_json::from_slice(raw).map_err(|_| Error::Invalid)?;
        let rows = saved
            .active
            .iter()
            .chain(&saved.revocations)
            .collect::<Vec<_>>();
        let unique = rows
            .iter()
            .map(|r| r.id)
            .collect::<std::collections::HashSet<_>>();
        let owners = saved
            .active
            .iter()
            .map(|r| (r.link.vault_id, r.link.link_id))
            .collect::<std::collections::HashSet<_>>();
        if saved.version != 1
            || saved.installation_id.is_nil()
            || saved.active.len() > MAX_DESTINATIONS
            || rows.len() > MAX_TOTAL
            || unique.len() != rows.len()
            || owners.len() != saved.active.len()
            || rows.iter().any(|r| {
                !r.link.valid()
                    || r.id.is_nil()
                    || r.epoch.is_nil()
                    || r.enrolled_generation > r.desired_generation
                    || r.desired_generation > i64::MAX as u64
                    || r.last_notified > i64::MAX as u64
            })
        {
            return Err(Error::Invalid);
        }
        Ok(Self { saved })
    }
    pub fn encode(&self) -> Result<Vec<u8>, Error> {
        serde_json::to_vec(&self.saved).map_err(|_| Error::Invalid)
    }
    fn commit(
        &mut self,
        next: Saved,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<(), Error> {
        let raw = serde_json::to_vec(&next).map_err(|_| Error::Invalid)?;
        if raw.len() > MAX_BYTES {
            return Err(Error::Capacity);
        }
        persist(&raw).map_err(|_| Error::Persist)?;
        self.saved = next;
        Ok(())
    }
    fn reference(&self, row: &Destination) -> DestinationRef {
        DestinationRef {
            subscription_id: row.id,
            epoch: row.epoch,
            installation_id: self.saved.installation_id,
        }
    }
    /// Explicit fresh remote consent only. The native caller must check unlocked/current link
    /// before this call. The reservation is durable before any permission/provider/Portal work.
    pub fn opt_in(
        &mut self,
        link: NativeLink,
        permission: Permission,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<ConsentAction, Error> {
        if !link.valid() {
            return Err(Error::Invalid);
        }
        let mut next = self.saved.clone();
        if !next.active.iter().any(|r| r.link == link) {
            let replacing = next
                .active
                .iter()
                .any(|r| r.link.vault_id == link.vault_id && r.link.link_id == link.link_id);
            if (!replacing && next.active.len() >= MAX_DESTINATIONS)
                || next.active.len() + next.revocations.len() >= MAX_TOTAL
            {
                return Err(Error::Capacity);
            }
            // A changed signing identity for the same owner retires the old destination.
            if let Some(index) = next
                .active
                .iter()
                .position(|r| r.link.vault_id == link.vault_id && r.link.link_id == link.link_id)
            {
                next.revocations.push(next.active.remove(index));
            }
            next.active.push(Destination {
                link,
                id: Uuid::new_v4(),
                epoch: Uuid::new_v4(),
                desired_generation: 0,
                enrolled_generation: 0,
                last_notified: 0,
            });
        }
        self.commit(next, persist)?;
        Ok(match permission {
            Permission::Unknown => ConsentAction::RequestPermission,
            Permission::Granted => ConsentAction::ConfigureDestination,
            Permission::Denied => ConsentAction::OpenSystemSettings,
        })
    }
    /// Both opt-out and link/vault removal queue durable revocations. OS permission revocation
    /// uses revoke_all; granting permission again does not silently restore retired consent.
    pub fn opt_out(
        &mut self,
        link: &NativeLink,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<(), Error> {
        let mut next = self.saved.clone();
        let mut kept = vec![];
        for row in next.active.drain(..) {
            if row.link == *link {
                next.revocations.push(row);
            } else {
                kept.push(row);
            }
        }
        next.active = kept;
        self.commit(next, persist)
    }
    pub fn revoke_vault(
        &mut self,
        vault_id: Uuid,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<(), Error> {
        let mut next = self.saved.clone();
        let mut kept = vec![];
        for row in next.active.drain(..) {
            if row.link.vault_id == vault_id {
                next.revocations.push(row);
            } else {
                kept.push(row);
            }
        }
        next.active = kept;
        self.commit(next, persist)
    }
    pub fn revoke_all(
        &mut self,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<(), Error> {
        let mut next = self.saved.clone();
        next.revocations.append(&mut next.active);
        self.commit(next, persist)
    }
    pub fn permission_changed(
        &mut self,
        permission: Permission,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<(), Error> {
        if permission == Permission::Denied {
            self.revoke_all(persist)
        } else {
            Ok(())
        }
    }
    pub fn revoke_link(
        &mut self,
        vault_id: Uuid,
        link_id: Uuid,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<(), Error> {
        let mut next = self.saved.clone();
        let mut kept = vec![];
        for row in next.active.drain(..) {
            if row.link.vault_id == vault_id && row.link.link_id == link_id {
                next.revocations.push(row);
            } else {
                kept.push(row);
            }
        }
        next.active = kept;
        self.commit(next, persist)
    }
    pub fn transport_action(
        &self,
        permission: Permission,
        credential_available: impl Fn(Uuid) -> bool,
    ) -> TransportAction {
        if self.saved.active.is_empty() {
            return TransportAction::Disabled;
        }
        if permission != Permission::Granted {
            return TransportAction::PermissionRequired;
        }
        if !self.saved.active.iter().any(|r| credential_available(r.id)) {
            return TransportAction::CredentialRequired;
        }
        TransportAction::Enable
    }
    pub fn destinations(&self) -> Vec<DestinationRef> {
        self.saved
            .active
            .iter()
            .map(|r| self.reference(r))
            .collect()
    }
    pub fn pending_revocations(&self) -> Vec<DestinationRef> {
        self.saved
            .revocations
            .iter()
            .map(|r| self.reference(r))
            .collect()
    }
    /// Called from current native snapshot, never provider data/renderer input. Native owner must
    /// refresh OS permission and credential availability first, including while vault locked.
    pub fn token_changed(
        &mut self,
        token: String,
        generation: u64,
        permission: Permission,
        credential_available: impl Fn(Uuid) -> bool,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<Vec<Enrollment>, Error> {
        let token = Zeroizing::new(token);
        if token.is_empty() || token.len() > 4096 || generation == 0 || generation > i64::MAX as u64
        {
            return Err(Error::Invalid);
        }
        if permission != Permission::Granted || self.saved.active.is_empty() {
            return Err(Error::Disabled);
        }
        let mut next = self.saved.clone();
        let mut indexes = vec![];
        for (index, row) in next.active.iter_mut().enumerate() {
            if generation < row.desired_generation {
                return Err(Error::Invalid);
            }
            if generation > row.enrolled_generation && credential_available(row.id) {
                row.desired_generation = generation;
                indexes.push(index);
            }
        }
        self.commit(next, persist)?;
        Ok(indexes
            .into_iter()
            .map(|index| Enrollment {
                destination: self.reference(&self.saved.active[index]),
                token_generation: generation,
                provider_token: token.clone(),
            })
            .collect())
    }
    /// Late acks cannot resurrect opted-out/replaced destinations or acknowledge newer tokens.
    pub fn enrolled(
        &mut self,
        destination: &DestinationRef,
        generation: u64,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<bool, Error> {
        let mut next = self.saved.clone();
        if destination.installation_id != next.installation_id {
            return Ok(false);
        }
        let Some(row) = next
            .active
            .iter_mut()
            .find(|r| r.id == destination.subscription_id && r.epoch == destination.epoch)
        else {
            return Ok(false);
        };
        if generation == 0 || generation != row.desired_generation {
            return Ok(false);
        }
        row.enrolled_generation = generation;
        self.commit(next, persist)?;
        Ok(true)
    }
    /// Delete the OS-keystore scoped credential only AFTER the server confirms its tombstone.
    pub fn revoked(
        &mut self,
        destination: &DestinationRef,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<bool, Error> {
        if destination.installation_id != self.saved.installation_id {
            return Ok(false);
        }
        let mut next = self.saved.clone();
        let old = next.revocations.len();
        next.revocations
            .retain(|r| r.id != destination.subscription_id || r.epoch != destination.epoch);
        if old == next.revocations.len() {
            return Ok(false);
        }
        self.commit(next, persist)?;
        Ok(true)
    }
    /// Native host holds its lifecycle/ownership lock across this call and the synchronous
    /// provider closure. Kotlin rechecks OS permission, foreground and local transport state.
    pub fn display_foreground(
        &mut self,
        raw: &[u8],
        current: &NativeLink,
        permission: Permission,
        show: impl FnOnce(ForegroundNotice) -> Result<(), ()>,
        persist: impl FnOnce(&[u8]) -> Result<(), ()>,
    ) -> Result<bool, Error> {
        let hint = ReadyHint::decode(raw).map_err(|_| Error::Invalid)?;
        if permission != Permission::Granted {
            return Ok(false);
        }
        let Some(index) = self.saved.active.iter().position(|r| {
            r.link == *current
                && r.enrolled_generation > 0
                && hint.matches_destination(r.id, r.epoch)
                && hint.sequence() > r.last_notified
        }) else {
            return Ok(false);
        };
        show(ForegroundNotice { hint: raw.to_vec() }).map_err(|_| Error::Display)?;
        let mut next = self.saved.clone();
        next.active[index].last_notified = hint.sequence();
        self.commit(next, persist)?;
        Ok(true)
    }
    /// Navigation hint only; current link must be reverified after unlock. Reconcile separately
    /// on resume/unlock/reconnect regardless of invalid, missing, collapsed or duplicate hints.
    pub fn activate(
        &self,
        raw: &[u8],
        current: &NativeLink,
        unlocked: bool,
    ) -> Result<Option<Activation>, Error> {
        let hint = ReadyHint::decode(raw).map_err(|_| Error::Invalid)?;
        Ok(self
            .saved
            .active
            .iter()
            .any(|r| r.link == *current && hint.matches_destination(r.id, r.epoch))
            .then_some(if unlocked {
                Activation::ClinicDocuments
            } else {
                Activation::UnlockThenClinicDocuments
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn link(n: u128) -> NativeLink {
        NativeLink::from_verified_native(Uuid::from_u128(n), Uuid::from_u128(n + 1), "A".repeat(43))
            .unwrap()
    }
    fn ok(_: &[u8]) -> Result<(), ()> {
        Ok(())
    }
    fn consent(p: &mut Lifecycle, owner: NativeLink) {
        p.opt_in(owner, Permission::Granted, ok).unwrap();
    }
    fn hint(d: &DestinationRef) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"version":1,"kind":"documents_ready","subscription_id":d.subscription_id,"epoch":d.epoch,"sequence":1})).unwrap()
    }
    #[test]
    fn fresh_and_restored_default_never_enable_transport() {
        let p = Lifecycle::default();
        assert_eq!(
            p.transport_action(Permission::Granted, |_| true),
            TransportAction::Disabled
        );
        let restored = Lifecycle::restore(&p.encode().unwrap()).unwrap();
        assert!(restored.destinations().is_empty());
    }
    #[test]
    fn permission_and_credential_are_both_required_after_durable_consent() {
        let mut p = Lifecycle::default();
        assert_eq!(
            p.opt_in(link(1), Permission::Unknown, ok).unwrap(),
            ConsentAction::RequestPermission
        );
        assert_eq!(
            p.transport_action(Permission::Unknown, |_| true),
            TransportAction::PermissionRequired
        );
        assert_eq!(
            p.transport_action(Permission::Granted, |_| false),
            TransportAction::CredentialRequired
        );
        assert_eq!(
            p.transport_action(Permission::Granted, |_| true),
            TransportAction::Enable
        );
    }
    #[test]
    fn failed_persistence_never_reserves_or_emits_enrollment() {
        let mut p = Lifecycle::default();
        assert_eq!(
            p.opt_in(link(1), Permission::Granted, |_| Err(())),
            Err(Error::Persist)
        );
        assert!(p.destinations().is_empty());
        consent(&mut p, link(1));
        assert!(matches!(
            p.token_changed(
                "synthetic-provider-token".into(),
                1,
                Permission::Granted,
                |_| true,
                |_| Err(())
            ),
            Err(Error::Persist)
        ));
        assert_eq!(p.saved.active[0].desired_generation, 0);
    }
    #[test]
    fn opt_out_survives_restart_and_late_ack_cannot_resurrect() {
        let mut p = Lifecycle::default();
        let owner = link(1);
        consent(&mut p, owner.clone());
        let d = p.destinations().remove(0);
        p.token_changed("synthetic".into(), 1, Permission::Granted, |_| true, ok)
            .unwrap();
        p.opt_out(&owner, ok).unwrap();
        assert!(!p.enrolled(&d, 1, ok).unwrap());
        let mut p = Lifecycle::restore(&p.encode().unwrap()).unwrap();
        assert_eq!(p.pending_revocations().len(), 1);
        assert_eq!(
            p.transport_action(Permission::Granted, |_| true),
            TransportAction::Disabled
        );
        assert!(p.revoked(&d, ok).unwrap());
        assert!(p.pending_revocations().is_empty());
    }
    #[test]
    fn rotation_retries_unacked_generation_and_rejects_stale_ack() {
        let mut p = Lifecycle::default();
        consent(&mut p, link(1));
        let d = p.destinations().remove(0);
        assert_eq!(
            p.token_changed("first".into(), 1, Permission::Granted, |_| true, ok)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            p.token_changed("first".into(), 1, Permission::Granted, |_| true, ok)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            p.token_changed("second".into(), 2, Permission::Granted, |_| true, ok)
                .unwrap()
                .len(),
            1
        );
        assert!(!p.enrolled(&d, 1, ok).unwrap());
        assert!(p.enrolled(&d, 2, ok).unwrap());
        assert!(p
            .token_changed("second".into(), 2, Permission::Granted, |_| true, ok)
            .unwrap()
            .is_empty());
        assert!(matches!(
            p.token_changed("old".into(), 1, Permission::Granted, |_| true, ok),
            Err(Error::Invalid)
        ));
    }
    #[test]
    fn credentials_are_per_destination_and_generation_is_pg_bigint_bounded() {
        let mut p = Lifecycle::default();
        consent(&mut p, link(1));
        consent(&mut p, link(5));
        let d = p.destinations().remove(0);
        let work = p
            .token_changed(
                "synthetic".into(),
                1,
                Permission::Granted,
                |id| id == d.subscription_id,
                ok,
            )
            .unwrap();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].destination.subscription_id, d.subscription_id);
        assert!(matches!(
            p.token_changed(
                "synthetic".into(),
                u64::MAX,
                Permission::Granted,
                |_| true,
                ok
            ),
            Err(Error::Invalid)
        ));
    }
    #[test]
    fn revoke_before_provider_enrollment_is_retained_and_reconsent_uses_new_identity() {
        let mut p = Lifecycle::default();
        let owner = link(1);
        consent(&mut p, owner.clone());
        let old = p.destinations().remove(0);
        p.opt_out(&owner, ok).unwrap();
        consent(&mut p, owner);
        let new = p.destinations().remove(0);
        assert_ne!(old.subscription_id, new.subscription_id);
        assert_ne!(old.epoch, new.epoch);
        assert_eq!(p.pending_revocations().len(), 1);
    }
    #[test]
    fn reset_removes_only_matching_vault_and_preserves_other_owner() {
        let mut p = Lifecycle::default();
        consent(&mut p, link(1));
        consent(&mut p, link(5));
        p.revoke_vault(Uuid::from_u128(1), ok).unwrap();
        assert_eq!(p.destinations().len(), 1);
        assert_eq!(p.pending_revocations().len(), 1);
    }
    #[test]
    fn hints_never_cross_owner_or_retired_epoch_and_require_unlock_navigation() {
        let mut p = Lifecycle::default();
        let owner = link(1);
        consent(&mut p, owner.clone());
        let d = p.destinations().remove(0);
        assert_eq!(
            p.activate(&hint(&d), &owner, false).unwrap(),
            Some(Activation::UnlockThenClinicDocuments)
        );
        assert_eq!(p.activate(&hint(&d), &link(5), true).unwrap(), None);
        p.opt_out(&owner, ok).unwrap();
        assert_eq!(p.activate(&hint(&d), &owner, true).unwrap(), None);
        assert!(matches!(
            p.activate(b"https://example.invalid", &owner, true),
            Err(Error::Invalid)
        ));
    }
    #[test]
    fn permission_revocation_retires_consent_before_reenable_and_leaves_no_secrets() {
        let mut p = Lifecycle::default();
        consent(&mut p, link(1));
        let work = p
            .token_changed(
                "PRIVATE_SYNTHETIC_TOKEN".into(),
                1,
                Permission::Granted,
                |_| true,
                ok,
            )
            .unwrap();
        assert_eq!(work.len(), 1);
        assert!(!String::from_utf8(p.encode().unwrap())
            .unwrap()
            .contains("PRIVATE_SYNTHETIC_TOKEN"));
        p.permission_changed(Permission::Denied, ok).unwrap();
        p.permission_changed(Permission::Granted, ok).unwrap();
        assert_eq!(
            p.transport_action(Permission::Granted, |_| true),
            TransportAction::Disabled
        );
        assert_eq!(p.pending_revocations().len(), 1);
    }
    #[test]
    fn foreground_display_denies_permission_stale_owner_epoch_and_unenrolled_destination() {
        let mut p = Lifecycle::default();
        let owner = link(1);
        consent(&mut p, owner.clone());
        let d = p.destinations().remove(0);
        assert!(!p
            .display_foreground(
                &hint(&d),
                &owner,
                Permission::Granted,
                |_| panic!("unenrolled displayed"),
                ok
            )
            .unwrap());
        p.token_changed("synthetic".into(), 1, Permission::Granted, |_| true, ok)
            .unwrap();
        p.enrolled(&d, 1, ok).unwrap();
        assert!(!p
            .display_foreground(
                &hint(&d),
                &owner,
                Permission::Denied,
                |_| panic!("denied displayed"),
                ok
            )
            .unwrap());
        assert!(!p
            .display_foreground(
                &hint(&d),
                &link(5),
                Permission::Granted,
                |_| panic!("wrong owner displayed"),
                ok
            )
            .unwrap());
        let mut stale = d.clone();
        stale.epoch = Uuid::new_v4();
        assert!(!p
            .display_foreground(
                &hint(&stale),
                &owner,
                Permission::Granted,
                |_| panic!("stale epoch displayed"),
                ok
            )
            .unwrap());
        assert!(p
            .display_foreground(&hint(&d), &owner, Permission::Granted, |_| Ok(()), ok)
            .unwrap());
        assert!(!p
            .display_foreground(
                &hint(&d),
                &owner,
                Permission::Granted,
                |_| panic!("duplicate displayed"),
                ok
            )
            .unwrap());
        p.opt_out(&owner, ok).unwrap();
        assert!(!p
            .display_foreground(
                &hint(&d),
                &owner,
                Permission::Granted,
                |_| panic!("retired displayed"),
                ok
            )
            .unwrap());
    }
    #[test]
    fn failed_display_does_not_advance_sequence_and_failed_persist_retains_retry() {
        let mut p = Lifecycle::default();
        let owner = link(1);
        consent(&mut p, owner.clone());
        let d = p.destinations().remove(0);
        p.token_changed("synthetic".into(), 1, Permission::Granted, |_| true, ok)
            .unwrap();
        p.enrolled(&d, 1, ok).unwrap();
        assert_eq!(
            p.display_foreground(&hint(&d), &owner, Permission::Granted, |_| Err(()), ok),
            Err(Error::Display)
        );
        assert_eq!(
            p.display_foreground(
                &hint(&d),
                &owner,
                Permission::Granted,
                |_| Ok(()),
                |_| Err(())
            ),
            Err(Error::Persist)
        );
        assert!(p
            .display_foreground(&hint(&d), &owner, Permission::Granted, |_| Ok(()), ok)
            .unwrap());
    }
    #[test]
    fn corrupted_or_unbounded_state_cannot_restore_consent() {
        assert!(Lifecycle::restore(&vec![b' '; MAX_BYTES + 1]).is_err());
        let mut p = Lifecycle::default();
        consent(&mut p, link(1));
        p.saved.active[0].desired_generation = u64::MAX;
        assert!(Lifecycle::restore(&p.encode().unwrap()).is_err());
    }
}
