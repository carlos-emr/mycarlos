//! The AI models myCarlos hasn't checked that the patient approved in this vault (#276, format
//! 14). A model the patient adds that is not on myCarlos's list is recorded outside the vault,
//! by its hash; it runs only once the open vault holds that hash here too. So a file swapped
//! with its record outside the vault, or a second vault of the same computer account, asks the
//! patient again. Hashes only: nothing about the model's file or its name.

use super::*;

/// At most this many approvals are kept. They aren't the patient's documents (#71's "nothing
/// is deleted" is about those), so past this, the oldest goes.
pub(crate) const MAX_APPROVED_MODELS: usize = 32;

fn valid_hash(sha256: &str) -> bool {
    sha256.len() == 64
        && sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A manifest's approvals: none before format 14; at most [`MAX_APPROVED_MODELS`], each a
/// lowercase SHA-256, each once.
pub(super) fn valid(manifest: &Manifest) -> bool {
    let approved = &manifest.approved_models;
    let mut seen = HashSet::new();
    (manifest.format_version >= MANIFEST_FORMAT_APPROVED_MODELS || approved.is_empty())
        && approved.len() <= MAX_APPROVED_MODELS
        && approved
            .iter()
            .all(|sha256| valid_hash(sha256) && seen.insert(sha256.as_str()))
}

impl VaultStore {
    #[cfg(test)]
    fn approved_models(&self) -> Result<Vec<String>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        Ok(unlocked.manifest.approved_models.clone())
    }

    /// Records the patient's approval of the model whose SHA-256 is `sha256`, once per vault,
    /// when they confirm its first answer. Approving one already approved changes nothing.
    pub(crate) fn approve_model(
        &self,
        origin: AnswerOrigin,
        sha256: &str,
    ) -> Result<(), VaultError> {
        if !valid_hash(sha256) {
            return Err(VaultError::Invalid);
        }
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if self.idle.answer_origin() != Some(origin) {
            return Err(VaultError::Locked);
        }
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        if unlocked
            .manifest
            .approved_models
            .iter()
            .any(|approved| approved == sha256)
        {
            return Ok(());
        }
        let mut next = unlocked.manifest.clone();
        // A writable session's manifest is upgraded at unlock.
        if next.format_version < MANIFEST_FORMAT_APPROVED_MODELS {
            return Err(VaultError::Invalid);
        }
        next.approved_models.push(sha256.to_owned());
        if next.approved_models.len() > MAX_APPROVED_MODELS {
            next.approved_models.remove(0);
        }
        // No history entry: the history is the documents' (#71); this is the vault's setting.
        let redundant = commit_with_history(
            &self.root,
            &unlocked.master_key,
            &mut unlocked.manifest,
            next,
            Vec::new(),
        )?;
        unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "river-azimuth-cobalt-sparrow-934";

    fn fixture() -> (tempfile::TempDir, VaultStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Person", 1).unwrap();
        (temp, store)
    }

    fn hash(n: u8) -> String {
        format!("{n:02x}").repeat(32)
    }

    fn approve(store: &VaultStore, sha256: &str) -> Result<(), VaultError> {
        let origin = store.answer_origin().ok_or(VaultError::Locked)?;
        store.approve_model(origin, sha256)
    }

    #[test]
    fn approval_from_a_closed_session_cannot_change_the_next_session() {
        let (_temp, store) = fixture();
        let origin = store.answer_origin().unwrap();
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert!(matches!(
            store.approve_model(origin, &hash(1)),
            Err(VaultError::Locked)
        ));
        assert!(store.approved_models().unwrap().is_empty());
    }

    #[test]
    fn an_approval_is_kept_once_survives_a_lock_and_the_oldest_goes_past_the_cap() {
        let (_temp, store) = fixture();
        assert_eq!(store.approved_models().unwrap(), Vec::<String>::new());
        approve(&store, &hash(1)).unwrap();
        approve(&store, &hash(1)).unwrap();
        assert_eq!(store.approved_models().unwrap(), [hash(1)]);
        store.lock();
        assert!(matches!(store.approved_models(), Err(VaultError::Locked)));
        assert!(matches!(approve(&store, &hash(2)), Err(VaultError::Locked)));
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.approved_models().unwrap(), [hash(1)]);
        for n in 2..=(MAX_APPROVED_MODELS as u8 + 1) {
            approve(&store, &hash(n)).unwrap();
        }
        let approved = store.approved_models().unwrap();
        assert_eq!(approved.len(), MAX_APPROVED_MODELS);
        assert_eq!(approved[0], hash(2));
        assert_eq!(
            approved[MAX_APPROVED_MODELS - 1],
            hash(MAX_APPROVED_MODELS as u8 + 1)
        );
    }

    #[test]
    fn approving_one_vault_does_not_approve_another_vault_on_the_same_computer() {
        let (_first_dir, first) = fixture();
        let (_second_dir, second) = fixture();
        approve(&first, &hash(1)).unwrap();
        assert_eq!(first.approved_models().unwrap(), [hash(1)]);
        assert!(second.approved_models().unwrap().is_empty());
        approve(&second, &hash(2)).unwrap();
        first.lock();
        first.unlock(PASSWORD).unwrap();
        assert_eq!(first.approved_models().unwrap(), [hash(1)]);
        assert_eq!(second.approved_models().unwrap(), [hash(2)]);
    }

    #[test]
    fn only_a_lowercase_hash_is_approved() {
        let (_temp, store) = fixture();
        for bad in [
            String::new(),
            "AB".repeat(32),
            "ab".repeat(31),
            "zz".repeat(32),
        ] {
            assert!(matches!(approve(&store, &bad), Err(VaultError::Invalid)));
        }
        assert!(store.approved_models().unwrap().is_empty());
    }

    #[test]
    fn a_manifest_holds_approvals_only_from_format_14_each_once() {
        let (_temp, store) = fixture();
        let guard = store.session();
        let mut manifest = guard.as_ref().unwrap().manifest.clone();
        drop(guard);
        assert!(valid(&manifest));
        manifest.approved_models = vec![hash(1), hash(2)];
        assert!(valid(&manifest));
        manifest.approved_models = vec![hash(1), hash(1)];
        assert!(!valid(&manifest));
        manifest.approved_models = vec!["AB".repeat(32)];
        assert!(!valid(&manifest));
        manifest.approved_models = (0..=MAX_APPROVED_MODELS as u8).map(hash).collect();
        assert!(!valid(&manifest));
        manifest.approved_models = vec![hash(1)];
        manifest.format_version = MANIFEST_FORMAT_AI_HIDDEN_CAP;
        assert!(!valid(&manifest));
        manifest.approved_models.clear();
        assert!(valid(&manifest));
    }
}
