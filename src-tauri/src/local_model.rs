//! The AI helper's model on this computer (#72): a short list of accepted
//! models shipped with the app, and the patient adding one of them as a file.
//!
//! The patient gets the file themselves (the list says where, as text) and
//! picks it, or has the app download it from its pinned address
//! ([`crate::model_download`], native code, on a click). Either way the app checks its size
//! against the list before reading anything, streams it through SHA-256
//! into `models/` beside the vault folder (never inside it, so never in a
//! backup) as `<name>.part`, and renames it only when the hash matches. The
//! original stays where the patient put it. A `.part` left behind (a crash,
//! a lock) is removed at the next start and before the next add.
//!
//! At each use the file is checked again ([`Store::verified_model`]): size
//! on the open handle, hash while reading. The caller gets that open
//! read-only handle and loads the model from it, never from a path.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::local_runner::{MemoryProbe, ModelInfo};

/// One accepted model. Swapping the model is a change to [`CATALOG`] only.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Accepted {
    pub(crate) name: &'static str,
    pub(crate) file_name: &'static str,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: &'static str,
    pub(crate) licence: &'static str,
    /// Notice lines the licence requires the app to show.
    pub(crate) notices: &'static [&'static str],
    /// Where to get the file: shown as text with a Copy button. The app
    /// opens nothing.
    pub(crate) source_url: &'static str,
}

/// The models the app accepts. The demo build's pick (the bake-off's best on
/// both blind graders, and the one that works through the engine): Qwen3.5 4B.
pub(crate) const CATALOG: &[Accepted] = &[Accepted {
    name: "Qwen3.5 4B (Q4_K_M)",
    file_name: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    size_bytes: 3_013_027_808,
    sha256: "13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983",
    licence: "Apache-2.0",
    notices: &[],
    source_url: "https://huggingface.co/bartowski/Qwen_Qwen3.5-4B-GGUF/resolve/4168f45a16a1290d65a4ec0fa312ae917a4c15d6/Qwen_Qwen3.5-4B-Q4_K_M.gguf",
}];

/// What the renderer is told about the model on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum ModelStatus {
    NotInstalled,
    Installed {
        model: ModelInfo,
    },
    /// This computer cannot run the helper: the row explains, no Add button.
    Unsupported {
        reason: Unsupported,
    },
    /// A file is there but its size or hash is wrong: the row offers Remove.
    Damaged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Unsupported {
    Ram,
    Cpu,
    Platform,
}

/// Why adding or using a model was refused. `code` is what the renderer maps
/// to its text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ModelError {
    Unsupported(Unsupported),
    /// The file is not the size of any accepted model, and is not larger
    /// than all of them.
    NotOnList,
    /// Larger than any accepted model: refused before anything is read.
    TooBig,
    /// The file ended before its size, or changed while being read.
    Truncated,
    /// The size matches but the content does not: not the file we expect.
    WrongHash,
    NotEnoughDisk,
    /// The picked file could not be opened as a regular file.
    Unreadable,
    /// The models folder could not be written.
    Storage,
    /// The installed file no longer matches (at use).
    Damaged,
    NotInstalled,
    /// A run holds the model: not removed or replaced meanwhile.
    Busy,
    /// The patient stopped the add; nothing is left.
    Cancelled,
    /// The download could not reach the address, or lost the connection.
    Network,
    /// The address refused (401, 403, 404, 410): not available to download.
    Unavailable,
    /// Not enough free memory to hold the model for a run now (checked
    /// before the sealed copy is made). The runner maps it to `aiMemory`.
    Memory,
}

impl ModelError {
    /// The word the renderer maps to its text.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Unsupported(_) => "unsupported",
            Self::NotOnList => "notListed",
            Self::TooBig => "tooBig",
            Self::Truncated => "incomplete",
            Self::WrongHash => "wrongHash",
            Self::NotEnoughDisk => "noDisk",
            Self::Unreadable => "unreadable",
            Self::Storage => "storage",
            Self::Damaged => "damaged",
            Self::NotInstalled => "notInstalled",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::Memory => "memory",
            Self::Network => "network",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Where a download's bytes come from: the real network ([`crate::model_download::Https`])
/// or a fake in tests.
pub(crate) trait Opener {
    /// Opens the model's pinned address, from byte `from` when the server
    /// can resume there (it may answer from 0 instead: see [`Opened::start`]).
    /// `cancelled` is looked at while waiting for bytes.
    fn open<'a>(
        &self,
        model: &Accepted,
        from: u64,
        cancelled: &'a dyn Fn() -> bool,
    ) -> Result<Opened<'a>, OpenerError>;
}

pub(crate) struct Opened<'a> {
    /// The length of the whole file the server announced, when it did.
    pub(crate) size: Option<u64>,
    /// Where `reader` starts: the `from` asked for, or 0 when the server
    /// sent the file from its start.
    pub(crate) start: u64,
    pub(crate) reader: Box<dyn Read + 'a>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenerError {
    Network,
    /// A redirect to a host that is not allowed.
    BadRedirect,
    /// 401 or 403.
    Denied,
    /// 404 or 410.
    Gone,
}

/// What this computer is, as far as the helper cares.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Machine {
    /// A 64-bit desktop (not a phone, not 32-bit).
    pub(crate) desktop_64: bool,
    pub(crate) ram_total_bytes: Option<u64>,
    pub(crate) avx2: bool,
}

/// An "8 GB" computer reports about 7.6-7.9 GiB (hardware-reserved memory
/// is left out), so the floor is 7 GiB; the free-memory check at each run
/// still protects a busy one.
pub(crate) const MIN_RAM_BYTES: u64 = 7 * 1024 * 1024 * 1024;
/// Free disk needed before an add or download starts (at least; the file's
/// own size plus a margin when that is more).
pub(crate) const MIN_FREE_DISK_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// Room kept beyond the file itself while copying.
const DISK_MARGIN_BYTES: u64 = 256 * 1024 * 1024;

pub(crate) trait Hardware: Send + Sync {
    fn machine(&self) -> Machine;
    /// Free bytes on the volume holding `dir`; `None` when unknown.
    fn free_disk_bytes(&self, dir: &Path) -> Option<u64>;
}

/// This computer.
pub(crate) struct Here;

impl Hardware for Here {
    fn machine(&self) -> Machine {
        Machine {
            // macOS joins when its loading rule is built (a private clone of
            // the file, hashed, handed over by descriptor): until then the
            // row says "unsupported: platform" there.
            desktop_64: cfg!(all(
                target_pointer_width = "64",
                any(target_os = "linux", windows)
            )),
            ram_total_bytes: total_memory_bytes(),
            avx2: has_avx2(),
        }
    }

    fn free_disk_bytes(&self, dir: &Path) -> Option<u64> {
        free_disk(dir)
    }
}

fn has_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        // The runtime is built with AVX2, FMA, F16C and BMI2: all four are needed.
        std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c")
            && std::arch::is_x86_feature_detected!("bmi2")
    }
    // Apple silicon and other ARM64 desktops run the model with NEON.
    #[cfg(not(target_arch = "x86_64"))]
    {
        cfg!(target_arch = "aarch64")
    }
}

