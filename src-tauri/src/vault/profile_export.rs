//! Exporting one person's documents to a handover package (#360 PR 3): what goes in, the
//! one pass that writes it, and the read-back that must pass before anything is called done.
//!
//! The vault's own session is held for the whole pass, as for a backup, so the package is one
//! consistent snapshot of the generation the session had when it started, and a lock or a
//! cancel stops the pass between chunks. Nothing readable is kept anywhere: each document is
//! decrypted a chunk at a time and encrypted into the package as it comes. Nothing in the
//! vault changes while exporting; the history entry is a separate step, taken only after the
//! package has been read back (`record_profile_exported`).
//!
//! What is left out, and said so in the report: a document hidden as damaged (its file is not
//! readable, so it cannot go), and the clinic evidence that would not stand up on its own at
//! the other end (the document still goes, as a document the receiving vault cannot tie to a
//! clinic).
use super::*;
use crate::vault::profile_package::{
    ObjectRead, PackageAiAnswer, PackageError, PackageFolder, PackageManifest, PackageObject,
    PackageProfile, PackageReader, PackageRecord, PackageSecret, PackageWriter, PACKAGE_FORMAT,
};
use std::io::Seek;

/// What to include beyond the documents.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ExportOptions {
    /// The excerpt of the person's history (#360 Q5): on unless the patient switches it off.
    pub include_history: bool,
}

/// What an export wrote, in counts and ids that name no document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExportReport {
    /// The id the package carries in its header (not a vault id).
    pub package_id: Uuid,
    /// The manifest generation the package reflects.
    pub generation: u64,
    pub documents: usize,
    /// Of them, hidden by the patient and arriving hidden.
    pub hidden: usize,
    pub folders: usize,
    pub ai_answers: usize,
    /// Documents that carry clinic evidence.
    pub with_clinic_evidence: usize,
    /// Documents hidden as damaged: their file is not readable, so they are not in the package.
    pub left_out_damaged: usize,
    /// Documents whose clinic evidence would not stand up on its own, so only the document
    /// went.
    pub evidence_left_out: usize,
    pub history_entries: usize,
    /// How many bytes of documents (plaintext) the package holds.
    pub plaintext_bytes: u64,
}

/// An export that has been written and not yet checked: the sink and what the writer saw of
/// each object, to be compared with what a reader finds.
pub(crate) struct Written<W> {
    pub sink: W,
    pub report: ExportReport,
    pub digests: Vec<ObjectRead>,
}

impl VaultStore {
    /// Writes `profile_id`'s documents to `sink` as a package under `secret`. Refused for the
    /// vault's recovery mode, a person that is not here, and Shared with me (which is no
    /// person); a hidden person can be exported. A typed passphrase must meet the rules for a
    /// new one and is refused if it is this vault's own: a file that holds one person's
    /// documents must not open with the key to all of them.
    pub(crate) fn export_profile<W: Write>(
        &self,
        profile_id: Uuid,
        options: ExportOptions,
        secret: PackageSecret<'_>,
        sink: W,
        now_ms: u64,
    ) -> Result<Written<W>, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let profile = Self::exportable_profile(unlocked, profile_id)?;
        let manifest = &unlocked.manifest;
        let cancelled = || self.cancel_io.load(Ordering::Acquire);
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        if let PackageSecret::Passphrase(passphrase) = secret {
            if self.is_vault_passphrase(unlocked, passphrase)? {
                return Err(VaultError::WeakPassphrase);
            }
        }

        let (package, mut report, sources) =
            self.build_package_manifest(unlocked, profile, options, now_ms)?;
        let context = Self::name_words(profile);
        let mut writer = PackageWriter::create(sink, secret, &context)?;
        report.package_id = writer.package_id();
        writer.write_manifest(&package)?;

