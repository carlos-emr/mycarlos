//! Notice keys, vault side (#230): the vault is open, so the device key can enrol a link's notice
//! key with its Portal, and a link that is gone or no longer wanted loses its key. The decisions
//! are `tray_notices::sync_keys`; this only reads the links and runs the Portal request without
//! holding the vault lock.

use super::*;
use crate::document_push::Exchange;
use crate::notice_key::{NoticeKeyEntry, NoticeKeys, WrapKeyStore};
use crate::tray_notices::{
    enrollment_body, registration_from, sync_keys, LinkView, NoticeSync, Registration,
    MAX_ENROLL_REPLY, WAITING_KEYS,
};

impl VaultStore {
    /// Brings the notice keys in line with `wanted` (see `sync_keys`). No network call is made
    /// while the vault lock is held: the links are copied first. A session that ended meanwhile
    /// (`session` no longer the portal session) stops it.
    pub(crate) fn sync_notice_keys_with<S: WrapKeyStore>(
        &self,
        keys: &NoticeKeys<S>,
        wanted: bool,
        session: u64,
        exchange: &impl Exchange,
        give_up: &mut dyn FnMut(&NoticeKeyEntry),
    ) -> Result<NoticeSync, VaultError> {
        if self.portal_link_ticket() != session {
            return Err(VaultError::Cancelled);
        }
        let (vault_id, links) = {
            let guard = self.session();
            let open = guard.as_ref().ok_or(VaultError::Locked)?;
            if open.recovery.is_some() {
                return Err(VaultError::RecoveryMode);
            }
            (open.manifest.vault_id, open.manifest.portal_links.clone())
        };
        let cancelled = || self.portal_link_ticket() != session;
        let views: Vec<LinkView> = links
            .iter()
            .map(|link| LinkView {
                id: link.id,
                portal_base: &link.portal_base,
                linked: link.clinic.is_some(),
            })
            .collect();
        sync_keys(
            keys,
            vault_id,
            &views,
            &|id| self.link_gone(id),
            wanted,
            &mut |link_id, made| {
                let Some(link) = links.iter().find(|link| link.id == link_id) else {
                    return Registration::Later;
                };
                match exchange(
                    link,
                    "POST",
                    WAITING_KEYS,
                    enrollment_body(made),
                    None,
                    MAX_ENROLL_REPLY,
                    &cancelled,
                ) {
                    Ok(reply) => registration_from(reply.status),
                    Err(_) => Registration::Later,
                }
            },
            give_up,
        )
        .map_err(|_| VaultError::Storage)
    }

    /// The real thing: this process's notice keys, the Portal over HTTPS, and a key that is
    /// finished told so with the key itself. `None` where the build keeps no notice keys.
    pub(crate) fn sync_notice_keys(&self) -> Option<Result<NoticeSync, VaultError>> {
        let keys = crate::notice_key::kept()?;
        let session = self.portal_link_ticket();
        Some(self.sync_notice_keys_with(
            keys,
            crate::tray_notices::wanted(),
            session,
            &crate::portal_client::api,
            &mut crate::tray_notices::give_up_remote,
        ))
    }
}