#[cfg(unix)]
fn free_disk(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    // The folder may not exist yet: ask about the nearest one that does.
    let mut probe = dir;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let path = std::ffi::CString::new(probe.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is NUL-terminated and `stat` is a valid out-pointer.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    (stat.f_bavail as u64).checked_mul(stat.f_frsize as u64)
}

#[cfg(windows)]
fn free_disk(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut probe = dir;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let wide: Vec<u16> = probe.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    // SAFETY: `wide` is NUL-terminated and `free` is a valid out-pointer.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

#[cfg(not(any(unix, windows)))]
fn free_disk(_dir: &Path) -> Option<u64> {
    None
}

/// Whether this computer can run the helper at all (not whether disk is
/// free: that is a refusal at add time).
pub(crate) fn unsupported(machine: &Machine) -> Option<Unsupported> {
    if !machine.desktop_64 {
        Some(Unsupported::Platform)
    } else if !machine.avx2 {
        Some(Unsupported::Cpu)
    } else if machine
        .ram_total_bytes
        .is_none_or(|ram| ram < MIN_RAM_BYTES)
    {
        Some(Unsupported::Ram)
    } else {
        None
    }
}

/// A model that passed its check, open for reading from the start.
pub(crate) struct VerifiedModel {
    /// Holding this, the model is in use: add and remove answer `Busy`.
    _use: UseGuard,
    pub(crate) file: File,
    pub(crate) path: PathBuf,
    pub(crate) info: ModelInfo,
    pub(crate) size_bytes: u64,
}

impl Store {
    /// The listed size of the model that is installed (by size on disk), for
    /// the runtime's memory check before anything is read.
    pub(crate) fn installed_size(&self) -> Option<u64> {
        self.catalog.iter().find_map(|model| {
            let meta = fs::symlink_metadata(self.dir.join(model.file_name)).ok()?;
            (meta.is_file() && meta.len() == model.size_bytes).then_some(model.size_bytes)
        })
    }
}

/// Where the AI runtime gets its model: this store, checked again at each
/// helper start.
pub(crate) struct RuntimeSource(pub(crate) Arc<Store>);

impl crate::model_runtime::ModelSource for RuntimeSource {
    fn installed_size(&self) -> Option<u64> {
        self.0.installed_size()
    }

    fn verified(
        &self,
    ) -> Result<crate::model_runtime::Verified, crate::model_runtime::Unavailable> {
        use crate::model_runtime::Unavailable;
        if unsupported(&Here.machine()).is_some() {
            return Err(Unavailable::Unsupported);
        }
        let model = self.0.verified_model().map_err(|error| match error {
            ModelError::NotInstalled => Unavailable::NotInstalled,
            ModelError::Damaged => Unavailable::Damaged,
            ModelError::Memory => Unavailable::Memory,
            ModelError::Busy => Unavailable::Busy,
            ModelError::Unsupported(_) => Unavailable::Unsupported,
            _ => Unavailable::Storage,
        })?;
        Ok(crate::model_runtime::Verified {
            file: model.file,
            path: model.path,
            info: model.info,
            size_bytes: model.size_bytes,
        })
    }
}

/// Counts a use of the model while it lives.
struct UseGuard(Arc<AtomicUsize>);

impl UseGuard {
    fn new(uses: &Arc<AtomicUsize>) -> Self {
        uses.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(uses))
    }
}

impl Drop for UseGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The models folder and the list it is checked against.
pub(crate) struct Store {
    dir: PathBuf,
    catalog: &'static [Accepted],
    /// Set when a use-time check found the file wrong; cleared by remove or
    /// a successful add.
    damaged: Mutex<bool>,
    /// One add, remove or use-check at a time.
    busy: Mutex<()>,
    /// Runs holding the model now (see [`VerifiedModel`]).
    uses: Arc<AtomicUsize>,
    /// Asked to stop the add in progress.
    cancel_add: AtomicBool,
}

/// The one place a file is removed here. The models folder holds a public
/// model file and its half-copied `.part`, never anything of the patient's,
/// so #71's "nothing of theirs is deleted" does not apply: Remove the model
/// really deletes it.
#[allow(clippy::disallowed_methods)]
fn remove_model_file(path: impl AsRef<Path>) -> std::io::Result<()> {
    fs::remove_file(path)
}

const BUFFER_BYTES: usize = 1024 * 1024;
const PART_SUFFIX: &str = ".part";

impl Store {
    pub(crate) fn new(dir: PathBuf, catalog: &'static [Accepted]) -> Self {
        Self {
            dir,
            catalog,
            damaged: Mutex::new(false),
            busy: Mutex::new(()),
            uses: Arc::new(AtomicUsize::new(0)),
            cancel_add: AtomicBool::new(false),
        }
    }

    #[cfg(windows)]
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    pub(crate) fn catalog(&self) -> &'static [Accepted] {
        self.catalog
    }

    fn largest(&self) -> u64 {
        self.catalog.iter().map(|m| m.size_bytes).max().unwrap_or(0)
    }

    /// The add/remove/use lock, or `Busy` when another holds it (an add or
    /// download takes minutes: nothing waits behind it).
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ()>, ModelError> {
        match self.busy.try_lock() {
            Ok(guard) => Ok(guard),
            Err(std::sync::TryLockError::Poisoned(e)) => Ok(e.into_inner()),
            Err(std::sync::TryLockError::WouldBlock) => Err(ModelError::Busy),
        }
    }

    fn damaged(&self) -> bool {
        *self.damaged.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_damaged(&self, value: bool) {
        *self.damaged.lock().unwrap_or_else(|e| e.into_inner()) = value;
    }

    /// Makes the models folder (private to the user; on Windows readable by
    /// the model helper's AppContainer, which files in it inherit). Also run
    /// at start for a folder that already exists.
    pub(crate) fn prepare_dir(&self) -> Result<(), ModelError> {
        fs::create_dir_all(&self.dir).map_err(|_| ModelError::Storage)?;
        restrict_dir(&self.dir);
        #[cfg(windows)]
        if !crate::model_acl::grant_read(&self.dir, crate::model_acl::APP_CONTAINER) {
            return Err(ModelError::Storage);
        }
        Ok(())
    }

    /// Stops the add in progress, if any: it ends with `Cancelled` and
    /// leaves nothing behind.
    pub(crate) fn cancel_add(&self) {
        self.cancel_add.store(true, Ordering::SeqCst);
    }

    /// Removes any `.part` left by an add that did not finish. (A download
    /// that was cut short keeps its own `.part` to resume: see `download`.)
    pub(crate) fn clean_leftovers(&self) {
        self.clean_leftovers_except(None);
    }

    fn clean_leftovers_except(&self, keep: Option<&str>) {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(PART_SUFFIX) && Some(name.as_str()) != keep {
                let _ = remove_model_file(entry.path());
            }
        }
    }

    /// The state for the row. Cheap: sizes only; the hash is checked at use
    /// and sets `Damaged` when it fails.
    pub(crate) fn status(&self, hardware: &dyn Hardware) -> ModelStatus {
        if let Some(reason) = unsupported(&hardware.machine()) {
            return ModelStatus::Unsupported { reason };
        }
        for model in self.catalog {
            match fs::symlink_metadata(self.dir.join(model.file_name)) {
                Ok(meta) if meta.is_file() && meta.len() == model.size_bytes => {
                    return if self.damaged() {
                        ModelStatus::Damaged
                    } else {
                        ModelStatus::Installed {
                            model: ModelInfo {
                                name: model.name.to_owned(),
                                sha256: model.sha256.to_owned(),
                            },
                        }
                    };
                }
                Ok(_) => return ModelStatus::Damaged,
                Err(_) => {}
            }
        }
        ModelStatus::NotInstalled
    }

    /// Adds the file at `source`. `progress(done, total)` is called as
    /// bytes are copied. Nothing is left in the folder on a refusal.
    pub(crate) fn add(
        &self,
        source: &Path,
        hardware: &dyn Hardware,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<ModelInfo, ModelError> {
        let _one_at_a_time = self.lock()?;
        // Reset inside the lock: only an add that is about to run is not cancelled.
        self.cancel_add.store(false, Ordering::SeqCst);

        if self.uses.load(Ordering::SeqCst) > 0 {
            return Err(ModelError::Busy);
        }
        if let Some(reason) = unsupported(&hardware.machine()) {
            return Err(ModelError::Unsupported(reason));
        }
        let mut input =
            crate::vault::open_regular_read(source).map_err(|_| ModelError::Unreadable)?;
        let size = input.metadata().map_err(|_| ModelError::Unreadable)?.len();
        self.add_stream(&mut input, size, None, 0, hardware, &mut progress)
    }

    /// The checks and the copy for any byte source (a picked file now; a
    /// download of a pinned address could feed the same): `size` is what the
    /// source says it holds, checked against the list before a byte is read;
    /// then the bytes are streamed through SHA-256 into a `.part` and the
    /// file is kept only on a match. The caller holds the add lock.
    fn add_stream(
        &self,
        input: &mut dyn Read,
        size: u64,
        want: Option<&Accepted>,
        have: u64,
        hardware: &dyn Hardware,
        progress: &mut impl FnMut(u64, u64),
    ) -> Result<ModelInfo, ModelError> {
        // Size first: nothing larger than the list is read at all.
        if size > self.largest() {
            return Err(ModelError::TooBig);
        }
        let model = self
            .catalog
            .iter()
            .find(|m| m.size_bytes == size && want.is_none_or(|w| w.sha256 == m.sha256))
            .ok_or(ModelError::NotOnList)?;
        self.prepare_dir()?;
        let part_name = format!("{}{PART_SUFFIX}", model.file_name);
        self.clean_leftovers_except((have > 0).then_some(part_name.as_str()));
        let free = hardware.free_disk_bytes(&self.dir);
        // What is still to be written; a resumed `.part` already holds `have`.
        let to_write = size.saturating_sub(have);
        if free.is_none_or(|free| {
            free < to_write
                .saturating_add(DISK_MARGIN_BYTES)
                .max(MIN_FREE_DISK_BYTES)
        }) {
            return Err(ModelError::NotEnoughDisk);
        }
        let part = self.dir.join(&part_name);
        let result = copy_checked(input, &part, model, &self.cancel_add, have, progress);
        if let Err(error) = result {
            // A download cut short (the connection lost, a read that failed)
            // keeps what it has, to resume: only when the source was a
            // download and the file is still short. Cancel is the patient
            // saying no: what arrived is removed (up to the model's size).
            let short = fs::metadata(&part).is_ok_and(|m| m.len() < size);
            let resumable = want.is_some()
                && short
                && matches!(error, ModelError::Unreadable | ModelError::Truncated);
            if !resumable {
                let _ = remove_model_file(&part);
            }
            return Err(error);
        }
        let target = self.dir.join(model.file_name);
        if fs::rename(&part, &target).is_err() {
            let _ = remove_model_file(&part);
            return Err(ModelError::Storage);
        }
        sync_dir(&self.dir);
        self.set_damaged(false);
        Ok(ModelInfo {
            name: model.name.to_owned(),
            sha256: model.sha256.to_owned(),
        })
    }

    /// Downloads catalog entry `index` from its pinned address through the
    /// same checks as a picked file. Starts only on the patient's click; the
    /// free-disk check comes before any connection.
    pub(crate) fn download(
        &self,
        index: usize,
        opener: &dyn Opener,
        hardware: &dyn Hardware,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<ModelInfo, ModelError> {
        let _one_at_a_time = self.lock()?;
        // Reset inside the lock: only an add that is about to run is not cancelled.
        self.cancel_add.store(false, Ordering::SeqCst);

        if self.uses.load(Ordering::SeqCst) > 0 {
            return Err(ModelError::Busy);
        }
        if let Some(reason) = unsupported(&hardware.machine()) {
            return Err(ModelError::Unsupported(reason));
        }
        let model = self.catalog.get(index).ok_or(ModelError::NotOnList)?;
        self.prepare_dir()?;
        // A `.part` from a download that was cut short is resumed (its bytes
        // are hashed again from the start; only the rest is fetched). Any
        // other `.part`, one that cannot be this file's rest, is removed.
        let part_name = format!("{}{PART_SUFFIX}", model.file_name);
        let part = self.dir.join(&part_name);
        let mut have = match fs::symlink_metadata(&part) {
            Ok(meta) if meta.is_file() && meta.len() > 0 && meta.len() < model.size_bytes => {
                meta.len()
            }
            _ => 0,
        };
        self.clean_leftovers_except((have > 0).then_some(part_name.as_str()));
        if have == 0 {
            let _ = remove_model_file(&part);
        }
        let free = hardware.free_disk_bytes(&self.dir);
        if free.is_none_or(|free| {
            free < model
                .size_bytes
                .saturating_sub(have)
                .saturating_add(DISK_MARGIN_BYTES)
                .max(MIN_FREE_DISK_BYTES)
        }) {
            return Err(ModelError::NotEnoughDisk);
        }
        let cancelled = || self.cancel_add.load(Ordering::SeqCst);
        let mut opened = opener
            .open(model, have, &cancelled)
            .map_err(|error| match error {
                OpenerError::Denied | OpenerError::Gone => ModelError::Unavailable,
                OpenerError::Network | OpenerError::BadRedirect => ModelError::Network,
            })?;
        if opened.start != have {
            // The server sent the file from its start (or from somewhere
            // else): start the `.part` again from nothing.
            if opened.start != 0 {
                return Err(ModelError::Network);
            }
            have = 0;
            let _ = remove_model_file(&part);
        }
        // The server's own length must be the listed size, before a byte is read.
        if opened
            .size
            .is_some_and(|announced| announced != model.size_bytes)
        {
            return Err(ModelError::Network);
        }
        self.add_stream(
            &mut opened.reader,
            model.size_bytes,
            Some(model),
            have,
            hardware,
            &mut progress,
        )
        .map_err(|error| match error {
            // A read that failed here is the connection, not a picked file.
            ModelError::Unreadable | ModelError::Truncated => ModelError::Network,
            other => other,
        })
    }

    /// Deletes the model and any `.part`. A missing file is not an error.
    pub(crate) fn remove(&self) -> Result<(), ModelError> {
        let _one_at_a_time = self.lock()?;
        if self.uses.load(Ordering::SeqCst) > 0 {
            return Err(ModelError::Busy);
        }
        for model in self.catalog {
            match remove_model_file(self.dir.join(model.file_name)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(ModelError::Storage),
            }
        }
        self.clean_leftovers();
        self.set_damaged(false);
        Ok(())
    }

    /// Checks the installed file again and hands back the open handle: size
    /// on the handle, hash while reading. A mismatch marks the model
    /// damaged.
    pub(crate) fn verified_model(&self) -> Result<VerifiedModel, ModelError> {
        self.verified_model_with(&SystemMemory)
    }

    /// As [`Self::verified_model`], reading free memory from `probe`. On
    /// Linux the sealed copy lives in memory beside the loaded weights, so
    /// twice the size plus 1.5 GiB must be free before it is made; unknown
    /// refuses.
    pub(crate) fn verified_model_with(
        &self,
        probe: &dyn MemoryProbe,
    ) -> Result<VerifiedModel, ModelError> {
        let _one_at_a_time = self.lock()?;
        // Windows: the helper's read access to the folder is granted again
        // before each use (cheap, idempotent), so a failure shows here, as
        // "could not be saved", rather than as a silent failed run.
        #[cfg(windows)]
        if self.dir.exists() {
            self.prepare_dir()?;
        }
        for model in self.catalog {
            let path = self.dir.join(model.file_name);
            #[cfg(target_os = "linux")]
            {
                let needed = model
                    .size_bytes
                    .saturating_mul(2)
                    .saturating_add(1536 << 20);
                if probe.available_bytes().is_none_or(|free| free < needed) {
                    return Err(ModelError::Memory);
                }
            }
            #[cfg(not(target_os = "linux"))]
            let _ = probe;
            let file = match open_for_use(&path) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                // Windows: another program holds the file open for writing
                // (ERROR_SHARING_VIOLATION): in use, not damaged.
                Err(e) if cfg!(windows) && e.raw_os_error() == Some(32) => {
                    return Err(ModelError::Busy);
                }
                Err(_) => {
                    self.set_damaged(true);
                    return Err(ModelError::Damaged);
                }
            };
            let sized = file.metadata().is_ok_and(|m| m.len() == model.size_bytes);
            let verified = if sized {
                hash_into_handle(file, model.size_bytes, model.sha256)
            } else {
                None
            };
            let Some(file) = verified else {
                self.set_damaged(true);
                return Err(ModelError::Damaged);
            };
            return Ok(VerifiedModel {
                _use: UseGuard::new(&self.uses),
                file,
                path,
                info: ModelInfo {
                    name: model.name.to_owned(),
                    sha256: model.sha256.to_owned(),
                },
                size_bytes: model.size_bytes,
            });
        }
        Err(ModelError::NotInstalled)
    }
}

/// Opens the installed file for a use. Windows: shared for reading only, so
/// that no other program can write to it while it is held open.
fn open_for_use(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_file() {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        // FILE_SHARE_READ
        OpenOptions::new().read(true).share_mode(1).open(path)
    }
    #[cfg(not(windows))]
    {
        crate::vault::open_regular_read(path)
    }
}

/// Reads exactly `size` bytes from the start, hashing them; when `copy` is
/// given the same bytes are written to it as they are read. `None` when the
/// file is shorter or longer, or a read or write fails.
fn hash_stream(file: &mut File, size: u64, mut copy: Option<&mut File>) -> Option<String> {
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; BUFFER_BYTES];
    let mut total = 0u64;
    let mut reader = file.take(size + 1);
    loop {
        let n = reader.read(&mut buffer).ok()?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > size {
            return None;
        }
        hasher.update(&buffer[..n]);
        if let Some(copy) = copy.as_deref_mut() {
            copy.write_all(&buffer[..n]).ok()?;
        }
    }
    (total == size).then(|| hex(&hasher.finalize()))
}

