//! Native Android callbacks can arrive while the worker is still checking another vault.
use crate::{document_notifications::NoticeToken, vault::VaultStore};
use std::sync::Arc;

pub(crate) struct Notice {
    pub(crate) store: Arc<VaultStore>,
    pub(crate) session: u64,
}

#[derive(Default)]
pub(crate) struct PendingNotices(Vec<Notice>);

impl PendingNotices {
    /// One pending check per vault. A fresh session supersedes its own obsolete cue.
    pub(crate) fn push(&mut self, store: Arc<VaultStore>, token: NoticeToken) -> bool {
        let Ok(session) = store.admit_push_token(&token) else {
            return false;
        };
        if let Some(queued) = self.0.iter_mut().find(|q| Arc::ptr_eq(&q.store, &store)) {
            queued.session = session;
            return false;
        }
        self.0.push(Notice { store, session });
        true
    }

    pub(crate) fn take(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.0)
    }
}
