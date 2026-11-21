//! The patient's own API key for a cloud AI provider (#72, the "cloud send" with the patient's own
//! key; threat model AI-11 and NET-05, proposed). Nothing here sends anything: this is only where
//! the key lives.
//!
//! - **Stored encrypted in the manifest** (format 14, provisional until merge), like the portal
//!   links' private keys, so it is in the vault's backups. After a key is removed, older backups
//!   still hold it: the vault never rewrites a backup.
//! - **Never leaves Rust.** The page can be given only `CloudKeyInfo`: an id, the provider, the
//!   patient's label, the last four characters and the time. `cloud_key_secret` is for native code
//!   (the send path, a later change) and returns a zeroizing string; no `Debug`, `Display` or log
//!   path prints the key.
//! - **An administration key is refused** (`sk-ant-admin…`): it can manage a whole organization.
//! - The code that reads and writes the list is compiled for tests and for builds with the
//!   `cloud-ai` Cargo feature, which is off by default and not in release builds; the format
//!   (the field and its checks) is in every build, so every build of this version understands it
//!   and an older build refuses the vault rather than drop it.

use super::*;
use zeroize::Zeroize;
#[cfg(any(feature = "cloud-ai", test))]
use zeroize::Zeroizing;

/// At most this many keys: one per provider account the patient uses.
pub(super) const MAX_CLOUD_KEYS: usize = 4;
const MAX_KEY_BYTES: usize = 256;
const MIN_KEY_BYTES: usize = 20;
const MAX_LABEL_CHARS: usize = 60;
const KEY_PREFIX: &str = "sk-ant-";
const ADMIN_PREFIX: &str = "sk-ant-admin";
/// The one provider there is (the design allows another only after its own threat-model row).
pub(super) const PROVIDER_ANTHROPIC: &str = "anthropic";

/// A key as the manifest holds it, with the secret in `key`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredCloudKey {
    id: Uuid,
    provider: String,
    /// What the patient calls it ("Home laptop"), at most 60 characters.
    label: String,
    /// The last four characters of the key, for the masked display.
    key_last4: String,
    added_at_ms: u64,
    key: String,
}

impl Drop for StoredCloudKey {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

/// The secret is never printed.
impl std::fmt::Debug for StoredCloudKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StoredCloudKey")
            .field("id", &self.id)
            .field("provider", &self.provider)
            .field("key", &"<redacted>")
            .finish()
    }
}

impl StoredCloudKey {
    /// Whether two entries are the same key or have the same id.
    pub(super) fn same_as(&self, other: &Self) -> bool {
        self.id == other.id || self.key == other.key
    }

    /// Whether the entry is well formed: the provider, a label, a key of the right shape that is
    /// not an administration key, and a `key_last4` that is the key's own last four characters.
    pub(super) fn valid(&self) -> bool {
        self.provider == PROVIDER_ANTHROPIC
            && !self.id.is_nil()
            && checked_label(&self.label).is_ok_and(|label| label == self.label)
            && check_key_shape(&self.key).is_ok()
            && self.key.ends_with(self.key_last4.as_str())
            && self.key_last4.chars().count() == 4
    }
}

/// What the page may know about a stored key. There is no secret in it, and no way to ask for one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudKeyInfo {
    pub id: Uuid,
    pub provider: String,
    pub label: String,
    pub key_last4: String,
    pub added_at_ms: u64,
}

impl From<&StoredCloudKey> for CloudKeyInfo {
    fn from(key: &StoredCloudKey) -> Self {
        Self {
            id: key.id,
            provider: key.provider.clone(),
            label: key.label.clone(),
            key_last4: key.key_last4.clone(),
            added_at_ms: key.added_at_ms,
        }
    }
}

/// Why a key was not stored: a refusal the patient is told in words, or a vault error.
#[derive(Debug)]
pub enum CloudKeyError {
    /// Not ASCII printable without spaces, not 20 to 256 bytes, or not starting `sk-ant-`.
    BadShape,
    /// An administration key (`sk-ant-admin…`): the wrong kind of key.
    AdminKey,
    /// This key is already saved.
    Duplicate,
    /// Already four keys.
    TooMany,
    /// A provider other than the one there is.
    UnknownProvider,
    /// A label that is empty, over 60 characters, or has control characters.
    BadLabel,
    Vault(VaultError),
}

impl CloudKeyError {
    /// The name the page and the tests use for a refusal (the page's `CloudKeyRefusal`).
    pub fn kind(&self) -> &'static str {
        match self {
            Self::BadShape => "badShape",
            Self::AdminKey => "adminKey",
            Self::Duplicate => "duplicate",
            Self::TooMany => "tooMany",
            Self::UnknownProvider => "unknownProvider",
            Self::BadLabel => "badLabel",
            Self::Vault(_) => "vault",
        }
    }
}

