//! The Android PDF reader's Rust side (#358): the document goes from the vault into a sealed,
//! anonymous in-memory file (a memfd) that the Kotlin plugin opens with `PdfRenderer`. Nothing is
//! ever written to a path: no cache, no files directory, no temporary file.
//!
//! - The generation (`Gate`) is shared by opens, cancellation and vault locks, and is sent to the
//!   plugin too, so a cancelled open cannot reappear from its UI queue.
//! - `ActivityGate` lets only genuine input in an open reader count as activity for auto-lock.
//! - `prepare` decrypts into a bounded, wiped buffer (the same rules as the iPhone reader).
//! - `sealed_memfd` makes the memfd through the raw system call: bionic exports `memfd_create`
//!   only from API 30 and the app supports API 24. If the system refuses (an old kernel, a vendor
//!   SELinux policy), it fails closed with an error, and never falls back to a file.
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// The largest document the Android reader takes (the same bound as the iPhone reader).
pub(crate) const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Gate(AtomicU64);

impl Gate {
    pub(crate) fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub(crate) fn current(&self, generation: u64) -> bool {
        self.0.load(Ordering::SeqCst) == generation
    }
}

/// A dismissed or replaced reader cannot postpone either inactivity deadline.
pub(crate) struct ActivityGate {
    generation: u64,
    open: AtomicBool,
}

impl ActivityGate {
    pub(crate) fn new(generation: u64) -> Self {
        Self {
            generation,
            open: AtomicBool::new(true),
        }
    }

    pub(crate) fn accepts(&self, gate: &Gate, event: &str) -> bool {
        if event == "closed" {
            self.open.store(false, Ordering::SeqCst);
        }
        event == "activity" && self.open.load(Ordering::SeqCst) && gate.current(self.generation)
    }
}

#[cfg(target_os = "android")]
pub(crate) static GATE: Gate = Gate(AtomicU64::new(0));

/// The PDF is decrypted only into a bounded buffer, wiped by the caller once it is in the memfd.
pub(crate) fn prepare(
    store: &crate::vault::VaultStore,
    record_id: uuid::Uuid,
) -> Result<(zeroize::Zeroizing<Vec<u8>>, String), crate::vault::VaultError> {
    use crate::vault::VaultError;
    let snapshot = store.snapshot()?;
    let record = snapshot
        .records
        .iter()
        .find(|record| record.id == record_id && record.hidden.is_none())
        .ok_or(VaultError::NotFound)?;
    if record.plaintext_size > MAX_BYTES as u64 {
        return Err(VaultError::PdfMobileTooLarge);
    }
    let mut buffer = crate::LimitedBuffer::new(MAX_BYTES);
    let exported = store.export(record_id, &mut buffer);
    if buffer.over {
        return Err(VaultError::PdfMobileTooLarge);
    }
    exported?;
    // Merely a type guard: PdfRenderer validates the PDF itself.
    if !buffer.bytes.starts_with(b"%PDF-") {
        return Err(VaultError::NotPdf);
    }
    Ok((buffer.bytes, record.display_name.clone()))
}

/// The system call and the seals, kept apart so a test can drive their refusal.
pub(crate) trait MemFileSystem {
    /// A new anonymous file that can be sealed, or why the system refused.
    fn create(&self) -> io::Result<OwnedFd>;
    /// Seals the file against any later change in size or content.
    fn seal(&self, fd: &OwnedFd) -> io::Result<()>;
}

pub(crate) struct Linux;

