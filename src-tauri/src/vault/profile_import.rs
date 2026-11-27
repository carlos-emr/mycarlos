//! Importing a handover package (#360 PR 4): a person's documents, from a file and a key, into
//! this vault as a new profile.
//!
//! **The package is hostile even after its tag checks out**: anyone who holds the key can make
//! one, so nothing in it is believed beyond what this vault would accept from its own screens.
//! Every size is capped before anything is allocated (the package's own limits, then this
//! vault's: a folder no deeper than the vault allows, names within the vault's rules, a
//! manifest that fits), every document is re-encrypted under this vault's own keys as it
//! streams in (never held, never written readable), every field the vault fixes for its own
//! records (the source label, the media type, the time it was added) is set here, not taken, and
//! the new manifest must pass the same validation a manifest read from disk does before it is
//! committed.
//!
//! Nothing published changes until the whole package has been read and `finish` has verified it
//! (the end, the tag, every object against its digest). Objects are staged outside the vault's
//! objects, published, and then **one manifest commit** adds the person, folders, documents,
//! evidence and the old history together; a failure, a lock or a crash before it leaves the vault
//! as it was (what a crash leaves in `objects/` is an orphan, which unlock moves aside).
//!
//! Imported documents are never clinic-verified because the package says so: carried evidence
//! follows `valid_carried` and is dropped for a delivery this vault already holds; "verified" is
//! only ever through a linked clinic's key (`verified_clinic`).
use super::*;
use crate::vault::profile_package::{
    PackageManifest, PackageReader, PackageRecord, PackageSecret, MAX_HISTORY_ENTRIES,
};
use std::io::Seek;

/// The deepest folder a vault holds (`validate_manifest_structure` refuses 32).
const MAX_IMPORT_FOLDER_DEPTH: usize = 31;
/// Free space kept beyond a package's documents, so that an import never takes the last of it.
const IMPORT_SPACE_RESERVE: u64 = 256 * 1024 * 1024;
/// What a file costs beyond its bytes: a filesystem block, its directory entry and the staging copy.
const IMPORT_PER_FILE_OVERHEAD: u64 = 16 * 1024;

/// How a package was taken to be one this vault already has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DuplicateBy {
    /// The same file: its package id is on a profile (`importedFrom`).
    Package,
    /// The same documents: original PDFs whose SHA-256 a profile of this vault already holds,
    /// whatever the file, the names or the person's label.
    Content,
}

/// A person this vault already holds, from the same package or the same documents.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AlreadyHere {
    pub profile_id: Uuid,
    pub by: DuplicateBy,
    /// How many of the package's original PDFs that profile already holds (for `Content`).
    pub matching_documents: usize,
}

/// What a package holds and whether this vault has it, from the header, the manifest and the end
/// of the file: no document has been read, and nothing is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportPreview {
    pub package_id: Uuid,
    pub exported_at_ms: u64,
    pub display_name: String,
    pub full_name: Option<String>,
    pub birth_date: Option<String>,
    /// The names the person had before, as the file lists them: once imported they count as the
    /// clinic's name when a delivery is filed (#340), so the preview says so.
    pub previous_full_names: Vec<String>,
    pub documents: usize,
    pub hidden: usize,
    pub folders: usize,
    pub ai_answers: usize,
    pub with_clinic_evidence: usize,
    pub history_entries: usize,
    pub plaintext_bytes: u64,
    pub already_here: Option<AlreadyHere>,
}

#[derive(Clone, Debug)]
pub(crate) struct ImportOptions {
    /// What to call the person here; the package's label when none.
    pub display_name: Option<String>,
    /// Make the person although this vault already has them (`already_here`).
    pub allow_duplicate: bool,
}

/// What an import did, in counts that name no document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProfileImported {
    pub profile_id: Uuid,
    pub documents: usize,
    pub folders: usize,
    pub hidden: usize,
    pub ai_answers: usize,
    pub ai_answers_dropped: usize,
    pub evidence_kept: usize,
    /// Evidence not kept: it did not stand up, or this vault holds that delivery already.
    pub evidence_dropped: usize,
    pub history_entries: usize,
    /// The short code the source can recompute from the file and its key.
    pub receipt_code: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ImportResult {
    Imported(ProfileImported),
    /// Nothing was written: this vault already holds the person, and `allow_duplicate` was not
    /// given.
    AlreadyHere(AlreadyHere),
}

/// One object staged for publication.
struct Staged {
    object_name: String,
}

impl VaultStore {
    /// Reads a package's header, manifest and end with its key and says what it holds and
    /// whether this vault has it. Refuses a package that is cut short, altered or extended,
    /// or from a newer myCarlos. Nothing is written and no document is read.
    pub(crate) fn inspect_profile_package<R: Read + Seek>(
        &self,
        source: R,
        secret: PackageSecret<'_>,
    ) -> Result<ImportPreview, VaultError> {
        let mut reader = PackageReader::open(source, secret)?;
        reader.verify_tail()?;
        let guard = self.session();
        let unlocked = guard.as_ref().ok_or(VaultError::Locked)?;
        let manifest = reader.manifest();
        let already_here = already_here(&unlocked.manifest, &reader);
        Ok(preview_of(manifest, reader.package_id(), already_here))
    }

    /// Makes a profile from a package: staged, re-encrypted under this vault's keys, verified,
    /// published and committed together, or not at all.
    pub(crate) fn import_profile_package<R: Read + Seek>(
        &self,
        source: R,
        secret: PackageSecret<'_>,
        options: &ImportOptions,
        now_ms: u64,
    ) -> Result<ImportResult, VaultError> {
        let mut reader = PackageReader::open(source, secret)?;
        reader.verify_tail()?;
        let mut guard = self.session();
        let unlocked = guard.as_mut().ok_or(VaultError::Locked)?;
        if unlocked.recovery.is_some() {
            return Err(VaultError::RecoveryMode);
        }
        let cancelled = || self.cancel_io.load(Ordering::Acquire);
        if cancelled() {
            return Err(VaultError::Cancelled);
        }
        if let Some(found) = already_here(&unlocked.manifest, &reader) {
            if !options.allow_duplicate {
                return Ok(ImportResult::AlreadyHere(found));
            }
        }
        let package = reader.manifest().clone();
        let package_id = reader.package_id();
        let link_package = !matches!(
            already_here(&unlocked.manifest, &reader),
            Some(AlreadyHere {
                by: DuplicateBy::Package,
                ..
            })
        );
        let plan = plan_import(&package, options, &unlocked.manifest, now_ms)?;
        // Space for the documents, before any is written (best effort: where the platform
        // cannot say, a full disk is still a clean failure below).
        // Each object also takes a block or more of its own on the disk, whatever its size.
        let needed = package
            .total_plaintext_bytes()
            .saturating_add(package.total_plaintext_bytes() / 512)
            .saturating_add(package.objects().len() as u64 * IMPORT_PER_FILE_OVERHEAD)
            .saturating_add(IMPORT_SPACE_RESERVE);
        if crate::disk_space::free_bytes(&self.root).is_some_and(|free| free < needed) {
            return Err(VaultError::NoSpace);
        }

        // The manifest this import would make, with stand-ins for what staging produces, checked
        // as a manifest read from disk is: a package this vault cannot hold (a folder too deep, a
        // name it refuses, too many of anything) is refused before one byte is written.
        {
            let keys = derive_keys(unlocked.manifest.vault_id, &unlocked.master_key)?;
            trial_manifest(&plan, &package, &unlocked.manifest, &keys, now_ms)?;
        }
        let job_id = Uuid::new_v4();
        let stage = self.root.join("staging").join(job_id.to_string());
        create_private_dir_all(&stage)?;
        let vault_id = unlocked.manifest.vault_id;
        let keys = derive_keys(vault_id, &unlocked.master_key)?;
        let mut published: Vec<String> = Vec::new();
        let mut commit_attempted = false;
        let result = (|| {
            // 1. Stage every object, re-encrypted, and read the whole package.
            let StagedPackage {
                staged,
                records,
                dropped_answers,
                receipt_code,
            } = self.stage_package(reader, &package, &plan, &stage, &keys, vault_id, now_ms)?;
            if cancelled() {
                return Err(VaultError::Cancelled);
            }
            terminate_at_test_boundary("package-import.after-staging");
            fail_at_test_boundary("package-import.after-staging")?;

            // 2. The new manifest, checked as a manifest read from disk is.
            let (next, summary) = plan.assemble(
                &package,
                records,
                &unlocked.manifest,
                Facts {
                    package_id: link_package.then_some(package_id),
                    dropped_answers,
                    receipt_code,
                    now_ms,
                },
            )?;
            validate_manifest_structure(&next, vault_id).map_err(|_| VaultError::Invalid)?;
            let size = serde_json::to_vec(&next)
                .map_err(|_| VaultError::Storage)?
                .len();
            if size > MAX_MANIFEST_BYTES.saturating_sub(40) {
                return Err(VaultError::Invalid);
            }

            // 3. Publish the objects, then the one commit.
            let objects = self.root.join("objects");
            for object in &staged {
                publish_object(
                    &stage.join(&object.object_name),
                    &objects.join(&object.object_name),
                )?;
                published.push(object.object_name.clone());
                terminate_at_test_boundary("package-import.after-object-publication");
                fail_at_test_boundary("package-import.after-object-publication")?;
            }
            fail_at_test_boundary("package-import.objects-sync")?;
            sync_dir(&objects)?;
            if cancelled() {
                return Err(VaultError::Cancelled);
            }
            terminate_at_test_boundary("package-import.after-object-rename");
            let mut entry = HistoryEntry::new(HistoryEvent::ProfileImported, now_ms);
            entry.profile_id = Some(summary.profile_id);
            entry.name = next
                .profiles
                .iter()
                .find(|profile| profile.id == summary.profile_id)
                .map(|profile| profile.display_name.clone());
            commit_attempted = true;
            let redundant = commit_with_history(
                &self.root,
                &unlocked.master_key,
                &mut unlocked.manifest,
                next,
                vec![entry],
            )?;
            unlocked.recovery = (!redundant).then_some(RecoveryReason::WriteFailed);
            Ok(summary)
        })();
        if result.is_err() && commit_attempted {
            // The commit's outcome is not known (its first write may have landed): the objects
            // are kept, as a manifest that names them may be the newest, and the session is
            // read-only until the next unlock settles which it is, as for a clinic delivery.
            unlocked.recovery = Some(RecoveryReason::WriteFailed);
        } else if result.is_err() {
            let objects = self.root.join("objects");
            for name in &published {
                let _ = remove_owned_file(objects.join(name), Removable::UncommittedObject);
            }
            sync_parent(&objects);
        }
        let _ = remove_owned_dir_all(&stage, Removable::ImportStaging);
        result.map(ImportResult::Imported)
    }