impl From<VaultError> for CloudKeyError {
    fn from(error: VaultError) -> Self {
        Self::Vault(error)
    }
}

/// The shape of a key, nothing about whether the provider accepts it.
fn check_key_shape(key: &str) -> Result<(), CloudKeyError> {
    if key.len() < MIN_KEY_BYTES
        || key.len() > MAX_KEY_BYTES
        || !key.bytes().all(|byte| byte.is_ascii_graphic())
        || !key
            .get(..KEY_PREFIX.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(KEY_PREFIX))
    {
        return Err(CloudKeyError::BadShape);
    }
    if key
        .get(..ADMIN_PREFIX.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(ADMIN_PREFIX))
    {
        return Err(CloudKeyError::AdminKey);
    }
    Ok(())
}

fn checked_label(label: &str) -> Result<String, CloudKeyError> {
    let label = label.trim();
    if label.is_empty()
        || label.chars().count() > MAX_LABEL_CHARS
        || label.chars().any(char::is_control)
    {
        return Err(CloudKeyError::BadLabel);
    }
    Ok(label.to_owned())
}

#[cfg(any(feature = "cloud-ai", test))]
#[allow(dead_code)] // The commands and the send path that use these are later changes.
impl VaultStore {
    /// Stores a key the patient typed. Surrounding whitespace (a trailing newline from a paste)
    /// is dropped; the key is checked before anything is written.
    pub fn cloud_key_add(
        &self,
        provider: &str,
        label: &str,
        key: &str,
        now_ms: u64,
    ) -> Result<CloudKeyInfo, CloudKeyError> {
        if provider != PROVIDER_ANTHROPIC {
            return Err(CloudKeyError::UnknownProvider);
        }
        let label = checked_label(label)?;
        let key = Zeroizing::new(key.trim().to_owned());
        check_key_shape(&key)?;
        let key_last4: String = {
            let chars: Vec<char> = key.chars().collect();
            chars[chars.len() - 4..].iter().collect()
        };
        let outcome = self.mutate_recorded(|manifest, entries| {
            if manifest.cloud_ai_keys.len() >= MAX_CLOUD_KEYS {
                return Ok(Err(CloudKeyError::TooMany));
            }
            if manifest
                .cloud_ai_keys
                .iter()
                .any(|stored| stored.key == *key)
            {
                return Ok(Err(CloudKeyError::Duplicate));
            }
            let stored = StoredCloudKey {
                id: Uuid::new_v4(),
                provider: provider.to_owned(),
                label,
                key_last4,
                added_at_ms: now_ms,
                key: key.to_string(),
            };
            let info = CloudKeyInfo::from(&stored);
            manifest.cloud_ai_keys.push(stored);
            // The provider only: never the key, the label or anything it could be matched by.
            let mut entry = HistoryEntry::new(HistoryEvent::CloudKeyAdded, now_ms);
            entry.how = Some(provider.to_owned());
            entries.push(entry);
            Ok(Ok(info))
        })?;
        outcome
    }