impl MemFileSystem for Linux {
    fn create(&self) -> io::Result<OwnedFd> {
        let name = std::ffi::CString::new("mycarlos-pdf").expect("no NUL in the name");
        // SAFETY: memfd_create takes a NUL-terminated name and flags, and returns a new
        // descriptor or -1; nothing is borrowed beyond the call.
        let raw = unsafe {
            libc::syscall(
                libc::SYS_memfd_create,
                name.as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if raw < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `raw` is a descriptor this call just made and nothing else owns.
        Ok(unsafe { OwnedFd::from_raw_fd(raw as i32) })
    }

    fn seal(&self, fd: &OwnedFd) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        let seals =
            libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE | libc::F_SEAL_SEAL;
        // SAFETY: F_ADD_SEALS on a descriptor this module owns.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// The bytes in a sealed anonymous in-memory file, positioned at its start. There is no path to it
/// and nothing on any filesystem; the caller hands the descriptor's number to the viewer.
pub(crate) fn sealed_memfd(system: &dyn MemFileSystem, bytes: &[u8]) -> io::Result<OwnedFd> {
    let mut file = File::from(system.create()?);
    file.write_all(bytes)?;
    file.flush()?;
    file.seek(SeekFrom::Start(0))?;
    let fd = OwnedFd::from(file);
    system.seal(&fd)?;
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{ImportSource, VaultError, VaultStore};
    use std::io::{Cursor, Read};
    use std::os::fd::AsRawFd;

    fn stored(bytes: Vec<u8>) -> (tempfile::TempDir, VaultStore, uuid::Uuid) {
        let temp = tempfile::tempdir().unwrap();
        let store = VaultStore::new(temp.path().join("vault"));
        store
            .create("river-azimuth-cobalt-sparrow-934", "FAKE Patient", 1)
            .unwrap();
        let person = store.snapshot().unwrap().profiles[0].id;
        let imported = store
            .import(
                person,
                vec![],
                vec![ImportSource {
                    display_name: "FAKE Letter.pdf".to_owned(),
                    reader: Box::new(Cursor::new(bytes)),
                }],
                2,
            )
            .unwrap();
        (temp, store, imported.imported[0])
    }

    #[test]
    fn cancellation_and_a_new_document_invalidate_queued_opens() {
        let gate = Gate::default();
        let old = gate.next();
        assert!(gate.current(old));
        let cancel = gate.next();
        assert!(!gate.current(old));
        let new = gate.next();
        assert!(new > cancel && cancel > old);
        assert!(gate.current(new));
        assert!(!gate.current(cancel));
    }

    #[test]
    fn genuine_activity_stops_on_close_or_request_replacement() {
        let gate = Gate::default();
        let activity = ActivityGate::new(gate.next());
        assert!(activity.accepts(&gate, "activity"));
        assert!(!activity.accepts(&gate, "unknown"));
        assert!(!activity.accepts(&gate, "closed"));
        assert!(!activity.accepts(&gate, "activity"));
        let next = ActivityGate::new(gate.next());
        assert!(next.accepts(&gate, "activity"));
        gate.next();
        assert!(!next.accepts(&gate, "activity"));
    }

    #[test]
    fn prepares_exact_bytes_and_refuses_hidden_and_locked_documents() {
        let bytes = include_bytes!("../../dev-data/FAKE_Avery_Patient_Bloodwork.pdf");
        let (_temp, store, id) = stored(bytes.to_vec());
        let (shown, title) = prepare(&store, id).unwrap();
        assert_eq!(&*shown, bytes);
        assert_eq!(title, "FAKE Letter.pdf");
        store.hide_record(id, 3).unwrap();
        assert!(matches!(prepare(&store, id), Err(VaultError::NotFound)));
        store.lock();
        assert!(matches!(prepare(&store, id), Err(VaultError::Locked)));
    }

    #[test]
    fn refuses_a_pdf_over_the_mobile_memory_budget_before_export() {
        let mut bytes = vec![b' '; MAX_BYTES + 1];
        bytes[..5].copy_from_slice(b"%PDF-");
        let (_temp, store, id) = stored(bytes);
        assert!(matches!(
            prepare(&store, id),
            Err(VaultError::PdfMobileTooLarge)
        ));
    }

    #[test]
    fn refuses_a_document_that_is_not_a_pdf() {
        let (_temp, store, id) = stored(b"FAKE text, not a PDF".to_vec());
        assert!(matches!(prepare(&store, id), Err(VaultError::NotPdf)));
    }

    #[test]
    fn the_bytes_are_in_a_sealed_anonymous_file_with_no_path() {
        let bytes = b"%PDF-1.7\nFAKE document bytes\n";
        let fd = sealed_memfd(&Linux, bytes).unwrap();
        // It reads back exactly, from the start.
        let mut file = File::from(fd.try_clone().unwrap());
        let mut read = Vec::new();
        file.read_to_end(&mut read).unwrap();
        assert_eq!(read, bytes);
        // It is a memfd: its link in /proc names no file on any filesystem.
        let link = std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd())).unwrap();
        assert!(
            link.to_string_lossy().starts_with("/memfd:mycarlos-pdf"),
            "{link:?}"
        );
        // Sealed: it can no longer be written to or resized, even through a second descriptor.
        let mut writer = File::from(fd.try_clone().unwrap());
        assert!(writer.write_all(b"more").is_err() || writer.set_len(1).is_err());
        let rewritten = std::fs::OpenOptions::new()
            .write(true)
            .open(format!("/proc/self/fd/{}", fd.as_raw_fd()));
        if let Ok(mut again) = rewritten {
            assert!(again.write_all(b"x").is_err());
        }
        assert!(File::from(fd).set_len(0).is_err());
    }

    struct Refusing(i32);

    impl MemFileSystem for Refusing {
        fn create(&self) -> io::Result<OwnedFd> {
            Err(io::Error::from_raw_os_error(self.0))
        }

        fn seal(&self, _fd: &OwnedFd) -> io::Result<()> {
            unreachable!("nothing was created")
        }
    }

    #[test]
    fn a_system_that_refuses_the_memfd_fails_closed_and_never_falls_back_to_a_file() {
        let before = std::fs::read_dir(std::env::temp_dir()).unwrap().count();
        for errno in [libc::ENOSYS, libc::EPERM] {
            let error = sealed_memfd(&Refusing(errno), b"%PDF-1.7 FAKE").unwrap_err();
            assert_eq!(error.raw_os_error(), Some(errno));
        }
        // No temporary file appeared anywhere the process writes by default.
        assert_eq!(
            std::fs::read_dir(std::env::temp_dir()).unwrap().count(),
            before
        );
    }
}