        let keys = derive_keys(manifest.vault_id, &unlocked.master_key)?;
        // The vault's own failure, as what it was: the package writer only knows a write failed.
        let mut vault_error: Option<VaultError> = None;
        while let Some(next) = writer.next_object() {
            let source = sources.get(&next.id).ok_or(VaultError::Corrupt)?;
            let still_open = || !cancelled();
            let result = writer.write_object_with(next.id, &still_open, &mut |out| {
                let path = self.root.join("objects").join(&source.object_name);
                let guarded = CancellableWriter::new(out, Arc::clone(&self.cancel_io))
                    .with_progress(&self.idle);
                read_object_ref(&path, manifest.vault_id, &keys, source.reference(), guarded)
                    .map_err(|error| {
                        let package_error = match &error {
                            VaultError::Cancelled | VaultError::Locked => PackageError::Cancelled,
                            _ => PackageError::Storage,
                        };
                        vault_error = Some(match error {
                            VaultError::Corrupt => VaultError::DamagedDocument(source.record_id),
                            error => error,
                        });
                        package_error
                    })
            });
            if let Err(error) = result {
                return Err(vault_error
                    .take()
                    .unwrap_or_else(|| error_of_package(error)));
            }
        }
        let (sink, digests) = writer.finish_with_digests().map_err(error_of_package)?;
        Ok(Written {
            sink,
            report,
            digests,
        })
    }

    /// What an export of `profile_id` would hold, in counts, without writing anything: the
    /// same checks and the same manifest as the export itself (and a history excerpt that is
    /// counted, not kept).
    pub(crate) fn profile_export_preview(
        &self,
        profile_id: Uuid,
        options: ExportOptions,
    ) -> Result<ExportReport, VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let profile = Self::exportable_profile(unlocked, profile_id)?;
        let (_, report, _) = self.build_package_manifest(unlocked, profile, options, 0)?;
        Ok(report)
    }

    /// Whether `passphrase` may protect a package of `profile_id`: the vault's rules for a new
    /// passphrase (the person's own names are not allowed in it), and not the vault's own.
    /// Asked when the export is prepared, so that a refusal comes before anything else is.
    pub(crate) fn check_package_passphrase(
        &self,
        profile_id: Uuid,
        passphrase: &str,
    ) -> Result<(), VaultError> {
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let profile = Self::exportable_profile(unlocked, profile_id)?;
        let context = Self::name_words(profile);
        validate_new_passphrase(passphrase, &context)?;
        if self.is_vault_passphrase(unlocked, passphrase)? {
            return Err(VaultError::WeakPassphrase);
        }
        Ok(())
    }

    /// As `export_profile_atomic`, into a file already open for reading and writing and
    /// empty, as an Android document provider gives one: written, flushed and read back in
    /// place. There is no rename: a failure leaves that document as it is, which may be empty.
    pub(crate) fn export_profile_to_open_file(
        &self,
        profile_id: Uuid,
        options: ExportOptions,
        secret: PackageSecret<'_>,
        file: &mut fs::File,
        place: &str,
        now_ms: u64,
    ) -> Result<ExportReport, VaultError> {
        let report = self.write_and_verify(profile_id, options, secret, file, now_ms)?;
        self.record_profile_exported(profile_id, place);
        Ok(report)
    }

    /// The person to export: here, and a person (Shared with me is not one).
    fn exportable_profile(
        unlocked: &UnlockedVault,
        profile_id: Uuid,
    ) -> Result<&PatientProfile, VaultError> {
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let manifest = &unlocked.manifest;
        let profile = manifest
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or(VaultError::NotFound)?;
        if profile.id == shared_profile_id(manifest.vault_id) {
            return Err(VaultError::Invalid);
        }
        Ok(profile)
    }

    /// The words of a person's own names, which a typed passphrase may not contain.
    fn name_words(profile: &PatientProfile) -> Vec<&str> {
        [
            Some(profile.display_name.as_str()),
            profile.full_name.as_deref(),
        ]
        .into_iter()
        .flatten()
        .chain(
            profile
                .previous_full_names
                .iter()
                .flatten()
                .map(String::as_str),
        )
        .collect()
    }

    /// Saves a package to a file the patient chose: written beside the destination, **read
    /// back with its key and checked** (every object decrypted and hashed, the end, the tag),
    /// and only then renamed over the destination. An export that fails at any step, or does not
    /// read back, leaves the destination as it was and no temporary file. Never inside the vault
    /// home. Only after the rename is the export noted in the history.
    pub(crate) fn export_profile_atomic(
        &self,
        profile_id: Uuid,
        options: ExportOptions,
        secret: PackageSecret<'_>,
        destination: &Path,
        now_ms: u64,
    ) -> Result<ExportReport, VaultError> {
        let home = fs::canonicalize(vault_home(&self.root)?)?;
        let parent = destination.parent().ok_or(VaultError::Invalid)?;
        if fs::canonicalize(parent)?.starts_with(&home) {
            return Err(VaultError::Invalid);
        }
        let mut open = OpenOptions::new();
        open.read(true).write(true).create(true).truncate(true);
        #[cfg(unix)]
        open.mode(0o600);
        let mut outcome: Result<ExportReport, VaultError> = Err(VaultError::Storage);
        let written = AtomicFile::new(destination, AllowOverwrite).write_with_options(
            |file| {
                outcome = self.write_and_verify(profile_id, options, secret, &mut *file, now_ms);
                match &outcome {
                    Ok(_) => Ok(()),
                    Err(_) => Err(io::Error::other("export failed")),
                }
            },
            open,
        );
        let report = outcome?;
        written.map_err(io::Error::from)?;
        self.record_profile_exported(profile_id, &destination.to_string_lossy());
        Ok(report)
    }

    /// Writes the package into `file` (a fresh, empty file open for reading and writing),
    /// flushes it to disk and reads it back.
    fn write_and_verify(
        &self,
        profile_id: Uuid,
        options: ExportOptions,
        secret: PackageSecret<'_>,
        file: &mut fs::File,
        now_ms: u64,
    ) -> Result<ExportReport, VaultError> {
        // The writer borrows the file only inside this block, so that the file can be synced,
        // rewound and read back after it.
        let (report, digests) = {
            let written = self.export_profile(
                profile_id,
                options,
                secret,
                BufWriter::new(&mut *file),
                now_ms,
            )?;
            let Written {
                sink,
                report,
                digests,
            } = written;
            sink.into_inner()
                .map_err(|_| VaultError::Storage)?
                .flush()?;
            (report, digests)
        };
        fail_at_test_boundary("export.before-sync")?;
        file.sync_all()?;
        fail_at_test_boundary("export.before-verify")?;
        file.seek(io::SeekFrom::Start(0))?;
        let still_open = || !self.cancel_io.load(Ordering::Acquire);
        verify_written(BufReader::new(&mut *file), secret, &digests, &still_open)?;
        fail_at_test_boundary("export.before-rename")?;
        Ok(report)
    }

    /// Whether `candidate` is the passphrase of this vault: the vault's own derivation applied
    /// to it, tried on the master key's wrapping. Only asked of a typed package passphrase.
    fn is_vault_passphrase(
        &self,
        unlocked: &UnlockedVault,
        candidate: &str,
    ) -> Result<bool, VaultError> {
        if candidate.len() > MAX_PASSPHRASE_BYTES {
            return Ok(false);
        }
        let header = current_header(&self.root, unlocked.manifest.vault_id, &unlocked.master_key)?;
        let key = derive_passphrase_key(candidate, &header.kdf)?;
        Ok(unwrap_secret(
            &key,
            &header.wrapped_master_key,
            &header_aad(header.vault_id, header.generation),
        )
        .is_ok())
    }

    /// The package's manifest, the counts that say what it holds, and where each object comes
    /// from in the vault.
    fn build_package_manifest(
        &self,
        unlocked: &UnlockedVault,
        profile: &PatientProfile,
        options: ExportOptions,
        now_ms: u64,
    ) -> Result<(PackageManifest, ExportReport, HashMap<Uuid, Source>), VaultError> {
        let manifest = &unlocked.manifest;
        let mut report = ExportReport {
            package_id: Uuid::nil(),
            generation: manifest.generation,
            documents: 0,
            hidden: 0,
            folders: 0,
            ai_answers: 0,
            with_clinic_evidence: 0,
            left_out_damaged: 0,
            evidence_left_out: 0,
            history_entries: 0,
            plaintext_bytes: 0,
        };
        let folders: Vec<PackageFolder> = manifest
            .folders
            .iter()
            .filter(|folder| folder.profile_id == profile.id)
            .map(|folder| PackageFolder {
                id: folder.id,
                parent_id: folder.parent_id,
                name: folder.name.clone(),
                created_at_ms: folder.created_at_ms,
            })
            .collect();
        report.folders = folders.len();

        let mut records = Vec::new();
        let mut sources = HashMap::new();
        for record in manifest
            .records
            .iter()
            .filter(|record| record.profile_id == profile.id)
        {
            if !object_required(record) {
                report.left_out_damaged += 1;
                continue;
            }
            for object in record.objects() {
                sources.insert(
                    object.id,
                    Source {
                        id: object.id,
                        record_id: record.id,
                        object_name: object.object_name.to_owned(),
                        plaintext_size: object.plaintext_size,
                        wrapped_key: object.wrapped_key.clone(),
                        sha256: object.sha256.map(str::to_owned),
                    },
                );
            }
            let object = |id: Uuid, size: u64| PackageObject { id, size };
            let carried = match (&record.carried, &record.delivery) {
                (Some(carried), _) => Some(carried.clone()),
                (None, Some(_)) => {
                    let found = carried::from_filed(record, &manifest.portal_links);
                    if found.is_none() {
                        report.evidence_left_out += 1;
                    }
                    found
                }
                (None, None) => None,
            };
            if carried.is_some() {
                report.with_clinic_evidence += 1;
            }
            report.documents += 1;
            report.hidden += usize::from(record.hidden.is_some());
            report.ai_answers += record.ai_results.len();
            report.plaintext_bytes = record.objects().fold(report.plaintext_bytes, |total, o| {
                total.saturating_add(o.plaintext_size)
            });
            records.push(PackageRecord {
                id: record.id,
                name: record.display_name.clone(),
                source_label: record.source_label.clone(),
                media_type: record.media_type.clone(),
                imported_at_ms: record.imported_at_ms,
                folder_ids: record.folder_ids.clone(),
                hidden_at_ms: record.hidden.map(|hidden| hidden.at_ms),
                display: object(record.id, record.plaintext_size),
                original_pdf: record
                    .original_pdf
                    .as_ref()
                    .map(|original| object(original.id, original.plaintext_size)),
                ai_answers: record
                    .ai_results
                    .iter()
                    .map(|answer| PackageAiAnswer {
                        object: object(answer.id, answer.plaintext_size),
                        tool: match serde_json::to_value(answer.tool) {
                            Ok(serde_json::Value::String(tool)) => tool,
                            _ => String::new(),
                        },
                        lang: answer.lang.clone(),
                        term: answer.term.clone(),
                        model_name: answer.model_name.clone(),
                        model_sha256: answer.model_sha256.clone(),
                        created_at_ms: answer.created_at_ms,
                        superseded: answer.superseded,
                    })
                    .collect(),
                carried: carried
                    .map(|carried| serde_json::to_value(carried).map_err(|_| VaultError::Storage))
                    .transpose()?,
            });
        }

        let history = if options.include_history {
            let excerpt = self.history_excerpt(unlocked, &records)?;
            report.history_entries = excerpt.len();
            Some(excerpt)
        } else {
            None
        };
        let package = PackageManifest {
            format: PACKAGE_FORMAT,
            exported_at_ms: now_ms,
            profile: PackageProfile {
                display_name: profile.display_name.clone(),
                full_name: profile.full_name.clone(),
                birth_date: profile.birth_date.clone(),
                previous_full_names: profile.previous_full_names.clone().unwrap_or_default(),
                created_at_ms: profile.created_at_ms,
            },
            folders,
            records,
            history,
        };
        package.validate()?;
        Ok((package, report, sources))
    }

    /// The latest record-level events about the documents that are going (at most
    /// `MAX_HISTORY_ENTRIES`), cut down to what an excerpt keeps: when, what, which document
    /// and its name then, and the source chain's hashes, nothing of the source vault.
    fn history_excerpt(
        &self,
        unlocked: &UnlockedVault,
        records: &[PackageRecord],
    ) -> Result<Vec<serde_json::Value>, VaultError> {
        let view = self.history_view_in_session(unlocked)?;
        // What cannot be read is not guessed at: an incomplete history gives the part that
        // checked out, which is what the history screen shows too.
        let going: HashSet<Uuid> = records.iter().map(|record| record.id).collect();
        let mut excerpt: Vec<ImportedHistoryEntry> = view
            .entries
            .iter()
            .chain(&view.later)
            .filter(|entry| entry.record_id.is_some_and(|id| going.contains(&id)))
            .filter(|entry| ImportedHistoryEntry::event_allowed(entry.event))
            .map(|entry| {
                let name = |name: &Option<String>| {
                    name.clone()
                        .filter(|n| n == n.trim() && validate_name(n).is_ok())
                };
                ImportedHistoryEntry {
                    at_ms: entry.at_ms,
                    event: entry.event,
                    record_id: entry.record_id,
                    name: name(&entry.name),
                    old_name: name(&entry.old_name),
                    how: entry.how.clone().filter(|how| {
                        !how.is_empty()
                            && how.len() <= 32
                            && how.bytes().all(|b| b.is_ascii_alphanumeric())
                    }),
                    hash: entry.hash(),
                    prev: entry.prev.clone(),
                }
            })
            .collect();
        if excerpt.len() > profile_package::MAX_HISTORY_ENTRIES {
            excerpt.drain(..excerpt.len() - profile_package::MAX_HISTORY_ENTRIES);
        }
        excerpt
            .iter()
            .map(|entry| serde_json::to_value(entry).map_err(|_| VaultError::Storage))
            .collect()
    }

    /// Notes in the history that a person was exported, after the package has been read back.
    /// The profile and its name, and where the file was saved (cut as every place is); no
    /// document names. Best effort, as for a backup: the file exists either way.
    pub(crate) fn record_profile_exported(&self, profile_id: Uuid, place: &str) {
        let mut guard = self.session();
        if let Some(unlocked) = guard.as_mut() {
            let name = unlocked
                .manifest
                .profiles
                .iter()
                .find(|profile| profile.id == profile_id)
                .map(|profile| profile.display_name.clone());
            let mut entry =
                HistoryEntry::new(HistoryEvent::ProfileExported, crate::now_ms()).with_place(place);
            entry.profile_id = Some(profile_id);
            entry.name = name;
            record_in_session(&self.root, unlocked, vec![entry]);
        }
    }
}