/// The handle the helper loads from, once the content matches `sha256`.
/// Linux: a sealed memfd holding the bytes that were hashed, one pass, so
/// nothing another process writes to the file afterwards can reach the
/// helper. Elsewhere: the file itself, rewound (macOS: read handle; Windows:
/// held with writers denied, see [`open_for_use`]).
fn hash_into_handle(mut file: File, size: u64, sha256: &str) -> Option<File> {
    #[cfg(target_os = "linux")]
    {
        let mut sealed = sealed_memfd()?;
        if hash_stream(&mut file, size, Some(&mut sealed))? != sha256 {
            return None;
        }
        seal(&sealed)?;
        sealed.seek(SeekFrom::Start(0)).ok()?;
        Some(sealed)
    }
    #[cfg(not(target_os = "linux"))]
    {
        if hash_stream(&mut file, size, None)? != sha256 {
            return None;
        }
        file.seek(SeekFrom::Start(0)).ok()?;
        Some(file)
    }
}

#[cfg(target_os = "linux")]
fn sealed_memfd() -> Option<File> {
    use std::os::fd::FromRawFd;
    // SAFETY: a NUL-terminated name and known flags; the descriptor, when
    // valid, is owned by the File made from it.
    let fd = unsafe {
        libc::memfd_create(
            c"mycarlos-model".as_ptr(),
            libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
        )
    };
    // SAFETY: `fd` is a fresh descriptor nobody else holds.
    (fd >= 0).then(|| unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn seal(file: &File) -> Option<()> {
    use std::os::fd::AsRawFd;
    let seals = libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
    // SAFETY: the descriptor is valid for the call.
    (unsafe { libc::fcntl(file.as_raw_fd(), libc::F_ADD_SEALS, seals) } == 0).then_some(())
}

// --- Memory --------------------------------------------------------------

/// This computer's free-memory reading for the runner's budget. Linux:
/// `MemAvailable`. macOS: free, speculative, purgeable and file-backed
/// pages from the vm sysctls. Windows: `ullAvailPhys`. A reading that fails
/// is "unknown", and unknown refuses.
pub(crate) struct SystemMemory;

impl MemoryProbe for SystemMemory {
    fn available_bytes(&self) -> Option<u64> {
        #[cfg(target_os = "linux")]
        {
            meminfo_kib(&fs::read_to_string("/proc/meminfo").ok()?, "MemAvailable:")
        }
        #[cfg(target_os = "macos")]
        {
            macos_available_bytes()
        }
        #[cfg(windows)]
        {
            windows_memory().map(|status| status.available)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        {
            None
        }
    }
}

/// The memory this computer has in all, for the hardware check (8 GB).
pub(crate) fn total_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        meminfo_kib(&fs::read_to_string("/proc/meminfo").ok()?, "MemTotal:")
    }
    #[cfg(target_os = "macos")]
    {
        macos_sysctl_u64("hw.memsize")
    }
    #[cfg(windows)]
    {
        windows_memory().map(|status| status.total)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        None
    }
}

/// `MemAvailable:   12345 kB` → bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn meminfo_kib(meminfo: &str, key: &str) -> Option<u64> {
    let line = meminfo.lines().find(|line| line.starts_with(key))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    kib.checked_mul(1024)
}

