//! Native Android callbacks can arrive while the worker is still checking another vault.
use crate::{document_notifications::NoticeToken, vault::VaultStore};
use std::sync::Arc;

pub(crate) struct Notice {
    pub(crate) store: Arc<VaultStore>,
    pub(crate) session: u64,
    pub(crate) token: NoticeToken,
}

#[derive(Default)]
pub(crate) struct PendingNotices(Vec<Notice>);

impl PendingNotices {
    /// One pending check per vault. A fresh session supersedes its own obsolete cue.
    pub(crate) fn push(&mut self, store: Arc<VaultStore>, token: NoticeToken) {
        let session = store.portal_link_ticket();
        let notice = Notice {
            store,
            session,
            token,
        };
        if let Some(queued) = self
            .0
            .iter_mut()
            .find(|q| Arc::ptr_eq(&q.store, &notice.store))
        {
            if queued.session != session {
                *queued = notice;
            }
        } else {
            self.0.push(notice);
        }
    }

    pub(crate) fn take(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_checks_follow_their_vault_and_replace_only_its_old_session() {
        let dir = tempfile::tempdir().unwrap();
        let first = Arc::new(VaultStore::new(dir.path().join("main")));
        let second = Arc::new(VaultStore::new(dir.path().join("second")));
        let token = |n: u8| NoticeToken::parse(&format!("{n:022}")).unwrap();
        let mut pending = PendingNotices::default();
        pending.push(Arc::clone(&first), token(1));
        pending.push(Arc::clone(&second), token(2));
        pending.push(Arc::clone(&second), token(3));
        first.lock();
        pending.push(Arc::clone(&first), token(4));

        let notices = pending.take();
        assert_eq!(notices.len(), 2);
        assert!(Arc::ptr_eq(&notices[0].store, &first));
        assert_eq!(notices[0].session, first.portal_link_ticket());
        assert_eq!(notices[0].token.as_str(), token(4).as_str());
        assert!(Arc::ptr_eq(&notices[1].store, &second));
        assert_eq!(notices[1].token.as_str(), token(2).as_str());
        assert!(pending.take().is_empty());
    }
}