    /// Reads every object of the package and re-encrypts it into `stage`, in the package's
    /// order, and then has the reader verify the whole. Returns what was staged, each record's
    /// objects as the new vault knows them, how many AI answers were not taken, and the
    /// receipt code.
    #[allow(clippy::too_many_arguments)]
    fn stage_package<R: Read + Seek>(
        &self,
        mut reader: PackageReader<R>,
        package: &PackageManifest,
        plan: &Plan,
        stage: &Path,
        keys: &DerivedKeys,
        vault_id: Uuid,
        now_ms: u64,
    ) -> Result<StagedPackage, VaultError> {
        let still_open = || !self.cancel_io.load(Ordering::Acquire);
        let mut staged = Vec::new();
        let mut records = Vec::new();
        let mut dropped_answers = 0_usize;
        let to = StageTarget {
            stage,
            keys,
            vault_id,
            profile_id: plan.profile_id,
        };
        for (index, record) in package.records.iter().enumerate() {
            let ids = &plan.records[index];
            // The document the patient sees.
            let display = stage_object(&mut reader, &still_open, &to, ids.record_id)?;
            let display_sha256 = display.sha256;
            let mut done = StagedRecord {
                object_name: display.object_name.clone(),
                plaintext_size: display.plaintext_size,
                fingerprint: BASE64.encode(display.fingerprint),
                wrapped_object_key: display.wrapped,
                original_pdf: None,
                ai_results: Vec::new(),
            };
            staged.push(Staged {
                object_name: display.object_name,
            });
            // A signed document's second copy.
            if let Some(original_id) = ids.original_id {
                let original = stage_object(&mut reader, &still_open, &to, original_id)?;
                // The vault copies a document's original from its display, so the two are the
                // same bytes. A package whose are not is a crafted one (a genuine signed original
                // beside a forged document, to be shown as the clinic's): refused whole.
                if original.sha256 != display_sha256 {
                    return Err(VaultError::Invalid);
                }
                done.original_pdf = Some(StoredOriginalPdf {
                    id: original_id,
                    object_name: original.object_name.clone(),
                    plaintext_size: original.plaintext_size,
                    sha256: original.sha256.iter().map(|b| format!("{b:02x}")).collect(),
                    wrapped_object_key: original.wrapped,
                });
                staged.push(Staged {
                    object_name: original.object_name,
                });
            }
            // The AI helper's answers: each read into memory (they are small), judged as the
            // vault judges an answer it is asked to keep, and dropped if it does not pass.
            for (answer_index, answer) in record.ai_answers.iter().enumerate() {
                let answer_id = ids.answer_ids[answer_index];
                let decided = plan.answers[index][answer_index];
                let (true, Some(tool)) = (decided.keep, decided.tool) else {
                    // Not taken: read to its end and thrown away (it is still authenticated
                    // and counted in the package's digests), never staged.
                    skip_object(&mut reader, &still_open)?;
                    dropped_answers += 1;
                    continue;
                };
                let content =
                    read_small_object(&mut reader, &still_open, ai_results::MAX_AI_RESULT_BYTES)?;
                let input = ai_results::AiResultInput {
                    tool,
                    lang: answer.lang.clone(),
                    term: answer.term.clone(),
                    model_name: answer.model_name.clone(),
                    model_sha256: answer.model_sha256.clone(),
                };
                // Judged against the model the answer itself names: whether that model ran
                // on this computer is not something a file can say.
                let acceptable = content.as_ref().is_some_and(|content| {
                    !content.is_empty()
                        && ai_results::valid_fields(
                            input.tool,
                            &input.lang,
                            input.term.as_deref(),
                            &input.model_name,
                            &input.model_sha256,
                        )
                        && ai_results::check_answer(
                            &input,
                            content,
                            Some((&input.model_name, &input.model_sha256)),
                        )
                        .is_ok()
                });
                let Some(content) = content.filter(|_| acceptable) else {
                    dropped_answers += 1;
                    continue;
                };
                let object_name = format!("{}.mcobj", Uuid::new_v4());
                let path = stage.join(&object_name);
                let mut key = Zeroizing::new([0_u8; 32]);
                OsRng.fill_bytes(key.as_mut());
                let encrypted = encrypt_object_from(
                    &mut io::Cursor::new(&content[..]),
                    &path,
                    ObjectContext {
                        vault_id,
                        record_id: answer_id,
                        profile_id: plan.profile_id,
                    },
                    &key,
                    &keys.fingerprint,
                )?;
                done.ai_results.push(StoredAiResult {
                    id: answer_id,
                    tool: input.tool,
                    lang: input.lang,
                    term: input.term,
                    model_name: input.model_name,
                    model_sha256: input.model_sha256,
                    created_at_ms: answer.created_at_ms.min(now_ms),
                    object_name: object_name.clone(),
                    plaintext_size: encrypted.plaintext_size,
                    wrapped_object_key: wrap_secret(&keys.object_wrap, &key, answer_id.as_bytes())?,
                    superseded: decided.superseded,
                    imported: true,
                });
                staged.push(Staged { object_name });
            }
            records.push(done);
        }
        // The whole package, checked: nothing staged counts for anything before this.
        let verified = reader.finish()?;
        Ok(StagedPackage {
            staged,
            records,
            dropped_answers,
            receipt_code: verified.receipt_code().to_owned(),
        })
    }
}

/// What the staging pass produced.
struct StagedPackage {
    staged: Vec<Staged>,
    records: Vec<StagedRecord>,
    dropped_answers: usize,
    receipt_code: String,
}

/// Where and under what a package's objects are staged.
struct StageTarget<'a> {
    stage: &'a Path,
    keys: &'a DerivedKeys,
    vault_id: Uuid,
    profile_id: Uuid,
}

/// One object after it has been re-encrypted into the stage.
struct StagedObject {
    object_name: String,
    plaintext_size: u64,
    fingerprint: [u8; 32],
    sha256: [u8; 32],
    wrapped: WrappedSecret,
}

/// Pulls the next object out of the package and re-encrypts it under this vault's keys as it
/// comes: a new object key, a new nonce prefix, this vault's id and the id `id` it is given
/// here. Nothing readable is kept. A package that fails while it is read is reported as what
/// it was (damaged, cancelled), not as the storage error the encryptor makes of it.
fn stage_object<R: Read>(
    reader: &mut PackageReader<R>,
    still_open: &dyn Fn() -> bool,
    to: &StageTarget<'_>,
    id: Uuid,
) -> Result<StagedObject, VaultError> {
    let object_name = format!("{}.mcobj", Uuid::new_v4());
    let path = to.stage.join(&object_name);
    let mut key = Zeroizing::new([0_u8; 32]);
    OsRng.fill_bytes(key.as_mut());
    let mut stream = reader.object_stream(still_open)?;
    let encrypted = encrypt_object_from(
        &mut stream,
        &path,
        ObjectContext {
            vault_id: to.vault_id,
            record_id: id,
            profile_id: to.profile_id,
        },
        &key,
        &to.keys.fingerprint,
    );
    let outcome = (|| {
        if let Some(failure) = stream.take_failure() {
            return Err(VaultError::from(failure));
        }
        let encrypted = encrypted?;
        let read = stream.finish()?;
        if read.size != encrypted.plaintext_size {
            return Err(VaultError::Invalid);
        }
        Ok(StagedObject {
            plaintext_size: encrypted.plaintext_size,
            fingerprint: encrypted.fingerprint,
            sha256: read.sha256,
            wrapped: wrap_secret(&to.keys.object_wrap, &key, id.as_bytes())?,
            object_name: object_name.clone(),
        })
    })();
    if outcome.is_err() {
        let _ = remove_owned_file(&path, Removable::UncommittedObject);
    }
    outcome
}

/// An object of at most `limit` bytes, read whole; None when it is longer (the rest is read and
/// thrown away, so that the object is consumed to its end and checked like any other).
fn read_small_object<R: Read>(
    reader: &mut PackageReader<R>,
    still_open: &dyn Fn() -> bool,
    limit: u64,
) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
    let mut stream = reader.object_stream(still_open)?;
    let mut content = Zeroizing::new(Vec::new());
    let copied = (&mut stream).take(limit + 1).read_to_end(&mut content);
    if let Some(failure) = stream.take_failure() {
        return Err(VaultError::from(failure));
    }
    copied?;
    let too_long = content.len() as u64 > limit;
    if too_long {
        content.clear();
        io::copy(&mut stream, &mut io::sink())?;
        if let Some(failure) = stream.take_failure() {
            return Err(VaultError::from(failure));
        }
    }
    stream.finish()?;
    Ok((!too_long).then_some(content))
}