#[cfg(target_os = "macos")]
fn macos_sysctl_u64(name: &str) -> Option<u64> {
    let name = std::ffi::CString::new(name).ok()?;
    let mut value = [0u8; 8];
    let mut len = value.len();
    // SAFETY: `name` is NUL-terminated; `value` and `len` describe a valid buffer.
    let status = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    match (status, len) {
        (0, 8) => Some(u64::from_ne_bytes(value)),
        (0, 4) => Some(u64::from(u32::from_ne_bytes([
            value[0], value[1], value[2], value[3],
        ]))),
        _ => None,
    }
}

/// Pages a new program can have without pushing others to swap: free,
/// speculative, purgeable, and file-backed (the cache gives them up).
#[cfg(target_os = "macos")]
fn macos_available_bytes() -> Option<u64> {
    let page = macos_sysctl_u64("vm.pagesize").or_else(|| macos_sysctl_u64("hw.pagesize"))?;
    let mut pages = 0u64;
    for name in [
        "vm.page_free_count",
        "vm.page_speculative_count",
        "vm.page_purgeable_count",
        "vm.page_pageable_external_count",
    ] {
        pages = pages.checked_add(macos_sysctl_u64(name)?)?;
    }
    pages.checked_mul(page)
}

#[cfg(windows)]
struct WindowsMemory {
    total: u64,
    available: u64,
}