    /// The stored keys as the page may see them: masked, in the order they were added.
    pub fn cloud_keys(&self) -> Result<Vec<CloudKeyInfo>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        Ok(unlocked
            .manifest
            .cloud_ai_keys
            .iter()
            .map(CloudKeyInfo::from)
            .collect())
    }

    /// Removes a key from the vault (the secret is zeroed as its entry is dropped). It does not
    /// cancel the key at the provider, and older backups still hold it.
    pub fn cloud_key_remove(&self, id: Uuid, now_ms: u64) -> Result<(), VaultError> {
        self.mutate_recorded(|manifest, entries| {
            let at = manifest
                .cloud_ai_keys
                .iter()
                .position(|stored| stored.id == id)
                .ok_or(VaultError::NotFound)?;
            let removed = manifest.cloud_ai_keys.remove(at);
            let mut entry = HistoryEntry::new(HistoryEvent::CloudKeyRemoved, now_ms);
            entry.how = Some(removed.provider.clone());
            entries.push(entry);
            Ok(())
        })
    }

    /// The secret itself, for native code that is about to use it (never for the page): a
    /// zeroizing copy that lives only as long as the caller keeps it.
    pub(crate) fn cloud_key_secret(&self, id: Uuid) -> Result<Zeroizing<String>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        unlocked
            .manifest
            .cloud_ai_keys
            .iter()
            .find(|stored| stored.id == id)
            .map(|stored| Zeroizing::new(stored.key.clone()))
            .ok_or(VaultError::NotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "harbor-lantern-violet-meadow-582";

    // Not real keys: made up, with the shape of one.
    const FAKE_KEY: &str = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2";
    const OTHER_KEY: &str = "sk-ant-api03-OTHEROTHEROTHEROTHERz9y8";

    fn store() -> (tempfile::TempDir, VaultStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create("harbor-lantern-violet-meadow-582", "Jamie", 1)
            .unwrap();
        (temp, store)
    }

    #[test]
    fn a_key_is_stored_masked_listed_and_survives_a_lock() {
        let (_temp, store) = store();
        let info = store
            .cloud_key_add(
                PROVIDER_ANTHROPIC,
                "  Home laptop ",
                &format!("  {FAKE_KEY}\n"),
                5,
            )
            .unwrap();
        assert_eq!(info.label, "Home laptop");
        assert_eq!(info.key_last4, "a1b2");
        assert_eq!(info.added_at_ms, 5);
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.cloud_keys().unwrap(), vec![info.clone()]);
        assert_eq!(&*store.cloud_key_secret(info.id).unwrap(), FAKE_KEY);
    }

    #[test]
    fn the_page_never_gets_the_secret() {
        let (_temp, store) = store();
        let info = store
            .cloud_key_add(PROVIDER_ANTHROPIC, "Home", FAKE_KEY, 5)
            .unwrap();
        let shown = serde_json::to_string(&store.cloud_keys().unwrap()).unwrap();
        assert!(!shown.contains("FAKEFAKE"), "{shown}");
        assert!(shown.contains("a1b2"));
        // Neither the snapshot the page receives nor any debug text holds it.
        let snapshot = serde_json::to_string(&store.snapshot().unwrap()).unwrap();
        assert!(!snapshot.contains("FAKEFAKE") && !snapshot.contains("sk-ant"));
        let stored = store.session().as_ref().unwrap().manifest.cloud_ai_keys[0].clone();
        assert!(!format!("{stored:?}").contains("FAKEFAKE"));
        assert!(format!("{stored:?}").contains("<redacted>"));
        assert!(!format!("{info:?}").contains("FAKEFAKE"));
    }

    #[test]
    fn keys_of_the_wrong_shape_and_administration_keys_are_refused_before_anything_is_written() {
        let (_temp, store) = store();
        for (key, refusal) in [
            ("", "badShape"),
            ("sk-ant-short", "badShape"),
            ("sk-other-api03-FAKEFAKEFAKEFAKEFAKE", "badShape"),
            ("sk-ant-api03-FAKE FAKE FAKE FAKE FAKE", "badShape"),
            ("sk-ant-api03-FAKE\nFAKEFAKEFAKEFAKEFAKE", "badShape"),
            ("sk-ant-api03-FAKEé" /* not ASCII */, "badShape"),
            (&format!("sk-ant-{}", "x".repeat(300)), "badShape"),
            ("sk-ant-admin01-FAKEFAKEFAKEFAKEFAKE", "adminKey"),
            ("SK-ANT-ADMIN01-FAKEFAKEFAKEFAKEFAKE", "adminKey"),
        ] {
            assert_eq!(
                store
                    .cloud_key_add(PROVIDER_ANTHROPIC, "Home", key, 1)
                    .map_err(|error| error.kind()),
                Err(refusal),
                "{key:?}"
            );
        }
        assert!(store.cloud_keys().unwrap().is_empty());
        for label in ["", "   ", &"x".repeat(61), "bad\nlabel"] {
            assert_eq!(
                store
                    .cloud_key_add(PROVIDER_ANTHROPIC, label, FAKE_KEY, 1)
                    .map_err(|error| error.kind()),
                Err("badLabel")
            );
        }
        assert_eq!(
            store
                .cloud_key_add("openai", "Home", FAKE_KEY, 1)
                .map_err(|error| error.kind()),
            Err("unknownProvider")
        );
        assert!(store.cloud_keys().unwrap().is_empty());
    }

    #[test]
    fn a_duplicate_key_and_a_fifth_key_are_refused() {
        let (_temp, store) = store();
        store
            .cloud_key_add(PROVIDER_ANTHROPIC, "One", FAKE_KEY, 1)
            .unwrap();
        assert_eq!(
            store
                .cloud_key_add(PROVIDER_ANTHROPIC, "Again", FAKE_KEY, 2)
                .map_err(|error| error.kind()),
            Err("duplicate")
        );
        for n in 1..MAX_CLOUD_KEYS {
            let key = format!("sk-ant-api03-FAKEFAKEFAKEFAKE{n:04}");
            store
                .cloud_key_add(PROVIDER_ANTHROPIC, "More", &key, 3)
                .unwrap();
        }
        assert_eq!(
            store
                .cloud_key_add(PROVIDER_ANTHROPIC, "Five", OTHER_KEY, 4)
                .map_err(|error| error.kind()),
            Err("tooMany")
        );
        assert_eq!(store.cloud_keys().unwrap().len(), MAX_CLOUD_KEYS);
    }

    #[test]
    fn removal_forgets_the_key_and_an_unknown_id_is_not_found() {
        let (_temp, store) = store();
        let one = store
            .cloud_key_add(PROVIDER_ANTHROPIC, "One", FAKE_KEY, 1)
            .unwrap();
        let two = store
            .cloud_key_add(PROVIDER_ANTHROPIC, "Two", OTHER_KEY, 2)
            .unwrap();
        store.cloud_key_remove(one.id, 9).unwrap();
        assert_eq!(store.cloud_keys().unwrap(), vec![two.clone()]);
        assert!(matches!(
            store.cloud_key_secret(one.id),
            Err(VaultError::NotFound)
        ));
        assert!(matches!(
            store.cloud_key_remove(one.id, 9),
            Err(VaultError::NotFound)
        ));
        // The same key can be added again after removal.
        store
            .cloud_key_add(PROVIDER_ANTHROPIC, "Again", FAKE_KEY, 3)
            .unwrap();
        // Gone from the file too: the new manifest holds only the keys that remain.
        store.lock();
        store.unlock(PASSWORD).unwrap();
        assert_eq!(store.cloud_keys().unwrap().len(), 2);
    }

    #[test]
    fn a_locked_or_recovery_vault_takes_no_key_and_gives_none() {
        let (_temp, store) = store();
        let info = store
            .cloud_key_add(PROVIDER_ANTHROPIC, "Home", FAKE_KEY, 1)
            .unwrap();
        store.lock();
        assert!(matches!(store.cloud_keys(), Err(VaultError::Locked)));
        assert!(matches!(
            store.cloud_key_remove(info.id, 9),
            Err(VaultError::Locked)
        ));
        assert!(matches!(
            store.cloud_key_secret(info.id),
            Err(VaultError::Locked)
        ));
        assert_eq!(
            store
                .cloud_key_add(PROVIDER_ANTHROPIC, "Home", OTHER_KEY, 1)
                .map_err(|error| error.kind()),
            Err("vault")
        );
    }

    #[test]
    fn the_key_is_encrypted_in_the_manifest_file_and_in_a_backup_only_as_ciphertext() {
        let (temp, store) = store();
        store
            .cloud_key_add(PROVIDER_ANTHROPIC, "Home", FAKE_KEY, 1)
            .unwrap();
        for entry in fs::read_dir(temp.path().join("vault")).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert!(
                    !fs::read(&path)
                        .unwrap()
                        .windows(8)
                        .any(|window| window == b"FAKEFAKE"),
                    "{path:?} holds the key in the clear"
                );
            }
        }
    }

    #[test]
    fn the_manifest_check_enforces_the_format_the_shape_and_the_bounds() {
        let (_temp, store) = store();
        store
            .cloud_key_add(PROVIDER_ANTHROPIC, "Home", FAKE_KEY, 1)
            .unwrap();
        let mut manifest = store.session().as_ref().unwrap().manifest.clone();
        let id = manifest.vault_id;
        assert_eq!(manifest.format_version, VAULT_FORMAT);
        assert!(validate_manifest_structure(&manifest, id).is_ok());
        // Keys are not allowed in a format that has no field for them.
        manifest.format_version = MANIFEST_FORMAT_CLOUD_KEYS - 1;
        assert!(validate_manifest_structure(&manifest, id).is_err());
        manifest.format_version = VAULT_FORMAT;
        let good = manifest.cloud_ai_keys[0].clone();
        let broken = |change: &dyn Fn(&mut StoredCloudKey)| {
            let mut key = good.clone();
            change(&mut key);
            let mut copy = manifest.clone();
            copy.cloud_ai_keys = vec![key];
            validate_manifest_structure(&copy, id).is_err()
        };
        assert!(broken(&|key| key.key_last4 = "zzzz".into()));
        assert!(broken(&|key| key.provider = "openai".into()));
        assert!(broken(
            &|key| key.key = "sk-ant-admin01-FAKEFAKEFAKEFAKEa1b2".into()
        ));
        assert!(broken(&|key| key.label = String::new()));
        assert!(broken(&|key| key.label = " padded ".into()));
        assert!(broken(&|key| key.id = Uuid::nil()));
        // Duplicates and too many are refused.
        let mut copy = manifest.clone();
        copy.cloud_ai_keys = vec![good.clone(), good.clone()];
        assert!(validate_manifest_structure(&copy, id).is_err());
        let mut many = Vec::new();
        for n in 0..=MAX_CLOUD_KEYS {
            let mut key = good.clone();
            key.id = Uuid::new_v4();
            key.key = format!("sk-ant-api03-FAKEFAKEFAKEFAKE{n:04}");
            key.key_last4 = format!("{n:04}");
            many.push(key);
        }
        copy.cloud_ai_keys = many;
        assert!(validate_manifest_structure(&copy, id).is_err());
    }
}