/// The next object, read to its end and thrown away: authenticated and counted, never kept.
fn skip_object<R: Read>(
    reader: &mut PackageReader<R>,
    still_open: &dyn Fn() -> bool,
) -> Result<(), VaultError> {
    let mut stream = reader.object_stream(still_open)?;
    let copied = io::copy(&mut stream, &mut io::sink());
    if let Some(failure) = stream.take_failure() {
        return Err(VaultError::from(failure));
    }
    copied?;
    stream.finish()?;
    Ok(())
}

/// What staging one document produced, to become a `StoredRecord`.
struct StagedRecord {
    object_name: String,
    plaintext_size: u64,
    fingerprint: String,
    wrapped_object_key: WrappedSecret,
    original_pdf: Option<StoredOriginalPdf>,
    ai_results: Vec<StoredAiResult>,
}

/// What becomes of one AI answer of the package.
#[derive(Clone, Copy)]
struct AnswerPlan {
    /// Taken: within the caps a document keeps, a tool this vault knows. An answer that is not
    /// is read and thrown away without ever being staged, so that nothing is published that no
    /// manifest names.
    keep: bool,
    superseded: bool,
    tool: Option<ai_results::AiTool>,
}

/// Decides each answer of one record from its metadata alone: the newest answer to a question
/// is the shown one and older answers to it are kept hidden (never deleted: D3); no more than
/// the shown and the hidden caps a document keeps are taken, newest first.
fn plan_answers(answers: &[crate::vault::profile_package::PackageAiAnswer]) -> Vec<AnswerPlan> {
    let mut order: Vec<usize> = (0..answers.len()).collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(answers[i].created_at_ms), i));
    let mut plan = vec![
        AnswerPlan {
            keep: false,
            superseded: false,
            tool: None,
        };
        answers.len()
    ];
    let (mut shown, mut hidden) = (0_usize, 0_usize);
    let mut seen: HashSet<(String, String, Option<String>)> = HashSet::new();
    for i in order {
        let answer = &answers[i];
        let tool = match answer.tool.as_str() {
            "summary" => Some(ai_results::AiTool::Summary),
            "explain" => Some(ai_results::AiTool::Explain),
            _ => None,
        };
        let question = (
            answer.tool.clone(),
            answer.lang.clone(),
            answer.term.clone(),
        );
        let superseded = answer.superseded || seen.contains(&question);
        if !superseded {
            seen.insert(question);
        }
        let keep = tool.is_some()
            && if superseded {
                hidden += 1;
                hidden <= ai_results::MAX_HIDDEN_AI_RESULTS_PER_RECORD
            } else {
                shown += 1;
                shown <= ai_results::MAX_SHOWN_AI_RESULTS_PER_RECORD
            };
        plan[i] = AnswerPlan {
            keep,
            superseded,
            tool,
        };
    }
    plan
}

/// The ids this vault gives a record of the package and what it holds.
struct RecordIds {
    record_id: Uuid,
    original_id: Option<Uuid>,
    answer_ids: Vec<Uuid>,
}

/// Everything about the import that is decided before a byte is written: the new ids, the
/// name, the details, the folders as this vault will have them.
struct Plan {
    /// For each record, what becomes of each of its AI answers (decided from the manifest alone,
    /// before any is staged).
    answers: Vec<Vec<AnswerPlan>>,
    profile_id: Uuid,
    display_name: String,
    details: (Option<String>, Option<String>, Option<Vec<String>>),
    folders: Vec<VaultFolder>,
    folder_map: HashMap<Uuid, Uuid>,
    records: Vec<RecordIds>,
}