#[cfg(windows)]
fn windows_memory() -> Option<WindowsMemory> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // SAFETY: `status` is a valid MEMORYSTATUSEX with its length set.
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    Some(WindowsMemory {
        total: status.ullTotalPhys,
        available: status.ullAvailPhys,
    })
}

fn copy_checked(
    input: &mut dyn Read,
    part: &Path,
    model: &Accepted,
    cancel: &AtomicBool,
    have: u64,
    progress: &mut impl FnMut(u64, u64),
) -> Result<(), ModelError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; BUFFER_BYTES];
    let mut done = 0u64;
    progress(0, model.size_bytes);
    let mut output = if have > 0 {
        // Resuming: hash what is already there, from its start, then append.
        let mut kept = OpenOptions::new()
            .read(true)
            .write(true)
            .open(part)
            .map_err(|_| ModelError::Storage)?;
        if kept.metadata().map_err(|_| ModelError::Storage)?.len() != have {
            return Err(ModelError::Storage);
        }
        let mut prefix = Read::take(&mut kept, have);
        while done < have {
            if cancel.load(Ordering::SeqCst) {
                return Err(ModelError::Cancelled);
            }
            let n = prefix.read(&mut buffer).map_err(|_| ModelError::Storage)?;
            if n == 0 {
                return Err(ModelError::Storage);
            }
            hasher.update(&buffer[..n]);
            done += n as u64;
            progress(done, model.size_bytes);
        }
        kept.seek(SeekFrom::End(0))
            .map_err(|_| ModelError::Storage)?;
        kept
    } else {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(part).map_err(|_| ModelError::Storage)?
    };
    // One byte more than what is left is read, so a source that grew is seen.
    let mut reader = Read::take(input, model.size_bytes - have + 1);
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(ModelError::Cancelled);
        }
        let n = reader.read(&mut buffer).map_err(|_| {
            if cancel.load(Ordering::SeqCst) {
                ModelError::Cancelled
            } else {
                ModelError::Unreadable
            }
        })?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > model.size_bytes {
            return Err(ModelError::Truncated);
        }
        hasher.update(&buffer[..n]);
        output
            .write_all(&buffer[..n])
            .map_err(|_| ModelError::Storage)?;
        progress(done, model.size_bytes);
    }
    if done != model.size_bytes {
        return Err(ModelError::Truncated);
    }
    if hex(&hasher.finalize()) != model.sha256 {
        return Err(ModelError::WrongHash);
    }
    output.sync_all().map_err(|_| ModelError::Storage)
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn restrict_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(Machine, Option<u64>);
    impl Hardware for Fixed {
        fn machine(&self) -> Machine {
            self.0
        }
        fn free_disk_bytes(&self, _dir: &Path) -> Option<u64> {
            self.1
        }
    }
    fn good() -> Fixed {
        Fixed(
            Machine {
                desktop_64: true,
                ram_total_bytes: Some(16 << 30),
                avx2: true,
            },
            Some(100 << 30),
        )
    }

    /// A FAKE entry: its file is 1 MiB of pseudo-random bytes made now, and
    /// its hash is computed from them. Nothing here is a real model.
    fn fake(size: usize) -> (Vec<u8>, &'static [Accepted]) {
        let mut state = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
            | 1;
        let bytes: Vec<u8> = (0..size)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect();
        let sha: &'static str = Box::leak(hex(&Sha256::digest(&bytes)).into_boxed_str());
        let list = vec![Accepted {
            name: "FAKE model",
            file_name: "fake.gguf",
            size_bytes: size as u64,
            sha256: sha,
            licence: "none",
            notices: &[],
            source_url: "https://example.invalid/fake",
        }];
        (bytes, Box::leak(list.into_boxed_slice()))
    }

    fn setup(size: usize) -> (tempfile::TempDir, Vec<u8>, Store) {
        let temp = tempfile::tempdir().unwrap();
        let (bytes, list) = fake(size);
        let store = Store::new(temp.path().join("models"), list);
        (temp, bytes, store)
    }

    fn source(temp: &tempfile::TempDir, bytes: &[u8]) -> PathBuf {
        let path = temp.path().join("picked.gguf");
        fs::write(&path, bytes).unwrap();
        path
    }

    fn folder_names(store: &Store) -> Vec<String> {
        fs::read_dir(&store.dir)
            .map(|d| {
                d.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn adds_a_matching_file_and_reports_it_installed_and_verifies_it() {
        let (temp, bytes, store) = setup(1 << 20);
        assert_eq!(store.status(&good()), ModelStatus::NotInstalled);
        let mut last = (0, 0);
        let info = store
            .add(&source(&temp, &bytes), &good(), |d, t| last = (d, t))
            .unwrap();
        assert_eq!(last, (1 << 20, 1 << 20));
        assert_eq!(
            store.status(&good()),
            ModelStatus::Installed { model: info }
        );
        assert_eq!(folder_names(&store), ["fake.gguf"]);
        let mut verified = store.verified_model().unwrap();
        assert_eq!(verified.size_bytes, 1 << 20);
        // The handle holds the bytes that were hashed, from the start.
        let mut read = Vec::new();
        verified.file.read_to_end(&mut read).unwrap();
        assert_eq!(read, bytes);
        // The original stays where it was.
        assert!(temp.path().join("picked.gguf").exists());
    }

    #[test]
    fn wrong_hash_is_refused_and_leaves_nothing() {
        let (temp, mut bytes, store) = setup(1 << 20);
        bytes[500_000] ^= 1;
        let error = store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap_err();
        assert_eq!(error, ModelError::WrongHash);
        assert!(folder_names(&store).is_empty());
        assert_eq!(store.status(&good()), ModelStatus::NotInstalled);
    }

    #[test]
    fn wrong_size_is_refused_before_anything_is_copied() {
        let (temp, bytes, store) = setup(1 << 20);
        let error = store
            .add(&source(&temp, &bytes[..(1 << 20) - 1]), &good(), |_, _| {
                panic!("read")
            })
            .unwrap_err();
        assert_eq!(error, ModelError::NotOnList);
        assert!(!store.dir.exists() || folder_names(&store).is_empty());
    }

    #[test]
    fn a_file_larger_than_every_entry_is_too_big() {
        let (temp, bytes, store) = setup(1 << 20);
        let mut more = bytes.clone();
        more.push(0);
        let error = store
            .add(&source(&temp, &more), &good(), |_, _| panic!("read"))
            .unwrap_err();
        assert_eq!(error, ModelError::TooBig);
    }

    #[test]
    fn a_shorter_copy_is_not_on_the_list() {
        let (temp, bytes, store) = setup(1 << 20);
        let error = store
            .add(
                &source(&temp, &bytes[..bytes.len() / 2]),
                &good(),
                |_, _| {},
            )
            .unwrap_err();
        assert_eq!(error, ModelError::NotOnList);
    }

    #[test]
    fn a_leftover_part_is_cleaned_before_an_add_and_at_start() {
        let (temp, bytes, store) = setup(1 << 20);
        fs::create_dir_all(&store.dir).unwrap();
        fs::write(store.dir.join("fake.gguf.part"), b"old").unwrap();
        store.clean_leftovers();
        assert!(folder_names(&store).is_empty());
        fs::write(store.dir.join("fake.gguf.part"), b"old").unwrap();
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        assert_eq!(folder_names(&store), ["fake.gguf"]);
    }

    #[test]
    fn remove_deletes_the_model_and_a_part_and_is_repeatable() {
        let (temp, bytes, store) = setup(1 << 20);
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        fs::write(store.dir.join("fake.gguf.part"), b"x").unwrap();
        store.remove().unwrap();
        assert!(folder_names(&store).is_empty());
        assert_eq!(store.status(&good()), ModelStatus::NotInstalled);
        store.remove().unwrap();
    }

    #[test]
    fn a_changed_installed_file_is_damaged_at_use_and_after_remove_is_clear() {
        let (temp, bytes, store) = setup(1 << 20);
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        let mut changed = bytes.clone();
        changed[10] ^= 1;
        fs::write(store.dir.join("fake.gguf"), &changed).unwrap();
        assert_eq!(store.verified_model().err(), Some(ModelError::Damaged));
        assert_eq!(store.status(&good()), ModelStatus::Damaged);
        store.remove().unwrap();
        assert_eq!(store.status(&good()), ModelStatus::NotInstalled);
    }

    #[test]
    fn an_installed_file_of_the_wrong_size_is_damaged_in_status() {
        let (_temp, _bytes, store) = setup(1 << 20);
        fs::create_dir_all(&store.dir).unwrap();
        fs::write(store.dir.join("fake.gguf"), b"short").unwrap();
        assert_eq!(store.status(&good()), ModelStatus::Damaged);
        assert_eq!(store.verified_model().err(), Some(ModelError::Damaged));
    }

    #[test]
    fn a_file_that_shrinks_while_being_read_is_truncated() {
        let (temp, bytes, store) = setup(3 << 20);
        let path = source(&temp, &bytes);
        let shrink = path.clone();
        let error = store
            .add(&path, &good(), |done, _| {
                if done == 0 {
                    return;
                }
                let f = OpenOptions::new().write(true).open(&shrink).unwrap();
                f.set_len(1 << 20).unwrap();
            })
            .unwrap_err();
        assert_eq!(error, ModelError::Truncated);
        assert!(folder_names(&store).is_empty());
    }

    #[test]
    fn not_enough_disk_refuses_and_unknown_disk_refuses() {
        let (temp, bytes, store) = setup(1 << 20);
        let none = Fixed(good().0, Some(1 << 20));
        assert_eq!(
            store
                .add(&source(&temp, &bytes), &none, |_, _| {})
                .unwrap_err(),
            ModelError::NotEnoughDisk
        );
        let unknown = Fixed(good().0, None);
        assert_eq!(
            store
                .add(&source(&temp, &bytes), &unknown, |_, _| {})
                .unwrap_err(),
            ModelError::NotEnoughDisk
        );
        assert!(folder_names(&store).is_empty());
    }

    #[test]
    fn unsupported_machines_say_why_and_cannot_add() {
        let (temp, bytes, store) = setup(1 << 20);
        let cases = [
            (
                Machine {
                    desktop_64: false,
                    ..good().0
                },
                Unsupported::Platform,
            ),
            (
                Machine {
                    avx2: false,
                    ..good().0
                },
                Unsupported::Cpu,
            ),
            (
                Machine {
                    ram_total_bytes: Some(4 << 30),
                    ..good().0
                },
                Unsupported::Ram,
            ),
            (
                Machine {
                    ram_total_bytes: None,
                    ..good().0
                },
                Unsupported::Ram,
            ),
        ];
        for (machine, reason) in cases {
            let hw = Fixed(machine, Some(100 << 30));
            assert_eq!(store.status(&hw), ModelStatus::Unsupported { reason });
            assert_eq!(
                store
                    .add(&source(&temp, &bytes), &hw, |_, _| {})
                    .unwrap_err(),
                ModelError::Unsupported(reason)
            );
        }
    }

    #[test]
    fn an_eight_gb_computer_reporting_7_8_gib_is_supported() {
        let (_temp, _bytes, store) = setup(1 << 20);
        let hw = Fixed(
            Machine {
                ram_total_bytes: Some((7.8 * (1u64 << 30) as f64) as u64),
                ..good().0
            },
            Some(100 << 30),
        );
        assert_eq!(store.status(&hw), ModelStatus::NotInstalled);
    }

    #[test]
    fn a_symlink_as_the_picked_file_is_refused() {
        #[cfg(unix)]
        {
            let (temp, bytes, store) = setup(1 << 20);
            let real = source(&temp, &bytes);
            let link = temp.path().join("link.gguf");
            std::os::unix::fs::symlink(&real, &link).unwrap();
            assert_eq!(
                store.add(&link, &good(), |_, _| {}).unwrap_err(),
                ModelError::Unreadable
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_handle_is_sealed_and_a_later_write_to_the_file_does_not_reach_it() {
        let (temp, bytes, store) = setup(1 << 20);
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        let mut verified = store.verified_model().unwrap();
        // Another process changes the file after the check.
        let mut changed = bytes.clone();
        changed[0] ^= 1;
        fs::write(store.dir.join("fake.gguf"), &changed).unwrap();
        let mut read = Vec::new();
        verified.file.read_to_end(&mut read).unwrap();
        assert_eq!(read, bytes);
        // And the handle itself accepts no writes or growth.
        assert!(verified.file.write_all(b"x").is_err());
        assert!(verified.file.set_len(1).is_err());
    }

    #[test]
    fn while_a_run_holds_the_model_add_and_remove_are_busy() {
        let (temp, bytes, store) = setup(1 << 20);
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        let held = store.verified_model().unwrap();
        assert_eq!(store.remove().unwrap_err(), ModelError::Busy);
        assert_eq!(
            store
                .add(&source(&temp, &bytes), &good(), |_, _| {})
                .unwrap_err(),
            ModelError::Busy
        );
        drop(held);
        store.remove().unwrap();
    }

    #[test]
    fn a_cancelled_add_leaves_nothing_and_the_next_add_works() {
        let (temp, bytes, store) = setup(3 << 20);
        let path = source(&temp, &bytes);
        let store = Arc::new(store);
        let stopper = Arc::clone(&store);
        let error = store
            .add(&path, &good(), |done, _| {
                if done > 0 {
                    stopper.cancel_add();
                }
            })
            .unwrap_err();
        assert_eq!(error, ModelError::Cancelled);
        assert!(folder_names(&store).is_empty());
        store.add(&path, &good(), |_, _| {}).unwrap();
        assert_eq!(folder_names(&store), ["fake.gguf"]);
    }

    struct Free(Option<u64>);
    impl MemoryProbe for Free {
        fn available_bytes(&self) -> Option<u64> {
            self.0
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn not_enough_or_unknown_free_memory_refuses_before_the_copy() {
        let (temp, bytes, store) = setup(1 << 20);
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        for free in [Some(1 << 20), None] {
            assert_eq!(
                store.verified_model_with(&Free(free)).err(),
                Some(ModelError::Memory)
            );
        }
        // Refusing for memory is not damage.
        assert_eq!(
            store.status(&good()),
            ModelStatus::Installed {
                model: ModelInfo {
                    name: "FAKE model".into(),
                    sha256: store.catalog()[0].sha256.into()
                }
            }
        );
        store.verified_model_with(&Free(Some(4 << 30))).unwrap();
    }

    /// A fake network: serves `bytes` (announcing `announce`), or refuses.
    struct Fake {
        bytes: Vec<u8>,
        announce: Option<u64>,
        refuse: Option<OpenerError>,
        opened: std::cell::Cell<u32>,
        /// Whether the server resumes from the asked offset.
        ranges: bool,
        /// The offsets asked for, in order.
        asked: std::cell::RefCell<Vec<u64>>,
        /// The next body ends after this many bytes, as a lost connection does.
        cut_once: std::cell::Cell<Option<usize>>,
    }
    impl Fake {
        fn serving(bytes: &[u8]) -> Self {
            Self {
                bytes: bytes.to_vec(),
                announce: Some(bytes.len() as u64),
                refuse: None,
                opened: std::cell::Cell::new(0),
                ranges: true,
                asked: std::cell::RefCell::new(Vec::new()),
                cut_once: std::cell::Cell::new(None),
            }
        }
    }
    impl Opener for Fake {
        fn open<'a>(
            &self,
            _: &Accepted,
            from: u64,
            _: &'a dyn Fn() -> bool,
        ) -> Result<Opened<'a>, OpenerError> {
            self.opened.set(self.opened.get() + 1);
            self.asked.borrow_mut().push(from);
            if let Some(error) = self.refuse {
                return Err(error);
            }
            let start = if self.ranges { from } else { 0 };
            let mut body = self.bytes[start as usize..].to_vec();
            if let Some(cut) = self.cut_once.take() {
                body.truncate(cut);
            }
            Ok(Opened {
                size: self.announce,
                start,
                reader: Box::new(std::io::Cursor::new(body)),
            })
        }
    }

    #[test]
    fn a_download_goes_through_the_same_checks_and_installs() {
        let (_temp, bytes, store) = setup(3 << 20);
        let net = Fake::serving(&bytes);
        let mut last = (0, 0);
        let info = store
            .download(0, &net, &good(), |d, t| last = (d, t))
            .unwrap();
        assert_eq!(last, (3 << 20, 3 << 20));
        assert_eq!(
            store.status(&good()),
            ModelStatus::Installed { model: info }
        );
        assert_eq!(folder_names(&store), ["fake.gguf"]);
        store.verified_model_with(&Free(Some(100 << 30))).unwrap();
    }

    #[test]
    fn a_download_with_the_wrong_content_is_refused_and_leaves_nothing() {
        let (_temp, mut bytes, store) = setup(1 << 20);
        bytes[7] ^= 1;
        let net = Fake::serving(&bytes);
        assert_eq!(
            store.download(0, &net, &good(), |_, _| {}).unwrap_err(),
            ModelError::WrongHash
        );
        assert!(folder_names(&store).is_empty());
    }

    #[test]
    fn a_download_longer_or_shorter_than_listed_is_refused() {
        let (_temp, bytes, store) = setup(1 << 20);
        // The server announces another length: refused before a byte is read.
        let mut net = Fake::serving(&bytes);
        net.announce = Some(2 << 20);
        assert_eq!(
            store
                .download(0, &net, &good(), |_, _| panic!("read"))
                .unwrap_err(),
            ModelError::Network
        );
        // Silent about the length. Too long: refused, cleaned. Cut short: refused,
        // and what arrived is kept to resume.
        let mut net = Fake::serving(&[bytes.as_slice(), b"x"].concat());
        net.announce = None;
        assert_eq!(
            store.download(0, &net, &good(), |_, _| {}).unwrap_err(),
            ModelError::Network
        );
        assert!(folder_names(&store).is_empty());
        let mut net = Fake::serving(&bytes[..bytes.len() - 1]);
        net.announce = None;
        assert_eq!(
            store.download(0, &net, &good(), |_, _| {}).unwrap_err(),
            ModelError::Network
        );
        assert_eq!(folder_names(&store), ["fake.gguf.part"]);
    }

    #[test]
    fn a_gated_or_missing_file_says_unavailable_and_other_failures_say_network() {
        let (_temp, bytes, store) = setup(1 << 20);
        for (refuse, expected) in [
            (OpenerError::Denied, ModelError::Unavailable),
            (OpenerError::Gone, ModelError::Unavailable),
            (OpenerError::Network, ModelError::Network),
            (OpenerError::BadRedirect, ModelError::Network),
        ] {
            let mut net = Fake::serving(&bytes);
            net.refuse = Some(refuse);
            assert_eq!(
                store.download(0, &net, &good(), |_, _| {}).unwrap_err(),
                expected
            );
            assert!(folder_names(&store).is_empty());
        }
    }

    #[test]
    fn a_download_checks_disk_and_the_machine_before_any_connection() {
        let (_temp, bytes, store) = setup(1 << 20);
        let net = Fake::serving(&bytes);
        let full = Fixed(good().0, Some(1 << 20));
        assert_eq!(
            store.download(0, &net, &full, |_, _| {}).unwrap_err(),
            ModelError::NotEnoughDisk
        );
        let weak = Fixed(
            Machine {
                avx2: false,
                ..good().0
            },
            Some(100 << 30),
        );
        assert_eq!(
            store.download(0, &net, &weak, |_, _| {}).unwrap_err(),
            ModelError::Unsupported(Unsupported::Cpu)
        );
        assert_eq!(
            store.download(5, &net, &good(), |_, _| {}).unwrap_err(),
            ModelError::NotOnList
        );
        assert_eq!(net.opened.get(), 0);
    }

    #[test]
    fn a_cancelled_download_leaves_nothing_even_when_it_was_resuming() {
        let (_temp, bytes, store) = setup(3 << 20);
        let net = Fake::serving(&bytes);
        let store = Arc::new(store);
        let cancel_once_started = |store: &Arc<Store>| {
            let stopper = Arc::clone(store);
            store
                .download(0, &net, &good(), |done, _| {
                    if done > 0 {
                        stopper.cancel_add();
                    }
                })
                .unwrap_err()
        };
        assert_eq!(cancel_once_started(&store), ModelError::Cancelled);
        assert!(folder_names(&store).is_empty());
        assert_eq!(store.status(&good()), ModelStatus::NotInstalled);
        // Cut short first, so a part is kept; then Cancel during the resume
        // removes it too.
        assert_eq!(cut_short(&store, &net, 1 << 20), ModelError::Network);
        assert_eq!(folder_names(&store), ["fake.gguf.part"]);
        assert_eq!(cancel_once_started(&store), ModelError::Cancelled);
        assert!(folder_names(&store).is_empty());
    }

    /// The connection ends `after` bytes into the next download.
    fn cut_short(store: &Store, net: &Fake, after: usize) -> ModelError {
        net.cut_once.set(Some(after));
        store.download(0, net, &good(), |_, _| {}).unwrap_err()
    }

    #[test]
    fn a_cut_download_is_resumed_from_where_it_stopped_and_installs() {
        let (_temp, bytes, store) = setup(4 << 20);
        let store = Arc::new(store);
        let net = Fake::serving(&bytes);
        assert_eq!(cut_short(&store, &net, 1 << 20), ModelError::Network);
        // What it had is kept, short of the whole.
        let kept = fs::metadata(store.dir.join("fake.gguf.part"))
            .unwrap()
            .len();
        assert!(kept > 0 && kept < 4 << 20, "{kept}");
        let mut last = (0, 0);
        store
            .download(0, &net, &good(), |d, t| last = (d, t))
            .unwrap();
        assert_eq!(*net.asked.borrow(), [0, kept]);
        assert_eq!(last, (4 << 20, 4 << 20));
        assert_eq!(folder_names(&store), ["fake.gguf"]);
        let mut verified = store.verified_model_with(&Free(Some(100 << 30))).unwrap();
        let mut read = Vec::new();
        verified.file.read_to_end(&mut read).unwrap();
        assert_eq!(read, bytes);
    }

    #[test]
    fn a_lost_connection_keeps_the_part_for_the_next_try() {
        let (_temp, bytes, store) = setup(4 << 20);
        let store = Arc::new(store);
        // The server sends only the first 2 MiB, then the connection ends.
        let mut net = Fake::serving(&bytes);
        net.bytes = bytes[..2 << 20].to_vec();
        net.announce = None;
        assert_eq!(
            store.download(0, &net, &good(), |_, _| {}).unwrap_err(),
            ModelError::Network
        );
        assert_eq!(
            fs::metadata(store.dir.join("fake.gguf.part"))
                .unwrap()
                .len(),
            2 << 20
        );
        let net = Fake::serving(&bytes);
        store.download(0, &net, &good(), |_, _| {}).unwrap();
        assert_eq!(*net.asked.borrow(), [2 << 20]);
    }

    #[test]
    fn a_server_that_cannot_resume_sends_it_all_again_and_it_still_installs() {
        let (_temp, bytes, store) = setup(3 << 20);
        let store = Arc::new(store);
        let mut net = Fake::serving(&bytes);
        net.ranges = false;
        assert_eq!(cut_short(&store, &net, 1 << 20), ModelError::Network);
        store.download(0, &net, &good(), |_, _| {}).unwrap();
        assert_eq!(folder_names(&store), ["fake.gguf"]);
        store.verified_model_with(&Free(Some(100 << 30))).unwrap();
    }

    #[test]
    fn a_part_with_wrong_bytes_is_refused_at_the_end_and_removed() {
        let (_temp, bytes, store) = setup(3 << 20);
        let store = Arc::new(store);
        let net = Fake::serving(&bytes);
        assert_eq!(cut_short(&store, &net, 1 << 20), ModelError::Network);
        // Someone changed the kept bytes: the re-hash from the start finds it.
        let part = store.dir.join("fake.gguf.part");
        let mut kept = fs::read(&part).unwrap();
        kept[3] ^= 1;
        fs::write(&part, kept).unwrap();
        assert_eq!(
            store.download(0, &net, &good(), |_, _| {}).unwrap_err(),
            ModelError::WrongHash
        );
        assert!(folder_names(&store).is_empty());
    }

    #[test]
    fn a_part_that_cannot_be_the_rest_is_dropped_not_resumed() {
        let (_temp, bytes, store) = setup(2 << 20);
        fs::create_dir_all(&store.dir).unwrap();
        // As long as the whole file, or empty: nothing to resume.
        for len in [2usize << 20, 0] {
            fs::write(store.dir.join("fake.gguf.part"), vec![1u8; len]).unwrap();
            let net = Fake::serving(&bytes);
            store.download(0, &net, &good(), |_, _| {}).unwrap();
            assert_eq!(*net.asked.borrow(), [0]);
            store.remove().unwrap();
        }
    }

    #[test]
    fn an_add_from_a_file_never_resumes_and_clears_a_download_part() {
        let (temp, bytes, store) = setup(2 << 20);
        fs::create_dir_all(&store.dir).unwrap();
        fs::write(store.dir.join("fake.gguf.part"), b"half").unwrap();
        store
            .add(&source(&temp, &bytes), &good(), |_, _| {})
            .unwrap();
        assert_eq!(folder_names(&store), ["fake.gguf"]);
    }

    #[test]
    fn this_computers_memory_can_be_read_or_says_unknown() {
        #[cfg(target_os = "linux")]
        {
            assert!(total_memory_bytes().unwrap() > 0);
            assert!(SystemMemory.available_bytes().unwrap() > 0);
        }
        assert_eq!(
            meminfo_kib("MemTotal:  2048 kB\n", "MemTotal:"),
            Some(2048 * 1024)
        );
        assert_eq!(meminfo_kib("Other: 1 kB\n", "MemTotal:"), None);
    }

    #[test]
    fn the_shipped_catalog_is_well_formed() {
        assert!(!CATALOG.is_empty());
        for m in CATALOG {
            assert_eq!(m.sha256.len(), 64);
            assert!(m
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(m.file_name.ends_with(".gguf") && !m.file_name.contains('/'));
            assert!(m.size_bytes > 0 && !m.licence.is_empty());
            assert!(m.source_url.starts_with("https://"));
        }
    }

    #[test]
    fn status_serialises_as_the_renderer_reads_it() {
        assert_eq!(
            serde_json::to_value(ModelStatus::NotInstalled).unwrap(),
            serde_json::json!({ "state": "notInstalled" })
        );
        assert_eq!(
            serde_json::to_value(ModelStatus::Unsupported {
                reason: Unsupported::Ram
            })
            .unwrap(),
            serde_json::json!({ "state": "unsupported", "reason": "ram" })
        );
        assert_eq!(
            serde_json::to_value(ModelStatus::Damaged).unwrap(),
            serde_json::json!({ "state": "damaged" })
        );
    }
}