/// Where one object of the package comes from in the vault.
struct Source {
    id: Uuid,
    record_id: Uuid,
    object_name: String,
    plaintext_size: u64,
    wrapped_key: WrappedSecret,
    sha256: Option<String>,
}

impl Source {
    fn reference(&self) -> RecordObject<'_> {
        RecordObject {
            // Read through the vault's own object id: `read_object_ref` binds it into the chunks.
            id: self.id,
            object_name: &self.object_name,
            plaintext_size: self.plaintext_size,
            wrapped_key: &self.wrapped_key,
            sha256: self.sha256.as_deref(),
        }
    }
}

fn error_of_package(error: PackageError) -> VaultError {
    match error {
        PackageError::Cancelled => VaultError::Cancelled,
        PackageError::WeakPassphrase => VaultError::WeakPassphrase,
        PackageError::Storage => VaultError::Storage,
        _ => VaultError::Invalid,
    }
}

impl From<PackageError> for VaultError {
    fn from(error: PackageError) -> Self {
        error_of_package(error)
    }
}

/// Reads a finished package back with its key, as the receiving end will: the end is
/// checked first, then every object is decrypted and hashed, then the whole is verified. It
/// must find exactly the objects, sizes and hashes the writer saw. Until this passes the
/// export has not succeeded: a file that does not read back is a file the patient would
/// carry to the other device and learn about there.
pub(crate) fn verify_written<R: Read + Seek>(
    source: R,
    secret: PackageSecret<'_>,
    expected: &[ObjectRead],
    still_open: &dyn Fn() -> bool,
) -> Result<(), VaultError> {
    let mut reader = PackageReader::open(source, secret)?;
    reader.verify_tail()?;
    while reader.next_object().is_some() {
        reader.read_object(&mut io::sink(), still_open)?;
    }
    let verified = reader.finish()?;
    if verified.objects() == expected {
        Ok(())
    } else {
        Err(VaultError::Corrupt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::profile_package::{generate_package_key, PackageReader};
    use std::io::Cursor;

    const PASSWORD: &str = "correct horse battery staple 9173";
    const CHILD_MARKER: &[u8] = b"FAKE-CHILD-DOCUMENT-BYTES";
    const PARENT_MARKER: &[u8] = b"FAKE-PARENT-ONLY-BYTES-31";

    fn source(name: &str, data: &[u8]) -> ImportSource {
        ImportSource {
            display_name: name.to_owned(),
            reader: Box::new(Cursor::new(data.to_vec())),
        }
    }

    fn bytes_of(marker: &[u8], extra: usize) -> Vec<u8> {
        let mut bytes = marker.to_vec();
        bytes.extend((0..extra).map(|i| (i * 7 % 251) as u8));
        bytes
    }

    struct Vault {
        _temp: tempfile::TempDir,
        store: VaultStore,
        child: Uuid,
        parent: Uuid,
        child_records: Vec<Uuid>,
    }

    /// FAKE Child (nested folders, three documents, one hidden, one with an AI answer) and
    /// FAKE Parent, whose bytes must never reach the child's package.
    fn vault() -> Vault {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Parent", 1).unwrap();
        let parent = store.snapshot().unwrap().profiles[0].id;
        let child = store.create_profile("FAKE Child", 2).unwrap();
        let outer = store.create_folder(child, None, "FAKE Letters", 3).unwrap();
        let inner = store
            .create_folder(child, Some(outer), "FAKE Results", 4)
            .unwrap();
        store
            .import(
                parent,
                vec![],
                vec![source(
                    "FAKE Parent Letter.pdf",
                    &bytes_of(PARENT_MARKER, 900),
                )],
                5,
            )
            .unwrap();
        let mut child_records = Vec::new();
        for (name, folders, size) in [
            ("FAKE Child A.pdf", vec![], 1_000),
            ("FAKE Child B.pdf", vec![inner], CHUNK_SIZE + 5),
            ("FAKE Child C.pdf", vec![outer, inner], 0),
        ] {
            let outcome = store
                .import(
                    child,
                    folders,
                    vec![source(name, &bytes_of(CHILD_MARKER, size))],
                    6,
                )
                .unwrap();
            child_records.push(outcome.imported[0]);
        }
        store.hide_record(child_records[2], 7).unwrap();
        store
            .save_ai_result(
                child_records[0],
                crate::vault::ai_results::AiResultInput {
                    tool: crate::vault::ai_results::AiTool::Summary,
                    lang: "en".into(),
                    term: None,
                    model_name: "FAKE model".into(),
                    model_sha256: "00".repeat(32),
                },
                b"{\"v\":1}",
                8,
            )
            .unwrap();
        Vault {
            _temp: temp,
            store,
            child,
            parent,
            child_records,
        }
    }

    const WITH_HISTORY: ExportOptions = ExportOptions {
        include_history: true,
    };

    fn export(
        vault: &Vault,
        options: ExportOptions,
        key: &[u8; 16],
    ) -> Result<Written<Vec<u8>>, VaultError> {
        vault.store.export_profile(
            vault.child,
            options,
            PackageSecret::Key(key),
            Vec::new(),
            100,
        )
    }

    fn open() -> bool {
        true
    }

    /// Reads a package fully, as the importing end will: manifest, every object, then verified.
    fn read(bytes: &[u8], key: &[u8; 16]) -> (PackageManifest, Vec<Vec<u8>>) {
        let mut reader = PackageReader::open(Cursor::new(bytes), PackageSecret::Key(key)).unwrap();
        let manifest = reader.manifest().clone();
        let mut objects = Vec::new();
        while reader.next_object().is_some() {
            let mut sink = Vec::new();
            reader.read_object(&mut sink, &open).unwrap();
            objects.push(sink);
        }
        reader.finish().unwrap();
        (manifest, objects)
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn one_person_is_exported_whole_and_the_other_is_not_in_it_at_all() {
        let v = vault();
        let (key, _) = generate_package_key();
        let written = export(&v, WITH_HISTORY, &key).unwrap();
        let report = written.report.clone();
        assert_eq!(report.documents, 3);
        assert_eq!(report.hidden, 1);
        assert_eq!(report.folders, 2);
        assert_eq!(report.ai_answers, 1);
        assert_eq!(report.left_out_damaged, 0);
        assert_eq!(report.with_clinic_evidence, 0);
        let bytes = written.sink;
        // The parent's documents, name and bytes are nowhere in the file.
        for needle in [PARENT_MARKER, b"FAKE", b"Parent", b"Child"] {
            assert!(!contains(&bytes, needle));
        }
        let (manifest, objects) = read(&bytes, &key);
        assert_eq!(manifest.records.len(), 3);
        assert_eq!(manifest.folders.len(), 2);
        assert_eq!(manifest.profile.display_name, "FAKE Child");
        let decrypted: Vec<u8> = objects.iter().flatten().copied().collect();
        assert!(!contains(&decrypted, PARENT_MARKER));
        // Each document is the vault's bytes, in the manifest's order.
        let mut expected = Vec::new();
        for id in &v.child_records {
            let mut out = Vec::new();
            v.store.export(*id, &mut out).unwrap();
            expected.push(out);
        }
        expected.insert(1, b"{\"v\":1}".to_vec());
        // Record 0, then its AI answer, then records 1 and 2.
        let order = [&expected[0], &expected[1], &expected[2], &expected[3]];
        assert_eq!(objects.len(), 4);
        for (found, wanted) in objects.iter().zip(order) {
            assert_eq!(found, wanted);
        }
        // The one the patient hid arrives hidden, and is still a document.
        assert_eq!(
            manifest
                .records
                .iter()
                .filter(|r| r.hidden_at_ms.is_some())
                .count(),
            1
        );
        // The package has ids of its own: none of the vault's is in it.
        let text = serde_json::to_string(&manifest).unwrap();
        for id in v.child_records.iter().chain([&v.child, &v.parent]) {
            assert!(!text.contains(&id.to_string()));
        }
        // And the vault's state is as it was: an export changes nothing.
        assert_eq!(
            v.store.session().as_ref().unwrap().manifest.generation,
            report.generation
        );
    }

    #[test]
    fn the_package_reads_back_and_a_damaged_one_does_not() {
        let v = vault();
        let (key, _) = generate_package_key();
        let written = export(&v, WITH_HISTORY, &key).unwrap();
        let digests = written.digests.clone();
        let bytes = written.sink;
        let check = |bytes: &[u8], expected: &[ObjectRead]| {
            verify_written(
                Cursor::new(bytes.to_vec()),
                PackageSecret::Key(&key),
                expected,
                &open,
            )
        };
        assert!(check(&bytes, &digests).is_ok());
        // Cut, flipped anywhere sampled, extended: none passes.
        assert!(check(&bytes[..bytes.len() - 1], &digests).is_err());
        assert!(check(&bytes[..bytes.len() / 2], &digests).is_err());
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(check(&longer, &digests).is_err());
        for at in (20..bytes.len()).step_by(bytes.len() / 37 + 1) {
            let mut flipped = bytes.clone();
            flipped[at] ^= 1;
            assert!(check(&flipped, &digests).is_err(), "{at}");
        }
        // A package that reads back but is not what the writer saw is refused as damaged.
        let mut other = digests.clone();
        other[0].sha256[0] ^= 1;
        assert!(matches!(check(&bytes, &other), Err(VaultError::Corrupt)));
        assert!(matches!(
            check(&bytes, &digests[1..]),
            Err(VaultError::Corrupt)
        ));
        // Stopped between chunks.
        assert!(matches!(
            verify_written(
                Cursor::new(bytes.clone()),
                PackageSecret::Key(&key),
                &digests,
                &|| false
            ),
            Err(VaultError::Cancelled)
        ));
    }

    #[test]
    fn the_history_excerpt_holds_this_persons_documents_only_and_can_be_left_out() {
        let v = vault();
        let (key, _) = generate_package_key();
        let with = export(&v, WITH_HISTORY, &key).unwrap();
        assert!(with.report.history_entries > 0);
        let (manifest, _) = read(&with.sink, &key);
        let history = manifest.history.unwrap();
        assert_eq!(history.len(), with.report.history_entries);
        let ids: HashSet<String> = manifest.records.iter().map(|r| r.id.to_string()).collect();
        for entry in &history {
            // Record-level events, on the package's own record ids; nothing of the vault.
            let id = entry["recordId"].as_str().unwrap();
            assert!(ids.contains(id));
            for forbidden in [
                "profileId",
                "folderId",
                "place",
                "app",
                "portalLinkId",
                "seq",
            ] {
                assert!(entry.get(forbidden).is_none(), "{forbidden}");
            }
        }
        let text = serde_json::to_string(&history).unwrap();
        assert!(!text.contains("Parent"));
        let without = export(
            &v,
            ExportOptions {
                include_history: false,
            },
            &key,
        )
        .unwrap();
        assert_eq!(without.report.history_entries, 0);
        assert!(read(&without.sink, &key).0.history.is_none());
    }

    #[test]
    fn a_document_hidden_as_damaged_is_left_out_and_counted() {
        let v = vault();
        let damaged = v.child_records[1];
        v.store
            .mutate_recorded(|m, _| {
                m.records
                    .iter_mut()
                    .find(|r| r.id == damaged)
                    .unwrap()
                    .hidden = Some(Hidden {
                    at_ms: 9,
                    reason: HiddenReason::Damaged,
                });
                Ok(())
            })
            .unwrap();
        let (key, _) = generate_package_key();
        let written = export(&v, WITH_HISTORY, &key).unwrap();
        assert_eq!(written.report.left_out_damaged, 1);
        assert_eq!(written.report.documents, 2);
        let (manifest, _) = read(&written.sink, &key);
        assert_eq!(manifest.records.len(), 2);
        // Its history is not in the excerpt either: no entry points at nothing.
        let text = serde_json::to_string(&manifest.history).unwrap();
        let ids: HashSet<String> = manifest.records.iter().map(|r| r.id.to_string()).collect();
        for entry in manifest.history.unwrap() {
            if let Some(id) = entry.get("recordId") {
                assert!(ids.contains(id.as_str().unwrap()), "{text}");
            }
        }
    }

    #[test]
    #[allow(clippy::disallowed_methods)] // A simulated lost file, in a test vault.
    fn a_missing_document_file_fails_the_export_and_names_the_document() {
        let v = vault();
        let record = v.child_records[0];
        let path = {
            let guard = v.store.session();
            let r = guard
                .as_ref()
                .unwrap()
                .manifest
                .records
                .iter()
                .find(|r| r.id == record)
                .unwrap();
            v.store.root.join("objects").join(&r.object_name)
        };
        std::fs::remove_file(path).unwrap();
        let (key, _) = generate_package_key();
        assert!(export(&v, WITH_HISTORY, &key).is_err());
    }

    #[test]
    fn a_failing_sink_or_a_cancel_ends_the_export_and_changes_nothing() {
        struct FailsAfter(usize);
        impl Write for FailsAfter {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                if self.0 < data.len() {
                    return Err(io::Error::new(io::ErrorKind::StorageFull, "no room"));
                }
                self.0 -= data.len();
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let v = vault();
        let (key, _) = generate_package_key();
        let generation = v.store.session().as_ref().unwrap().manifest.generation;
        let history = v.store.history_entries().unwrap().len();
        for room in [0, 40, 3_000, CHUNK_SIZE] {
            let result = v.store.export_profile(
                v.child,
                WITH_HISTORY,
                PackageSecret::Key(&key),
                FailsAfter(room),
                100,
            );
            assert!(result.is_err(), "{room}");
        }
        // Locked from another thread while writing: a cancel between chunks.
        struct CancelsAfter<'a>(&'a VaultStore, usize);
        impl Write for CancelsAfter<'_> {
            fn write(&mut self, data: &[u8]) -> io::Result<usize> {
                if self.1 <= data.len() {
                    self.0.cancel_io.store(true, Ordering::Release);
                }
                self.1 = self.1.saturating_sub(data.len());
                Ok(data.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let result = v.store.export_profile(
            v.child,
            WITH_HISTORY,
            PackageSecret::Key(&key),
            CancelsAfter(&v.store, 5_000),
            100,
        );
        assert!(matches!(result, Err(VaultError::Cancelled)));
        v.store.cancel_io.store(false, Ordering::Release);
        assert_eq!(
            v.store.session().as_ref().unwrap().manifest.generation,
            generation
        );
        assert_eq!(v.store.history_entries().unwrap().len(), history);
        // And it works afterwards.
        assert!(export(&v, WITH_HISTORY, &key).is_ok());
    }

    #[test]
    fn only_a_person_here_is_exported_and_never_shared_with_me_or_in_recovery() {
        let v = vault();
        let (key, _) = generate_package_key();
        let try_id = |id: Uuid| {
            v.store
                .export_profile(id, WITH_HISTORY, PackageSecret::Key(&key), Vec::new(), 1)
                .map(|_| ())
        };
        assert!(matches!(try_id(Uuid::new_v4()), Err(VaultError::NotFound)));
        let shared = shared_profile_id(v.store.session().as_ref().unwrap().manifest.vault_id);
        // Shared with me is made when a document first needs it: not yet here.
        assert!(matches!(try_id(shared), Err(VaultError::NotFound)));
        v.store
            .mutate_recorded(|m, _| {
                m.profiles.push(PatientProfile {
                    id: shared,
                    display_name: SHARED_PROFILE_NAME.to_owned(),
                    created_at_ms: 3,
                    full_name: None,
                    birth_date: None,
                    previous_full_names: None,
                    hidden: None,
                    imported_from: None,
                    imported_history: None,
                });
                Ok(())
            })
            .unwrap();
        assert!(matches!(try_id(shared), Err(VaultError::Invalid)));
        // The parent can be exported too: any person, not only the one made second.
        assert!(try_id(v.parent).is_ok());
        v.store.lock();
        assert!(matches!(try_id(v.child), Err(VaultError::Locked)));
    }

    #[test]
    fn a_typed_passphrase_works_but_never_the_vaults_own() {
        let v = vault();
        let package_passphrase = "tiger-lamp-orbit-quartz-mellow-7391";
        let ok = v.store.export_profile(
            v.child,
            WITH_HISTORY,
            PackageSecret::Passphrase(package_passphrase),
            Vec::new(),
            1,
        );
        let bytes = ok.unwrap().sink;
        assert!(PackageReader::open(
            Cursor::new(&bytes),
            PackageSecret::Passphrase(package_passphrase)
        )
        .is_ok());
        let same = v.store.export_profile(
            v.child,
            WITH_HISTORY,
            PackageSecret::Passphrase(PASSWORD),
            Vec::new(),
            1,
        );
        assert!(matches!(same, Err(VaultError::WeakPassphrase)));
        // Weak by the vault's rules, or made of the person's own name.
        for weak in ["short", "FAKE Child FAKE Child"] {
            assert!(
                matches!(
                    v.store.export_profile(
                        v.child,
                        WITH_HISTORY,
                        PackageSecret::Passphrase(weak),
                        Vec::new(),
                        1
                    ),
                    Err(VaultError::WeakPassphrase | VaultError::Invalid)
                ),
                "{weak}"
            );
        }
    }

    #[test]
    fn the_history_notes_an_export_by_person_and_place_never_by_document() {
        let v = vault();
        let before = v.store.history_entries().unwrap().len();
        v.store
            .record_profile_exported(v.child, "/tmp/FAKE-place/handover.mycarlosprofile");
        let entries = v.store.history_entries().unwrap();
        assert_eq!(entries.len(), before + 1);
        let entry = entries.last().unwrap();
        assert_eq!(entry.event, HistoryEvent::ProfileExported);
        assert_eq!(entry.profile_id, Some(v.child));
        assert_eq!(entry.name.as_deref(), Some("FAKE Child"));
        assert!(entry.record_id.is_none());
        let json = serde_json::to_string(entry).unwrap();
        assert!(!json.contains("Letter") && !json.contains(".pdf"));
        // The vault reads again after it.
        v.store.lock();
        v.store.unlock(PASSWORD).unwrap();
    }

    #[test]
    fn a_delivered_document_carries_its_clinic_evidence_without_any_private_key() {
        let (_temp, store, link, record_id) =
            crate::vault::delivery::pair_original_fixture_for_test();
        // A delivery is filed in Shared with me; the patient moves it to a person, and that
        // person is the one exported.
        let profile = {
            let guard = store.session();
            let manifest = &guard.as_ref().unwrap().manifest;
            let shared = shared_profile_id(manifest.vault_id);
            manifest
                .profiles
                .iter()
                .map(|p| p.id)
                .find(|id| *id != shared)
                .unwrap()
        };
        store
            .mutate_recorded(|m, _| {
                let record = m.records.iter_mut().find(|r| r.id == record_id).unwrap();
                record.profile_id = profile;
                record.folder_ids.clear();
                Ok(())
            })
            .unwrap();
        let (key, _) = generate_package_key();
        let written = store
            .export_profile(
                profile,
                WITH_HISTORY,
                PackageSecret::Key(&key),
                Vec::new(),
                1,
            )
            .unwrap();
        assert_eq!(written.report.with_clinic_evidence, 1);
        assert_eq!(written.report.evidence_left_out, 0);
        let (manifest, _) = read(&written.sink, &key);
        let carried = manifest.records[0].carried.clone().unwrap();
        let text = carried.to_string();
        // Public and signed only: the device's public keys are there, never a private one,
        // a link id, the portal address or the device's name.
        let (x25519, ed25519) = link.keys.public();
        assert!(text.contains("deviceEd25519"));
        for forbidden in ["\"keys\"", "portalBase", "deviceName", &link.id.to_string()] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
        let _ = (x25519, ed25519);
        // It is the evidence a vault accepts without the link: it reads back as `Carried`
        // and stands up as a record of a vault that holds no link.
        let parsed: crate::portal_delivery::Carried = serde_json::from_value(carried).unwrap();
        let mut record = store
            .session()
            .as_ref()
            .unwrap()
            .manifest
            .records
            .iter()
            .find(|r| r.id == record_id)
            .unwrap()
            .clone();
        record.delivery = None;
        record.reading_aid = None;
        record.carried = Some(parsed);
        assert!(carried::valid_carried(&record));
    }

    /// Makes the named boundaries fail on this thread, and stops when dropped.
    struct FailsAt;
    impl FailsAt {
        fn new(boundary: &'static str) -> Self {
            FAIL_AT_TEST_BOUNDARY.set(Box::leak(Box::new([boundary])));
            Self
        }
    }
    impl Drop for FailsAt {
        fn drop(&mut self) {
            FAIL_AT_TEST_BOUNDARY.set(&[]);
        }
    }

    fn files_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_saved_file_is_read_back_before_it_replaces_anything_and_is_noted_after() {
        let v = vault();
        let out = tempfile::tempdir().unwrap();
        let destination = out.path().join("handover.mycarlosprofile");
        let (key, text) = generate_package_key();
        let before = v.store.history_entries().unwrap().len();
        let report = v
            .store
            .export_profile_atomic(
                v.child,
                WITH_HISTORY,
                PackageSecret::Key(&key),
                &destination,
                100,
            )
            .unwrap();
        assert_eq!(report.documents, 3);
        // Only the file: no temporary one is left beside it.
        assert_eq!(files_in(out.path()), ["handover.mycarlosprofile"]);
        let bytes = fs::read(&destination).unwrap();
        let (manifest, _) = read(&bytes, &key);
        assert_eq!(manifest.records.len(), 3);
        // The key as shown is the key that opens it.
        let typed = crate::vault::profile_package::parse_package_key(&text).unwrap();
        assert!(PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&typed)).is_ok());
        // One entry, after the file was in place.
        let entries = v.store.history_entries().unwrap();
        assert_eq!(entries.len(), before + 1);
        assert_eq!(entries.last().unwrap().event, HistoryEvent::ProfileExported);
    }

    #[test]
    fn a_failure_at_any_step_leaves_the_destination_and_the_history_as_they_were() {
        let v = vault();
        let out = tempfile::tempdir().unwrap();
        let destination = out.path().join("handover.mycarlosprofile");
        fs::write(&destination, b"EARLIER FILE").unwrap();
        let (key, _) = generate_package_key();
        let before = v.store.history_entries().unwrap().len();
        for boundary in [
            "export.before-sync",
            "export.before-verify",
            "export.before-rename",
        ] {
            let _fail = FailsAt::new(boundary);
            let result = v.store.export_profile_atomic(
                v.child,
                WITH_HISTORY,
                PackageSecret::Key(&key),
                &destination,
                100,
            );
            assert!(result.is_err(), "{boundary}");
            assert_eq!(
                fs::read(&destination).unwrap(),
                b"EARLIER FILE",
                "{boundary}"
            );
            assert_eq!(
                files_in(out.path()),
                ["handover.mycarlosprofile"],
                "{boundary}"
            );
            assert_eq!(
                v.store.history_entries().unwrap().len(),
                before,
                "{boundary}"
            );
        }
        // A passphrase the vault refuses fails before anything is written.
        let result = v.store.export_profile_atomic(
            v.child,
            WITH_HISTORY,
            PackageSecret::Passphrase(PASSWORD),
            &destination,
            100,
        );
        assert!(matches!(result, Err(VaultError::WeakPassphrase)));
        assert_eq!(fs::read(&destination).unwrap(), b"EARLIER FILE");
        assert_eq!(files_in(out.path()), ["handover.mycarlosprofile"]);
        // And without a failure it replaces the earlier file.
        v.store
            .export_profile_atomic(
                v.child,
                WITH_HISTORY,
                PackageSecret::Key(&key),
                &destination,
                100,
            )
            .unwrap();
        assert_ne!(fs::read(&destination).unwrap(), b"EARLIER FILE");
    }

    #[test]
    fn a_package_is_never_saved_inside_the_vault_home() {
        let v = vault();
        let home = vault_home(&v.store.root).unwrap();
        let (key, _) = generate_package_key();
        let result = v.store.export_profile_atomic(
            v.child,
            WITH_HISTORY,
            PackageSecret::Key(&key),
            &home.join("handover.mycarlosprofile"),
            1,
        );
        assert!(matches!(result, Err(VaultError::Invalid)));
        assert!(!home.join("handover.mycarlosprofile").exists());
    }
}