/// A name cut to what this vault allows for a folder or a person: its first characters, trimmed.
fn fit(name: &str, limit: usize) -> String {
    name.chars()
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Decides the import from the manifest alone, refusing what this vault cannot hold.
fn plan_import(
    package: &PackageManifest,
    options: &ImportOptions,
    manifest: &Manifest,
    now_ms: u64,
) -> Result<Plan, VaultError> {
    let name = fit(
        options
            .display_name
            .as_deref()
            .unwrap_or(&package.profile.display_name),
        120,
    );
    validate_person_name(&name)?;
    let details = checked_profile_details(
        ProfileDetails {
            full_name: package.profile.full_name.clone(),
            birth_date: package.profile.birth_date.clone(),
            previous_full_names: Some(
                package
                    .profile
                    .previous_full_names
                    .iter()
                    .take(MAX_PREVIOUS_FULL_NAMES)
                    .cloned()
                    .collect(),
            ),
        },
        &utc_date_text(now_ms),
        now_ms,
    )?;
    let profile_id = Uuid::new_v4();
    // Folders: new ids, names within the vault's limit, no deeper than it holds.
    let folder_map: HashMap<Uuid, Uuid> = package
        .folders
        .iter()
        .map(|folder| (folder.id, Uuid::new_v4()))
        .collect();
    let parents: HashMap<Uuid, Option<Uuid>> = package
        .folders
        .iter()
        .map(|folder| (folder.id, folder.parent_id))
        .collect();
    let mut folders = Vec::new();
    for folder in &package.folders {
        let mut depth = 1;
        let mut at = folder.parent_id;
        while let Some(parent) = at {
            depth += 1;
            if depth > MAX_IMPORT_FOLDER_DEPTH {
                return Err(VaultError::Invalid);
            }
            at = *parents.get(&parent).ok_or(VaultError::Invalid)?;
        }
        let folder_name = fit(&folder.name, 120);
        validate_name(&folder_name)?;
        folders.push(VaultFolder {
            id: folder_map[&folder.id],
            profile_id,
            parent_id: folder.parent_id.map(|parent| folder_map[&parent]),
            name: folder_name,
            created_at_ms: folder.created_at_ms.min(now_ms),
            // A folder the patient hid arrives hidden, with its documents and the folders below it
            // (#574): the flag is the patient's own, time capped at now like the folder's, and
            // only ever the patient's reason. The imported PERSON still arrives visible.
            hidden: folder.hidden_at_ms.map(|at_ms| Hidden {
                at_ms: at_ms.min(now_ms),
                reason: HiddenReason::Patient,
            }),
        });
    }
    let records = package
        .records
        .iter()
        .map(|record| RecordIds {
            record_id: Uuid::new_v4(),
            original_id: record.original_pdf.map(|_| Uuid::new_v4()),
            answer_ids: record.ai_answers.iter().map(|_| Uuid::new_v4()).collect(),
        })
        .collect();
    let _ = manifest;
    let answers = package
        .records
        .iter()
        .map(|record| plan_answers(&record.ai_answers))
        .collect();
    Ok(Plan {
        answers,
        profile_id,
        display_name: name,
        details,
        folders,
        folder_map,
        records,
    })
}

/// What an import learned that the new manifest records.
struct Facts {
    /// The file's id, to link the person to it; none for a second copy of a file already taken.
    package_id: Option<Uuid>,
    dropped_answers: usize,
    receipt_code: String,
    now_ms: u64,
}

impl Plan {
    /// The manifest after the import, and what it did.
    fn assemble(
        &self,
        package: &PackageManifest,
        staged: Vec<StagedRecord>,
        current: &Manifest,
        facts: Facts,
    ) -> Result<(Manifest, ProfileImported), VaultError> {
        let Facts {
            package_id,
            dropped_answers,
            receipt_code,
            now_ms,
        } = facts;
        let mut next = current.clone();
        // Deliveries this vault holds, filed or carried: a second record of one is refused, so
        // evidence for one it has is dropped (the document still comes).
        let mut held: HashSet<String> = HashSet::new();
        for record in &current.records {
            if let Some(c) = &record.delivery {
                held.insert(c.outer.delivery_id.clone());
            }
            if let Some(a) = &record.reading_aid {
                held.insert(a.outer.delivery_id.clone());
            }
            if let Some(c) = &record.carried {
                held.insert(c.delivery.outer.delivery_id.clone());
                if let Some(a) = &c.reading_aid {
                    held.insert(a.outer.delivery_id.clone());
                }
            }
        }
        let mut summary = ProfileImported {
            profile_id: self.profile_id,
            documents: 0,
            folders: self.folders.len(),
            hidden: 0,
            ai_answers: 0,
            ai_answers_dropped: dropped_answers,
            evidence_kept: 0,
            evidence_dropped: 0,
            history_entries: 0,
            receipt_code,
        };
        let mut new_records = Vec::new();
        for ((source, ids), done) in package.records.iter().zip(&self.records).zip(staged) {
            let carried = self.carried_for(source, ids, &done, &mut held, &mut summary);
            // The caps and the one shown answer per question were decided before staging.
            let ai_results = done.ai_results;
            summary.ai_answers += ai_results.len();
            summary.documents += 1;
            let hidden = source.hidden_at_ms.map(|at_ms| Hidden {
                at_ms: at_ms.min(now_ms),
                reason: HiddenReason::Patient,
            });
            summary.hidden += usize::from(hidden.is_some());
            new_records.push(StoredRecord {
                id: ids.record_id,
                profile_id: self.profile_id,
                folder_ids: unique(
                    source
                        .folder_ids
                        .iter()
                        .filter_map(|id| self.folder_map.get(id).copied())
                        .collect(),
                ),
                display_name: sanitize_basename(&source.name),
                // Fixed by this vault: a package does not get to say where a document came
                // from, what kind it is, or label it as verified.
                source_label: MANUAL_IMPORT_LABEL.to_owned(),
                media_type: "application/octet-stream".to_owned(),
                plaintext_size: done.plaintext_size,
                imported_at_ms: source.imported_at_ms.min(now_ms),
                object_name: done.object_name,
                fingerprint: done.fingerprint,
                wrapped_object_key: done.wrapped_object_key,
                hidden,
                original_pdf: done.original_pdf,
                delivery: None,
                reading_aid: None,
                ai_results,
                carried,
            });
        }
        let excerpt = self
            .excerpt(package, now_ms)
            .filter(|_| package_id.is_some());
        summary.history_entries = excerpt.as_ref().map_or(0, Vec::len);
        let (full_name, birth_date, previous_full_names) = self.details.clone();
        next.profiles.push(PatientProfile {
            id: self.profile_id,
            display_name: self.display_name.clone(),
            created_at_ms: now_ms,
            full_name,
            birth_date,
            previous_full_names: previous_full_names.filter(|names| !names.is_empty()),
            hidden: None,
            // One handover file makes one profile: a second copy of the same file, taken on
            // purpose, is a person with no link to it.
            imported_from: package_id.map(|package_id| ImportedFrom {
                package_id,
                at_ms: now_ms,
            }),
            imported_history: excerpt,
        });
        next.folders.extend(self.folders.iter().cloned());
        next.records.extend(new_records);
        Ok((next, summary))
    }

    /// The clinic evidence a record keeps: only what parses, stands up without a link and is
    /// about a delivery this vault does not already hold.
    fn carried_for(
        &self,
        source: &PackageRecord,
        ids: &RecordIds,
        done: &StagedRecord,
        held: &mut HashSet<String>,
        summary: &mut ProfileImported,
    ) -> Option<crate::portal_delivery::Carried> {
        let value = source.carried.as_ref()?;
        let kept = (|| {
            let carried: crate::portal_delivery::Carried =
                serde_json::from_value(value.clone()).ok()?;
            // Judged as the vault will judge it on every read, on a record shaped as this one will be.
            let mut probe = probe_record(ids, done);
            probe.carried = Some(carried.clone());
            if !carried::valid_carried(&probe) {
                return None;
            }
            let delivery = carried.delivery.outer.delivery_id.clone();
            let aid = carried
                .reading_aid
                .as_ref()
                .map(|a| a.outer.delivery_id.clone());
            if held.contains(&delivery) || aid.as_ref().is_some_and(|aid| held.contains(aid)) {
                return None;
            }
            held.insert(delivery);
            held.extend(aid);
            Some(carried)
        })();
        if kept.is_some() {
            summary.evidence_kept += 1;
        } else {
            summary.evidence_dropped += 1;
        }
        kept
    }

    /// The old history, on this vault's record ids: only entries about a document that came
    /// (the package names it by the package's own id, which maps to the one made here), at
    /// most `MAX_IMPORTED_HISTORY`, each one this vault's own rules accept. An entry that names
    /// no document of the package is dropped, never kept pointing at nothing.
    fn excerpt(&self, package: &PackageManifest, now_ms: u64) -> Option<Vec<ImportedHistoryEntry>> {
        let history = package.history.as_ref()?;
        let mapped: HashMap<Uuid, Uuid> = package
            .records
            .iter()
            .zip(&self.records)
            .map(|(source, ids)| (source.id, ids.record_id))
            .collect();
        let mut kept: Vec<ImportedHistoryEntry> = history
            .iter()
            .take(MAX_HISTORY_ENTRIES)
            .filter_map(|value| serde_json::from_value::<ImportedHistoryEntry>(value.clone()).ok())
            .filter_map(|mut entry| {
                // Only entries about a document that came: one about no document says nothing
                // of this person's, and one naming a document that is not here points at nothing.
                entry.record_id = Some(*mapped.get(&entry.record_id?)?);
                entry.at_ms = entry.at_ms.min(now_ms);
                entry.valid().then_some(entry)
            })
            .collect();
        if kept.len() > MAX_IMPORTED_HISTORY {
            kept.drain(..kept.len() - MAX_IMPORTED_HISTORY);
        }
        (!kept.is_empty()).then_some(kept)
    }
}

/// The manifest an import would make from the plan, with stand-ins for what staging produces
/// (an object name, a key, a fingerprint, a hash), validated. Nothing is written.
fn trial_manifest(
    plan: &Plan,
    package: &PackageManifest,
    current: &Manifest,
    keys: &DerivedKeys,
    now_ms: u64,
) -> Result<(), VaultError> {
    let wrapped = || wrap_secret(&keys.object_wrap, &[0_u8; 32], b"trial");
    let mut staged = Vec::new();
    for (index, (source, ids)) in package.records.iter().zip(&plan.records).enumerate() {
        let mut record = StagedRecord {
            object_name: format!("{}.mcobj", Uuid::new_v4()),
            plaintext_size: 1,
            fingerprint: BASE64.encode([0_u8; 32]),
            wrapped_object_key: wrapped()?,
            original_pdf: None,
            ai_results: Vec::new(),
        };
        if let Some(original_id) = ids.original_id {
            record.original_pdf = Some(StoredOriginalPdf {
                id: original_id,
                object_name: format!("{}.mcobj", Uuid::new_v4()),
                plaintext_size: 1,
                sha256: "0".repeat(64),
                wrapped_object_key: wrapped()?,
            });
        }
        for answer_index in 0..source.ai_answers.len() {
            let decided = plan.answers[index][answer_index];
            let (true, Some(tool)) = (decided.keep, decided.tool) else {
                continue;
            };
            let answer = &source.ai_answers[answer_index];
            // As staging will judge them: an answer whose own fields are not a valid answer's
            // is dropped there, so it is no part of the manifest the import will make.
            if !ai_results::valid_fields(
                tool,
                &answer.lang,
                answer.term.as_deref(),
                &answer.model_name,
                &answer.model_sha256,
            ) {
                continue;
            }
            record.ai_results.push(StoredAiResult {
                id: ids.answer_ids[answer_index],
                tool,
                lang: answer.lang.clone(),
                term: answer.term.clone(),
                model_name: answer.model_name.clone(),
                model_sha256: answer.model_sha256.clone(),
                created_at_ms: answer.created_at_ms.min(now_ms),
                object_name: format!("{}.mcobj", Uuid::new_v4()),
                plaintext_size: 1,
                wrapped_object_key: wrapped()?,
                superseded: decided.superseded,
                imported: true,
            });
        }
        staged.push(record);
    }
    let (next, _) = plan.assemble(
        package,
        staged,
        current,
        Facts {
            package_id: Some(Uuid::new_v4()),
            dropped_answers: 0,
            receipt_code: String::new(),
            now_ms,
        },
    )?;
    validate_manifest_structure(&next, current.vault_id).map_err(|_| VaultError::Invalid)?;
    if serde_json::to_vec(&next)
        .map_err(|_| VaultError::Storage)?
        .len()
        > MAX_MANIFEST_BYTES.saturating_sub(40)
    {
        return Err(VaultError::Invalid);
    }
    Ok(())
}

/// A record as an import will make it, for judging evidence before the manifest is assembled.
fn probe_record(ids: &RecordIds, done: &StagedRecord) -> StoredRecord {
    StoredRecord {
        id: ids.record_id,
        profile_id: Uuid::nil(),
        folder_ids: Vec::new(),
        display_name: String::new(),
        source_label: MANUAL_IMPORT_LABEL.to_owned(),
        media_type: "application/octet-stream".to_owned(),
        plaintext_size: done.plaintext_size,
        imported_at_ms: 0,
        object_name: done.object_name.clone(),
        fingerprint: done.fingerprint.clone(),
        wrapped_object_key: done.wrapped_object_key.clone(),
        hidden: None,
        original_pdf: done.original_pdf.clone(),
        delivery: None,
        reading_aid: None,
        ai_results: Vec::new(),
        carried: None,
    }
}

fn preview_of(
    package: &PackageManifest,
    package_id: Uuid,
    already_here: Option<AlreadyHere>,
) -> ImportPreview {
    ImportPreview {
        package_id,
        exported_at_ms: package.exported_at_ms,
        display_name: package.profile.display_name.clone(),
        full_name: package.profile.full_name.clone(),
        birth_date: package.profile.birth_date.clone(),
        previous_full_names: package
            .profile
            .previous_full_names
            .iter()
            .take(MAX_PREVIOUS_FULL_NAMES)
            .cloned()
            .collect(),
        documents: package.records.len(),
        hidden: package
            .records
            .iter()
            .filter(|record| record.hidden_at_ms.is_some())
            .count(),
        folders: package.folders.len(),
        ai_answers: package
            .records
            .iter()
            .map(|record| record.ai_answers.len())
            .sum(),
        with_clinic_evidence: package
            .records
            .iter()
            .filter(|record| record.carried.is_some())
            .count(),
        history_entries: package.history.as_ref().map_or(0, Vec::len),
        plaintext_bytes: package.total_plaintext_bytes(),
        already_here,
    }
}

/// A person this vault holds that the package is, by its id or by the documents it holds.
fn already_here<R: Read>(manifest: &Manifest, reader: &PackageReader<R>) -> Option<AlreadyHere> {
    let package_id = reader.package_id();
    if let Some(profile) = manifest.profiles.iter().find(|profile| {
        profile
            .imported_from
            .as_ref()
            .is_some_and(|from| from.package_id == package_id)
    }) {
        return Some(AlreadyHere {
            profile_id: profile.id,
            by: DuplicateBy::Package,
            matching_documents: 0,
        });
    }
    // By content: the original PDFs' SHA-256, which the package's digests give before any
    // document is read. A name, a label or a date is not an identity; the bytes are.
    let digests = reader.tail_digests()?;
    let package = reader.manifest();
    let sha_of = |id: Uuid| {
        digests.iter().find(|read| read.id == id).map(|read| {
            read.sha256
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        })
    };
    let theirs: HashSet<String> = package
        .records
        .iter()
        .filter_map(|record| record.original_pdf.and_then(|object| sha_of(object.id)))
        .collect();
    if theirs.is_empty() {
        return None;
    }
    let mut by_profile: HashMap<Uuid, usize> = HashMap::new();
    for record in &manifest.records {
        if record
            .original_pdf
            .as_ref()
            .is_some_and(|original| theirs.contains(&original.sha256))
        {
            *by_profile.entry(record.profile_id).or_default() += 1;
        }
    }
    by_profile.into_iter().max_by_key(|(_, count)| *count).map(
        |(profile_id, matching_documents)| AlreadyHere {
            profile_id,
            by: DuplicateBy::Content,
            matching_documents,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::profile_export::{ExportOptions, ExportReport};
    use crate::vault::profile_package::{
        generate_package_key, PackageAiAnswer, PackageFolder, PackageObject, PackageProfile,
        PackageWriter,
    };
    use std::io::Cursor;

    const PASSWORD: &str = "correct horse battery staple 9173";
    const TARGET_PASSWORD: &str = "cobalt-meadow-lantern-prism-8264-vexed";
    const CHILD_MARKER: &[u8] = b"FAKE-CHILD-DOCUMENT-BYTES";
    const PARENT_MARKER: &[u8] = b"FAKE-PARENT-ONLY-BYTES-31";

    fn source(name: &str, data: &[u8]) -> ImportSource {
        ImportSource {
            display_name: name.to_owned(),
            reader: Box::new(Cursor::new(data.to_vec())),
        }
    }

    fn pdf(marker: &[u8], extra: usize) -> Vec<u8> {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend_from_slice(marker);
        bytes.extend((0..extra).map(|i| (i * 13 % 251) as u8));
        bytes
    }

    struct Source {
        _temp: tempfile::TempDir,
        store: VaultStore,
        child: Uuid,
        records: Vec<Uuid>,
    }

    /// A vault with FAKE Child (folders, two PDFs, a plain file, one hidden, an AI answer)
    /// and FAKE Parent.
    fn source_vault() -> Source {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(PASSWORD, "FAKE Parent", 1).unwrap();
        let parent = store.snapshot().unwrap().profiles[0].id;
        store
            .import(
                parent,
                vec![],
                vec![source("FAKE Parent.pdf", &pdf(PARENT_MARKER, 500))],
                2,
            )
            .unwrap();
        let child = store.create_profile("FAKE Child", 3).unwrap();
        let outer = store.create_folder(child, None, "FAKE Letters", 4).unwrap();
        let inner = store
            .create_folder(child, Some(outer), "FAKE Results", 5)
            .unwrap();
        let mut records = Vec::new();
        for (name, folders, data) in [
            ("FAKE Child A.pdf", vec![outer], pdf(CHILD_MARKER, 2_000)),
            (
                "FAKE Child B.pdf",
                vec![inner],
                pdf(b"FAKE-SECOND", CHUNK_SIZE + 7),
            ),
            ("FAKE Child C.txt", vec![], b"FAKE plain text".to_vec()),
        ] {
            let outcome = store
                .import(child, folders, vec![source(name, &data)], 6)
                .unwrap();
            records.push(outcome.imported[0]);
        }
        store.hide_record(records[2], 7).unwrap();
        store
            .save_ai_result(
                records[0],
                crate::vault::ai_results::AiResultInput {
                    tool: crate::vault::ai_results::AiTool::Summary,
                    lang: "en".into(),
                    term: None,
                    model_name: "FAKE model".into(),
                    model_sha256: "00".repeat(32),
                },
                &summary_bytes("en", "FAKE model", &"00".repeat(32)),
                8,
            )
            .unwrap();
        Source {
            _temp: temp,
            store,
            child,
            records,
        }
    }

    /// A kept summary as the reader writes it, for the fake model.
    fn summary_bytes(lang: &str, model: &str, sha: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "tool": "summary",
            "sentences": [{"text": "FAKE sentence.", "quote": "FAKE quote", "source": null}],
            "model": {"name": model, "sha256": sha},
            "lang": lang,
            "createdAt": 1,
            "partial": false,
            "lastPage": 1,
            "pagesMissing": false,
        }))
        .unwrap()
    }

    fn export_bytes(source: &Source, key: &[u8; 16]) -> (Vec<u8>, ExportReport) {
        let written = source
            .store
            .export_profile(
                source.child,
                ExportOptions {
                    include_history: true,
                },
                PackageSecret::Key(key),
                Vec::new(),
                100,
            )
            .unwrap();
        (written.sink, written.report)
    }

    fn target_vault() -> (tempfile::TempDir, VaultStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store.create(TARGET_PASSWORD, "FAKE Target", 1).unwrap();
        (temp, store)
    }

    fn options() -> ImportOptions {
        ImportOptions {
            display_name: None,
            allow_duplicate: false,
        }
    }

    fn take(
        store: &VaultStore,
        bytes: &[u8],
        key: &[u8; 16],
        options: &ImportOptions,
    ) -> Result<ImportResult, VaultError> {
        store.import_profile_package(
            Cursor::new(bytes.to_vec()),
            PackageSecret::Key(key),
            options,
            200,
        )
    }

    fn imported(result: Result<ImportResult, VaultError>) -> ProfileImported {
        match result.unwrap() {
            ImportResult::Imported(done) => done,
            other => panic!("not imported: {other:?}"),
        }
    }

    fn object_files(store: &VaultStore) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(store.root.join("objects"))
            .map(|entries| {
                entries
                    .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Object files in `objects/` that no part of the manifest names: what a killed process
    /// leaves, until the next unlock puts it aside.
    fn unreferenced_objects(store: &VaultStore) -> Vec<String> {
        let guard = store.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let mut named: HashSet<String> = manifest
            .records
            .iter()
            .flat_map(|record| {
                record
                    .objects()
                    .map(|o| o.object_name.to_owned())
                    .collect::<Vec<_>>()
            })
            .collect();
        named.extend(
            manifest
                .history
                .segments
                .iter()
                .map(|s| s.object_name.clone()),
        );
        object_files(store)
            .into_iter()
            .filter(|name| !named.contains(name))
            .collect()
    }

    fn staging_is_empty(store: &VaultStore) -> bool {
        fs::read_dir(store.root.join("staging"))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }

    fn generation(store: &VaultStore) -> u64 {
        store.session().as_ref().unwrap().manifest.generation
    }

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

    #[test]
    fn a_person_arrives_whole_under_this_vaults_own_keys_and_ids() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, exported) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let before = target.history_entries().unwrap().len();
        let done = imported(take(&target, &bytes, &key, &options()));
        assert_eq!(done.documents, 3);
        assert_eq!(done.folders, 2);
        assert_eq!(done.hidden, 1);
        assert_eq!(done.ai_answers, 1);
        assert_eq!(done.evidence_kept + done.evidence_dropped, 0);
        assert_eq!(done.documents, exported.documents);

        let snapshot = target.snapshot().unwrap();
        let profile = snapshot
            .profiles
            .iter()
            .find(|p| p.id == done.profile_id)
            .unwrap();
        assert_eq!(profile.display_name, "FAKE Child");
        assert_eq!(
            snapshot
                .folders
                .iter()
                .filter(|f| f.profile_id == done.profile_id)
                .count(),
            2
        );
        let mine: Vec<_> = snapshot
            .records
            .iter()
            .filter(|r| r.profile_id == done.profile_id)
            .collect();
        assert_eq!(mine.len(), 3);
        assert_eq!(mine.iter().filter(|r| r.hidden.is_some()).count(), 1);
        // Every document is the source's bytes, readable here; the parent's are not here.
        let mut contents = Vec::new();
        for record in &mine {
            let mut out = Vec::new();
            target.export(record.id, &mut out).unwrap();
            contents.push(out);
        }
        let mut wanted = Vec::new();
        for id in &source.records {
            let mut out = Vec::new();
            source.store.export(*id, &mut out).unwrap();
            wanted.push(out);
        }
        assert_eq!(contents, wanted);
        assert!(contents
            .iter()
            .all(|c| !c.windows(PARENT_MARKER.len()).any(|w| w == PARENT_MARKER)));
        // Ids are this vault's: none of the source's.
        for id in &source.records {
            assert!(mine.iter().all(|r| r.id != *id));
        }
        // The vault's own labels, never the package's; nothing verified without a link.
        assert!(mine.iter().all(|r| r.source_label == MANUAL_IMPORT_LABEL));
        assert!(mine.iter().all(|r| r.verified_clinic_name.is_none()));
        // The AI answer came with its document.
        let answers: usize = mine
            .iter()
            .map(|r| target.ai_results(r.id).unwrap().len())
            .sum();
        assert_eq!(answers, 1);
        // The old history is on the profile, on this vault's record ids, and says so.
        let guard = target.session();
        let kept = guard
            .as_ref()
            .unwrap()
            .manifest
            .profiles
            .iter()
            .find(|p| p.id == done.profile_id)
            .unwrap()
            .clone();
        drop(guard);
        let history = kept.imported_history.unwrap();
        assert_eq!(history.len(), done.history_entries);
        assert!(history
            .iter()
            .all(|e| e.record_id.is_none_or(|id| mine.iter().any(|r| r.id == id))));
        assert!(kept.imported_from.is_some());
        // One entry in this vault's history, for the person; no document is named.
        let entries = target.history_entries().unwrap();
        assert_eq!(entries.len(), before + 1);
        let entry = entries.last().unwrap();
        assert_eq!(entry.event, HistoryEvent::ProfileImported);
        assert_eq!(entry.profile_id, Some(done.profile_id));
        assert!(entry.record_id.is_none());
        // And it survives a restart.
        target.lock();
        target.unlock(TARGET_PASSWORD).unwrap();
        assert_eq!(target.snapshot().unwrap().records.len(), 3);
    }

    #[test]
    fn the_receipt_code_is_the_one_the_source_recomputes_from_the_file_and_key() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let done = imported(take(&target, &bytes, &key, &options()));
        let mut reader =
            PackageReader::open(Cursor::new(&bytes), PackageSecret::Key(&key)).unwrap();
        reader.verify_tail().unwrap();
        assert_eq!(reader.receipt_code().unwrap(), done.receipt_code);
    }

    #[test]
    fn inspecting_says_what_is_in_it_and_whether_this_vault_has_it_and_writes_nothing() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let generation_before = generation(&target);
        let files_before = object_files(&target);
        let preview = target
            .inspect_profile_package(Cursor::new(&bytes), PackageSecret::Key(&key))
            .unwrap();
        assert_eq!(preview.display_name, "FAKE Child");
        assert_eq!(
            (preview.documents, preview.hidden, preview.folders),
            (3, 1, 2)
        );
        assert!(preview.already_here.is_none());
        assert_eq!(generation(&target), generation_before);
        assert_eq!(object_files(&target), files_before);
        // After taking it, the same file is recognised by its id.
        let done = imported(take(&target, &bytes, &key, &options()));
        let again = target
            .inspect_profile_package(Cursor::new(&bytes), PackageSecret::Key(&key))
            .unwrap();
        assert_eq!(
            again.already_here,
            Some(AlreadyHere {
                profile_id: done.profile_id,
                by: DuplicateBy::Package,
                matching_documents: 0
            })
        );
    }

    #[test]
    fn the_same_file_is_not_taken_twice_unless_asked_and_another_file_of_the_same_documents_is_found_by_content(
    ) {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let first = imported(take(&target, &bytes, &key, &options()));
        let generation_after_first = generation(&target);
        // The same file again: nothing is written, and the person is named.
        let result = take(&target, &bytes, &key, &options()).unwrap();
        assert_eq!(
            result,
            ImportResult::AlreadyHere(AlreadyHere {
                profile_id: first.profile_id,
                by: DuplicateBy::Package,
                matching_documents: 0
            })
        );
        assert_eq!(generation(&target), generation_after_first);
        // A second export of the same person is another file with another id, and is found
        // by its documents' bytes, whatever it is called.
        let (second, _) = export_bytes(&source, &key);
        let result = take(&target, &second, &key, &options()).unwrap();
        match result {
            ImportResult::AlreadyHere(found) => {
                assert_eq!(found.profile_id, first.profile_id);
                assert_eq!(found.by, DuplicateBy::Content);
                assert_eq!(found.matching_documents, 2);
            }
            other => panic!("{other:?}"),
        }
        // Asked to, the same file makes a second person with no link to the file.
        let again = imported(take(
            &target,
            &bytes,
            &key,
            &ImportOptions {
                display_name: Some("FAKE Child Again".into()),
                allow_duplicate: true,
            },
        ));
        let guard = target.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let copy = manifest
            .profiles
            .iter()
            .find(|p| p.id == again.profile_id)
            .unwrap();
        assert!(copy.imported_from.is_none() && copy.imported_history.is_none());
        assert_eq!(
            manifest
                .profiles
                .iter()
                .filter(|p| p.imported_from.is_some())
                .count(),
            1
        );
    }

    #[test]
    fn a_failure_cut_or_changed_byte_leaves_the_vault_exactly_as_it_was() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let generation_before = generation(&target);
        let history_before = target.history_entries().unwrap().len();
        let files_before = object_files(&target);
        let nothing_changed = |store: &VaultStore| {
            assert_eq!(generation(store), generation_before);
            assert_eq!(store.history_entries().unwrap().len(), history_before);
            assert_eq!(object_files(store), files_before);
            assert!(staging_is_empty(store));
            assert_eq!(store.snapshot().unwrap().profiles.len(), 1);
        };
        // Cut at sampled places, flipped bytes, bytes added.
        for cut in [
            30,
            200,
            bytes.len() / 3,
            bytes.len() / 2,
            bytes.len() - 40,
            bytes.len() - 1,
        ] {
            assert!(
                take(&target, &bytes[..cut], &key, &options()).is_err(),
                "cut {cut}"
            );
            nothing_changed(&target);
        }
        for at in (40..bytes.len()).step_by(bytes.len() / 29 + 1) {
            let mut flipped = bytes.clone();
            flipped[at] ^= 1;
            assert!(
                take(&target, &flipped, &key, &options()).is_err(),
                "flip {at}"
            );
            nothing_changed(&target);
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(take(&target, &longer, &key, &options()).is_err());
        nothing_changed(&target);
        // A wrong key, and a key typed as a passphrase.
        let (other, _) = generate_package_key();
        assert!(matches!(
            take(&target, &bytes, &other, &options()),
            Err(VaultError::WrongPassphrase)
        ));
        nothing_changed(&target);
        // At each of the import's own boundaries.
        for boundary in [
            "package-import.after-staging",
            "package-import.after-object-publication",
            "package-import.objects-sync",
        ] {
            let _fail = FailsAt::new(boundary);
            assert!(
                take(&target, &bytes, &key, &options()).is_err(),
                "{boundary}"
            );
            drop(_fail);
            nothing_changed(&target);
        }
        // And then it works.
        imported(take(&target, &bytes, &key, &options()));
        assert_eq!(target.snapshot().unwrap().profiles.len(), 2);
    }

    #[test]
    fn a_cancel_or_lock_between_chunks_leaves_nothing() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let generation_before = generation(&target);
        let files_before = object_files(&target);
        // A reader that sets the cancel flag part way through, as a lock does.
        struct Cancelling<'a> {
            inner: Cursor<Vec<u8>>,
            store: &'a VaultStore,
            after: usize,
        }
        impl Read for Cancelling<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                let read = self.inner.read(out)?;
                if self.inner.position() as usize > self.after {
                    self.store.cancel_io.store(true, Ordering::Release);
                }
                Ok(read)
            }
        }
        impl Seek for Cancelling<'_> {
            fn seek(&mut self, to: io::SeekFrom) -> io::Result<u64> {
                self.inner.seek(to)
            }
        }
        let result = target.import_profile_package(
            Cancelling {
                inner: Cursor::new(bytes.clone()),
                store: &target,
                after: bytes.len() / 2,
            },
            PackageSecret::Key(&key),
            &options(),
            200,
        );
        assert!(matches!(result, Err(VaultError::Cancelled)), "{result:?}");
        target.cancel_io.store(false, Ordering::Release);
        assert_eq!(generation(&target), generation_before);
        assert_eq!(object_files(&target), files_before);
        assert!(staging_is_empty(&target));
    }

    /// A package made by hand, as a key holder with bad intentions could: the writer's own
    /// rules still apply to it, and the importer's are tested on top of them.
    fn crafted(manifest: PackageManifest, objects: &[Vec<u8>], key: &[u8; 16]) -> Vec<u8> {
        let mut writer = PackageWriter::create(Vec::new(), PackageSecret::Key(key), &[]).unwrap();
        writer.write_manifest(&manifest).unwrap();
        let mut at = 0;
        while let Some(next) = writer.next_object() {
            let mut source = Cursor::new(objects[at].clone());
            writer.write_object(next.id, &mut source, &|| true).unwrap();
            at += 1;
        }
        writer.finish().unwrap()
    }

    fn hand_made(records: Vec<PackageRecord>, folders: Vec<PackageFolder>) -> PackageManifest {
        PackageManifest {
            format: crate::vault::profile_package::PACKAGE_FORMAT,
            exported_at_ms: 5,
            profile: PackageProfile {
                display_name: "FAKE Crafted".to_owned(),
                full_name: None,
                birth_date: None,
                previous_full_names: Vec::new(),
                created_at_ms: 1,
            },
            folders,
            records,
            history: None,
        }
    }

    fn plain(name: &str, size: usize) -> PackageRecord {
        PackageRecord {
            id: Uuid::new_v4(),
            name: name.to_owned(),
            source_label: "Verified by the clinic".to_owned(),
            media_type: "application/pdf".to_owned(),
            imported_at_ms: u64::MAX / 2,
            folder_ids: Vec::new(),
            hidden_at_ms: None,
            display: PackageObject {
                id: Uuid::new_v4(),
                size: size as u64,
            },
            original_pdf: None,
            ai_answers: Vec::new(),
            carried: None,
        }
    }

    #[test]
    fn what_a_package_claims_about_itself_is_not_taken_at_its_word() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        // Labels, kinds and times are the vault's to say; names are cut to its limits.
        let mut record = plain("FAKE Letter.pdf", 10);
        record.carried = Some(serde_json::json!({"not": "evidence"}));
        let manifest = hand_made(
            vec![record],
            vec![PackageFolder {
                id: Uuid::new_v4(),
                parent_id: None,
                name: "F".repeat(200),
                created_at_ms: u64::MAX / 2,
                hidden_at_ms: None,
            }],
        );
        let bytes = crafted(manifest, &[vec![7_u8; 10]], &key);
        let done = imported(take(&target, &bytes, &key, &options()));
        assert_eq!((done.evidence_kept, done.evidence_dropped), (0, 1));
        let guard = target.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let record = manifest
            .records
            .iter()
            .find(|r| r.profile_id == done.profile_id)
            .unwrap();
        assert_eq!(record.source_label, MANUAL_IMPORT_LABEL);
        assert_eq!(record.media_type, "application/octet-stream");
        assert_eq!(record.imported_at_ms, 200);
        assert!(record.carried.is_none() && record.delivery.is_none());
        let folder = manifest
            .folders
            .iter()
            .find(|f| f.profile_id == done.profile_id)
            .unwrap();
        assert_eq!(folder.name.chars().count(), 120);
        assert_eq!(folder.created_at_ms, 200);
    }

    #[test]
    fn folders_deeper_than_a_vault_holds_are_refused_before_anything_is_written() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        let mut folders = Vec::new();
        let mut parent = None;
        for level in 0..40 {
            let id = Uuid::new_v4();
            folders.push(PackageFolder {
                id,
                parent_id: parent,
                name: format!("FAKE Level {level}"),
                created_at_ms: 1,
                hidden_at_ms: None,
            });
            parent = Some(id);
        }
        let bytes = crafted(
            hand_made(vec![plain("FAKE A.pdf", 3)], folders),
            &[vec![1, 2, 3]],
            &key,
        );
        let generation_before = generation(&target);
        let files_before = object_files(&target);
        assert!(matches!(
            take(&target, &bytes, &key, &options()),
            Err(VaultError::Invalid)
        ));
        assert_eq!(generation(&target), generation_before);
        assert_eq!(object_files(&target), files_before);
        assert!(staging_is_empty(&target));
    }

    #[test]
    fn an_ai_answer_that_is_not_one_is_dropped_and_the_document_still_comes() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        let mut record = plain("FAKE Letter.pdf", 4);
        let good = summary_bytes("en", "FAKE model", &"00".repeat(32));
        let oversized = vec![b'x'; crate::vault::ai_results::MAX_AI_RESULT_BYTES as usize + 10];
        // (tool, language, content): one that is an answer, and five that are not.
        let answers: Vec<(&str, &str, Vec<u8>)> = vec![
            ("summary", "en", good.clone()),
            ("summary", "fr", b"{not json".to_vec()),
            ("unknown-tool", "en", b"abc".to_vec()),
            // Names a model other than the one it says answered.
            (
                "summary",
                "en",
                summary_bytes("en", "Another model", &"11".repeat(32)),
            ),
            ("summary", "xx-not-a-language-at-all", good.clone()),
            ("summary", "en", oversized),
        ];
        record.ai_answers = answers
            .iter()
            .map(|(tool, lang, content)| PackageAiAnswer {
                object: PackageObject {
                    id: Uuid::new_v4(),
                    size: content.len() as u64,
                },
                tool: (*tool).to_owned(),
                lang: (*lang).to_owned(),
                term: None,
                model_name: "FAKE model".to_owned(),
                model_sha256: "00".repeat(32),
                created_at_ms: 9,
                superseded: false,
            })
            .collect();
        let mut contents = vec![vec![9_u8, 9, 9, 9]];
        contents.extend(answers.into_iter().map(|(_, _, content)| content));
        let bytes = crafted(hand_made(vec![record], Vec::new()), &contents, &key);
        let done = imported(take(&target, &bytes, &key, &options()));
        assert_eq!(done.documents, 1);
        assert_eq!(done.ai_answers, 1);
        assert_eq!(done.ai_answers_dropped, 5);
    }

    #[test]
    fn clinic_evidence_stands_up_without_a_link_is_never_verified_and_is_dropped_for_a_delivery_already_held(
    ) {
        let (_temp, delivered, link, record_id) =
            crate::vault::delivery::pair_original_fixture_for_test();
        // The delivery sits in Shared with me; the patient moves it to a person to export.
        let person = {
            let guard = delivered.session();
            let manifest = &guard.as_ref().unwrap().manifest;
            let shared = shared_profile_id(manifest.vault_id);
            manifest
                .profiles
                .iter()
                .map(|p| p.id)
                .find(|id| *id != shared)
                .unwrap()
        };
        delivered
            .mutate_recorded(|m, _| {
                let record = m.records.iter_mut().find(|r| r.id == record_id).unwrap();
                record.profile_id = person;
                record.folder_ids.clear();
                Ok(())
            })
            .unwrap();
        let (key, _) = generate_package_key();
        let bytes = delivered
            .export_profile(
                person,
                ExportOptions {
                    include_history: true,
                },
                PackageSecret::Key(&key),
                Vec::new(),
                1,
            )
            .unwrap()
            .sink;
        let (_t, target) = target_vault();
        let done = imported(take(&target, &bytes, &key, &options()));
        assert_eq!((done.evidence_kept, done.evidence_dropped), (1, 0));
        let snapshot = target.snapshot().unwrap();
        let record = snapshot
            .records
            .iter()
            .find(|r| r.profile_id == done.profile_id)
            .unwrap();
        // Carried, and shown as nothing a clinic vouches for: no link here.
        assert!(record.verified_clinic_name.is_none());
        assert!(record.clinic_service_date.is_none() && record.reading_aid.is_none());
        // Only a link of this vault to that clinic, holding the signing key, changes that.
        target
            .mutate_recorded(|m, _| {
                m.portal_links.push(link.clone());
                Ok(())
            })
            .unwrap();
        let snapshot = target.snapshot().unwrap();
        let record = snapshot
            .records
            .iter()
            .find(|r| r.profile_id == done.profile_id)
            .unwrap();
        assert!(record.verified_clinic_name.is_some());
        // The same delivery again, asked for: the document comes, the evidence does not.
        let again = imported(take(
            &target,
            &bytes,
            &key,
            &ImportOptions {
                display_name: Some("FAKE Second Copy".into()),
                allow_duplicate: true,
            },
        ));
        assert_eq!((again.evidence_kept, again.evidence_dropped), (0, 1));
        assert_eq!(again.documents, 1);
    }

    #[test]
    fn a_vault_in_recovery_mode_or_locked_takes_nothing() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let files_before = object_files(&target);
        target.lock();
        assert!(matches!(
            take(&target, &bytes, &key, &options()),
            Err(VaultError::Locked)
        ));
        assert_eq!(object_files(&target), files_before);
    }

    // --- A process killed part way (the recovery matrix's abrupt-termination harness) --------

    fn run_import_child(root: &Path, package: &Path, key_text: &str, boundary: &str) {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "vault::profile_import::tests::import_termination_child",
            ])
            .env("MYCARLOS_TEST_ROOT", root)
            .env("MYCARLOS_TEST_PACKAGE", package)
            .env("MYCARLOS_TEST_KEY", key_text)
            .env("MYCARLOS_TEST_TERMINATE_AT", boundary)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(
            status.code(),
            Some(TEST_TERMINATION_EXIT_CODE),
            "{boundary}"
        );
    }

    #[test]
    #[ignore = "invoked as an abrupt-termination subprocess by the import matrix"]
    fn import_termination_child() {
        let Ok(root) = std::env::var("MYCARLOS_TEST_ROOT") else {
            return;
        };
        let package = std::env::var("MYCARLOS_TEST_PACKAGE").unwrap();
        let key_text = std::env::var("MYCARLOS_TEST_KEY").unwrap();
        let store = VaultStore::new(PathBuf::from(root));
        // The unlock's own history commit must not be where the boundary is reached.
        ENV_BOUNDARIES_HELD.store(true, Ordering::Release);
        let unlocked = store.unlock(TARGET_PASSWORD);
        ENV_BOUNDARIES_HELD.store(false, Ordering::Release);
        unlocked.unwrap();
        let key = crate::vault::profile_package::parse_package_key(&key_text).unwrap();
        let file = fs::File::open(package).unwrap();
        let _ = store.import_profile_package(
            std::io::BufReader::new(file),
            PackageSecret::Key(&key),
            &options(),
            200,
        );
        panic!("configured termination boundary was not reached");
    }

    #[test]
    fn a_process_killed_while_importing_leaves_the_vault_as_it_was_or_fully_imported() {
        let source = source_vault();
        let (key, text) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let files = tempfile::tempdir().unwrap();
        let package = files.path().join("handover.mycarlosprofile");
        fs::write(&package, &bytes).unwrap();
        let mut wanted = Vec::new();
        for id in &source.records {
            let mut out = Vec::new();
            source.store.export(*id, &mut out).unwrap();
            wanted.push(out);
        }

        // Killed before the one commit: the vault is as it was, opens, holds none of the
        // person, and taking the same file afterwards makes the whole person.
        for boundary in [
            "package-import.after-staging",
            "package-import.after-object-publication",
            "package-import.after-object-rename",
        ] {
            let (_temp, target) = target_vault();
            let files_before = object_files(&target);
            let root = target.root.clone();
            target.lock();
            run_import_child(&root, &package, &text, boundary);
            target.unlock(TARGET_PASSWORD).unwrap();
            let snapshot = target.snapshot().unwrap();
            assert_eq!(snapshot.profiles.len(), 1, "{boundary}");
            assert!(
                snapshot.records.is_empty() && snapshot.folders.is_empty(),
                "{boundary}"
            );
            assert!(target
                .history_entries()
                .unwrap()
                .iter()
                .all(|e| e.event != HistoryEvent::ProfileImported));
            // What the killed run published is no part of the vault: orphans are put aside
            // at unlock, so the vault holds what it held, and nothing is half taken.
            assert!(unreferenced_objects(&target).is_empty(), "{boundary}");
            assert_eq!(
                object_files(&target).len(),
                files_before.len(),
                "{boundary}"
            );
            let done = imported(take(&target, &bytes, &key, &options()));
            assert_eq!(done.documents, 3, "{boundary}");
        }

        // Killed after the commit's first write (and after its second): the person is whole.
        for boundary in ["manifest.after-first-write", "manifest.after-second-write"] {
            let (_temp, target) = target_vault();
            let root = target.root.clone();
            target.lock();
            run_import_child(&root, &package, &text, boundary);
            target.unlock(TARGET_PASSWORD).unwrap();
            let snapshot = target.snapshot().unwrap();
            assert_eq!(snapshot.profiles.len(), 2, "{boundary}");
            let person = snapshot
                .profiles
                .iter()
                .find(|p| p.display_name == "FAKE Child")
                .unwrap();
            let mine: Vec<_> = snapshot
                .records
                .iter()
                .filter(|r| r.profile_id == person.id)
                .collect();
            assert_eq!(mine.len(), 3, "{boundary}");
            let mut contents = Vec::new();
            for record in &mine {
                let mut out = Vec::new();
                target.export(record.id, &mut out).unwrap();
                contents.push(out);
            }
            assert_eq!(contents, wanted, "{boundary}");
            // Every document and answer reads back, and the same file is recognised.
            assert!(target.verify_for_backup().is_ok(), "{boundary}");
            let again = take(&target, &bytes, &key, &options()).unwrap();
            assert!(matches!(again, ImportResult::AlreadyHere(_)), "{boundary}");
        }
    }

    // --- The #409 review ------------------------------------------------------------------

    /// An explanation as the reader keeps it, for the fake model.
    fn explain_bytes(term: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "tool": "explain",
            "term": term,
            "context": "FAKE context",
            "text": "FAKE explanation.",
            "model": {"name": "FAKE model", "sha256": "00".repeat(32)},
            "lang": "en",
            "createdAt": 1,
        }))
        .unwrap()
    }

    fn explain_answer(term: &str, superseded: bool, content: &[u8], at: u64) -> PackageAiAnswer {
        PackageAiAnswer {
            object: PackageObject {
                id: Uuid::new_v4(),
                size: content.len() as u64,
            },
            tool: "explain".to_owned(),
            lang: "en".to_owned(),
            term: Some(term.to_owned()),
            model_name: "FAKE model".to_owned(),
            model_sha256: "00".repeat(32),
            created_at_ms: at,
            superseded,
        }
    }

    /// The preview says which previous names the file lists, since once imported they count as
    /// the clinic's name when a clinic document is filed (#340).
    #[test]
    fn the_preview_lists_the_previous_names_the_file_carries() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        let mut manifest = hand_made(Vec::new(), Vec::new());
        manifest.profile.previous_full_names =
            vec!["FAKE Old Name".to_owned(), "FAKE Maiden Name".to_owned()];
        let bytes = crafted(manifest, &[], &key);
        let preview = target
            .inspect_profile_package(Cursor::new(&bytes), PackageSecret::Key(&key))
            .unwrap();
        assert_eq!(
            preview.previous_full_names,
            vec!["FAKE Old Name".to_owned(), "FAKE Maiden Name".to_owned()]
        );
    }

    #[test]
    fn a_genuine_original_beside_a_forged_document_is_refused_whole() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        let genuine = pdf(b"FAKE-GENUINE-SIGNED", 300);
        let forged = pdf(b"FAKE-FORGED-DISPLAY", 300);
        let mut record = plain("FAKE Letter.pdf", forged.len());
        record.original_pdf = Some(PackageObject {
            id: Uuid::new_v4(),
            size: genuine.len() as u64,
        });
        let generation_before = generation(&target);
        let files_before = object_files(&target);
        let bytes = crafted(
            hand_made(vec![record.clone()], Vec::new()),
            &[forged.clone(), genuine.clone()],
            &key,
        );
        assert!(matches!(
            take(&target, &bytes, &key, &options()),
            Err(VaultError::Invalid)
        ));
        assert_eq!(generation(&target), generation_before);
        assert_eq!(object_files(&target), files_before);
        assert!(staging_is_empty(&target));
        // The same document twice (the vault always copies the original from the display) is
        // what a package of this app holds, and comes.
        let mut honest = plain("FAKE Letter.pdf", genuine.len());
        honest.original_pdf = Some(PackageObject {
            id: Uuid::new_v4(),
            size: genuine.len() as u64,
        });
        let bytes = crafted(
            hand_made(vec![honest], Vec::new()),
            &[genuine.clone(), genuine],
            &key,
        );
        assert_eq!(
            imported(take(&target, &bytes, &key, &options())).documents,
            1
        );
    }

    #[test]
    fn answers_beyond_the_caps_are_never_staged_and_every_published_object_is_named() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        let mut record = plain("FAKE Letter.pdf", 4);
        let mut contents = vec![vec![1_u8, 2, 3, 4]];
        let mut answers = Vec::new();
        // 40 shown (a question each) and 120 older ones, hidden: more than a document keeps.
        for n in 0..40 {
            let term = format!("FAKE term {n}");
            let content = explain_bytes(&term);
            answers.push(explain_answer(&term, false, &content, 1_000 + n));
            contents.push(content);
        }
        for n in 0..120 {
            let term = format!("FAKE term {}", n % 40);
            let content = explain_bytes(&term);
            answers.push(explain_answer(&term, true, &content, n));
            contents.push(content);
        }
        record.ai_answers = answers;
        let bytes = crafted(hand_made(vec![record], Vec::new()), &contents, &key);
        let done = imported(take(&target, &bytes, &key, &options()));
        assert_eq!(done.ai_answers, 32 + 96);
        assert_eq!(done.ai_answers_dropped, 160 - 128);
        // Nothing published that the manifest does not name; nothing left staged.
        assert!(unreferenced_objects(&target).is_empty());
        assert!(staging_is_empty(&target));
        let guard = target.session();
        let manifest = &guard.as_ref().unwrap().manifest;
        let record = manifest.records.last().unwrap();
        assert_eq!(
            record.ai_results.iter().filter(|a| !a.superseded).count(),
            32
        );
        assert_eq!(
            record.ai_results.iter().filter(|a| a.superseded).count(),
            96
        );
        // Every one of them says it came in a file.
        assert!(record.ai_results.iter().all(|a| a.imported));
    }

    #[test]
    fn imported_answers_say_so_and_the_flag_is_a_handover_format_field() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        let done = imported(take(&target, &bytes, &key, &options()));
        let record = target
            .snapshot()
            .unwrap()
            .records
            .into_iter()
            .find(|r| {
                r.profile_id == done.profile_id && !target.ai_results(r.id).unwrap().is_empty()
            })
            .unwrap();
        let info = target.ai_results(record.id).unwrap();
        assert!(info.iter().all(|a| a.imported));
        // This computer's own answers are not marked.
        let own = source.store.ai_results(source.records[0]).unwrap();
        assert!(own.iter().all(|a| !a.imported));
        assert!(!serde_json::to_string(&own).unwrap().contains("imported"));
        assert!(serde_json::to_string(&info)
            .unwrap()
            .contains("\"imported\":true"));
        // Below the handover format a manifest holding one is refused: an older build would drop it.
        let mut manifest = target.session().as_ref().unwrap().manifest.clone();
        manifest.format_version = MANIFEST_FORMAT_PROFILE_HANDOVER - 1;
        for profile in &mut manifest.profiles {
            profile.imported_from = None;
            profile.imported_history = None;
        }
        assert!(validate_manifest_structure(&manifest, manifest.vault_id).is_err());
        manifest
            .records
            .iter_mut()
            .for_each(|r| r.ai_results.iter_mut().for_each(|a| a.imported = false));
        assert!(validate_manifest_structure(&manifest, manifest.vault_id).is_ok());
    }

    #[test]
    fn the_old_history_keeps_only_entries_about_a_document_that_came_and_never_a_future_time() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        let record = plain("FAKE Letter.pdf", 4);
        let id = record.id;
        let mut manifest = hand_made(vec![record], Vec::new());
        let entry = |record_id: Option<Uuid>, at: u64| {
            let mut value = serde_json::json!({
                "atMs": at,
                "event": "imported",
                "hash": "a".repeat(64),
                "prev": "b".repeat(64),
            });
            if let Some(record_id) = record_id {
                value["recordId"] = serde_json::json!(record_id);
            }
            value
        };
        manifest.history = Some(vec![
            entry(Some(id), u64::MAX / 2),
            entry(None, 5),
            entry(Some(Uuid::new_v4()), 6),
        ]);
        let bytes = crafted(manifest, &[vec![1, 2, 3, 4]], &key);
        let done = imported(take(&target, &bytes, &key, &options()));
        assert_eq!(done.history_entries, 1);
        let guard = target.session();
        let profile = guard
            .as_ref()
            .unwrap()
            .manifest
            .profiles
            .iter()
            .find(|p| p.id == done.profile_id)
            .unwrap();
        let kept = profile.imported_history.as_ref().unwrap();
        assert_eq!(kept.len(), 1);
        // Clamped to the time of the import (200 in these tests), never a time to come.
        assert_eq!(kept[0].at_ms, 200);
    }

    #[test]
    fn a_commit_that_may_have_landed_keeps_its_objects_and_the_vault_settles_it_at_unlock() {
        let source = source_vault();
        let (key, _) = generate_package_key();
        let (bytes, _) = export_bytes(&source, &key);
        let (_temp, target) = target_vault();
        {
            let _fail = FailsAt::new("manifest.before-first-write");
            assert!(take(&target, &bytes, &key, &options()).is_err());
        }
        // Read-only until it is settled, and the objects are not removed from under a commit
        // that might be the newest.
        assert!(target.snapshot().unwrap().recovery.is_some());
        assert!(!unreferenced_objects(&target).is_empty());
        target.lock();
        target.unlock(TARGET_PASSWORD).unwrap();
        assert!(target.snapshot().unwrap().recovery.is_none());
        assert!(unreferenced_objects(&target).is_empty());
        assert_eq!(target.snapshot().unwrap().profiles.len(), 1);
        imported(take(&target, &bytes, &key, &options()));
    }

    #[test]
    fn a_package_this_vault_cannot_hold_is_refused_before_a_byte_is_staged() {
        let (key, _) = generate_package_key();
        let (_temp, target) = target_vault();
        // A name the vault refuses for a person.
        let mut manifest = hand_made(vec![plain("FAKE A.pdf", 3)], Vec::new());
        manifest.profile.display_name = "Shared with me".to_owned();
        let bytes = crafted(manifest, &[vec![1, 2, 3]], &key);
        let files_before = object_files(&target);
        assert!(matches!(
            take(&target, &bytes, &key, &options()),
            Err(VaultError::Invalid | VaultError::NotFound)
        ));
        assert_eq!(object_files(&target), files_before);
        assert!(staging_is_empty(&target));
    }
}
