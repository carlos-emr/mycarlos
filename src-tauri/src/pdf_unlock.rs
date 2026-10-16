//! Opening a password-protected PDF once, at import (#54).
//!
//! Decrypting means parsing a PDF from an untrusted sender, so it never happens in the process
//! that holds vault keys (THREAT_MODEL IMP-02). The app starts its own executable again with
//! `HELPER_ARG`: a fresh process with no vault, keys or window. It confines itself, reads one
//! document and its password from stdin, writes the document without its password to stdout,
//! and exits. Only the unlocked copy is kept, in the vault; the password is never stored.
//!
//! The limits and the confinement are all here, so that they are easy to review and change.

use std::io::{self, Read, Write};
use std::time::Duration;
use zeroize::Zeroizing;

/// The largest locked document the helper is given: `lopdf` holds it whole in memory.
pub(crate) const MAX_LOCKED_PDF_BYTES: usize = 100 * 1024 * 1024;
/// The largest unlocked document taken back. Saving can expand what was packed into
/// object streams, so this allows twice the input.
const MAX_UNLOCKED_PDF_BYTES: usize = 2 * MAX_LOCKED_PDF_BYTES;
/// No stream inside a document may inflate beyond this while it is opened (decompression bombs).
const MAX_DECOMPRESSED_STREAM_BYTES: usize = 256 * 1024 * 1024;
/// How long the helper may run, from start to answer, before it is stopped.
pub(crate) const HELPER_TIME_LIMIT: Duration = Duration::from_secs(30);
/// The memory the helper may use: Unix data limit, Windows job limit.
#[cfg(desktop)]
const HELPER_MEMORY_LIMIT: u64 = 1 << 30;
/// The first argument that starts the executable as the helper.
pub const HELPER_ARG: &str = "--mycarlos-pdf-helper";
/// The longest password accepted, in UTF-8 bytes. PDF passwords are far shorter.
const MAX_PASSWORD_BYTES: usize = 4096;

const REQUEST_MAGIC: &[u8; 8] = b"MCPDFRQ1";
const RESPONSE_MAGIC: &[u8; 8] = b"MCPDFRS1";
const UNLOCKED: u8 = 0;

/// Why the helper gave no unlocked document.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// The password did not open it, or none was given and one is needed.
    WrongPassword,
    /// It has no password; it can be imported as it is.
    NotEncrypted,
    /// It could not be read as a PDF.
    Damaged,
    /// It is larger than `MAX_LOCKED_PDF_BYTES`.
    TooLarge,
    /// It is protected in a way `lopdf` cannot open, such as a certificate.
    Unsupported,
}

impl Refusal {
    fn code(self) -> u8 {
        match self {
            Refusal::WrongPassword => 1,
            Refusal::NotEncrypted => 2,
            Refusal::Damaged => 3,
            Refusal::TooLarge => 4,
            Refusal::Unsupported => 5,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            1 => Refusal::WrongPassword,
            2 => Refusal::NotEncrypted,
            3 => Refusal::Damaged,
            4 => Refusal::TooLarge,
            5 => Refusal::Unsupported,
            _ => return None,
        })
    }
}

/// What asking the helper came to.
pub(crate) enum Outcome {
    /// The document without its password, ready for the vault. Wiped when dropped.
    Unlocked(Zeroizing<Vec<u8>>),
    Refused(Refusal),
    /// This device cannot run the helper: phones cannot start a second process.
    #[cfg_attr(desktop, allow(dead_code))]
    Unavailable,
    /// The helper could not be started, ran out of time or memory, or answered wrongly.
    Failed,
}

/// Whether a document might be password-protected: its trailer then names an `/Encrypt`
/// dictionary. This is a byte search, not a parse, so it is safe beside the vault keys. A match
/// is only a hint; the helper decides.
pub(crate) fn may_be_locked(mut reader: impl Read) -> io::Result<bool> {
    const MARKER: &[u8] = b"/Encrypt";
    let mut buffer = vec![0u8; 64 * 1024];
    let mut kept = 0;
    loop {
        let read = match reader.read(&mut buffer[kept..]) {
            Ok(0) => return Ok(false),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let filled = kept + read;
        if buffer[..filled]
            .windows(MARKER.len())
            .any(|window| window == MARKER)
        {
            return Ok(true);
        }
        // Keep the tail, in case the marker is split between two reads.
        kept = (MARKER.len() - 1).min(filled);
        buffer.copy_within(filled - kept..filled, 0);
    }
}

/// Reads a whole document, refusing one larger than the helper takes.
pub(crate) fn read_limited(reader: impl Read) -> io::Result<Result<Vec<u8>, Refusal>> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_LOCKED_PDF_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    Ok(if bytes.len() > MAX_LOCKED_PDF_BYTES {
        Err(Refusal::TooLarge)
    } else {
        Ok(bytes)
    })
}

/// Opens a locked document with its password and returns it saved without one. This is what
/// runs inside the helper; it is never called beside the vault keys.
pub(crate) fn unlock(pdf: &[u8], password: &str) -> Result<Zeroizing<Vec<u8>>, Refusal> {
    use lopdf::{Document, Error, LoadOptions};
    if pdf.len() > MAX_LOCKED_PDF_BYTES {
        return Err(Refusal::TooLarge);
    }
    let options = |password: Option<&str>| LoadOptions {
        password: password.map(str::to_owned),
        max_decompressed_size: Some(MAX_DECOMPRESSED_STREAM_BYTES),
        ..LoadOptions::default()
    };
    // Without a password first, to tell a document that has none from a wrong password.
    let plain =
        Document::load_mem_with_options(pdf, options(None)).map_err(|_| Refusal::Damaged)?;
    if !plain.is_encrypted() {
        return Err(Refusal::NotEncrypted);
    }
    drop(plain);
    let mut document = match Document::load_mem_with_options(pdf, options(Some(password))) {
        Ok(document) => document,
        Err(Error::InvalidPassword) => return Err(Refusal::WrongPassword),
        Err(Error::UnsupportedSecurityHandler(_) | Error::Decryption(_)) => {
            return Err(Refusal::Unsupported)
        }
        Err(_) => return Err(Refusal::Damaged),
    };
    if document.is_encrypted() {
        return Err(Refusal::Unsupported);
    }
    let mut unlocked = Zeroizing::new(Vec::with_capacity(pdf.len()));
    document
        .save_to(&mut *unlocked)
        .map_err(|_| Refusal::Damaged)?;
    if unlocked.len() > MAX_UNLOCKED_PDF_BYTES {
        return Err(Refusal::TooLarge);
    }
    Ok(unlocked)
}

fn write_request(out: &mut impl Write, password: &[u8], pdf: &[u8]) -> io::Result<()> {
    out.write_all(REQUEST_MAGIC)?;
    out.write_all(&(password.len() as u32).to_le_bytes())?;
    out.write_all(password)?;
    out.write_all(&(pdf.len() as u64).to_le_bytes())?;
    out.write_all(pdf)?;
    out.flush()
}

/// A request as the helper reads it, or why it could not be.
enum Request {
    Read {
        password: Zeroizing<String>,
        pdf: Vec<u8>,
    },
    TooLarge,
    Malformed,
}

fn read_request(input: &mut impl Read) -> io::Result<Request> {
    let mut magic = [0u8; 8];
    input.read_exact(&mut magic)?;
    if &magic != REQUEST_MAGIC {
        return Ok(Request::Malformed);
    }
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_PASSWORD_BYTES {
        return Ok(Request::Malformed);
    }
    // Sized up front, so the password is never copied by a growing buffer.
    let mut password = Zeroizing::new(vec![0u8; length]);
    input.read_exact(&mut password)?;
    let Ok(password) = std::str::from_utf8(&password).map(|text| Zeroizing::new(text.to_owned()))
    else {
        return Ok(Request::Malformed);
    };
    let mut length = [0u8; 8];
    input.read_exact(&mut length)?;
    let length = u64::from_le_bytes(length);
    if length > MAX_LOCKED_PDF_BYTES as u64 {
        return Ok(Request::TooLarge);
    }
    let mut pdf = vec![0u8; length as usize];
    input.read_exact(&mut pdf)?;
    Ok(Request::Read { password, pdf })
}

fn write_response(
    out: &mut impl Write,
    result: &Result<Zeroizing<Vec<u8>>, Refusal>,
) -> io::Result<()> {
    out.write_all(RESPONSE_MAGIC)?;
    match result {
        Ok(unlocked) => {
            out.write_all(&[UNLOCKED])?;
            out.write_all(&(unlocked.len() as u64).to_le_bytes())?;
            out.write_all(unlocked)?;
        }
        Err(refusal) => {
            out.write_all(&[refusal.code()])?;
            out.write_all(&0u64.to_le_bytes())?;
        }
    }
    out.flush()
}

/// The helper's answer, or `None` when it is not one: cut short, too long or unknown.
fn read_response(input: &mut impl Read) -> Option<Result<Zeroizing<Vec<u8>>, Refusal>> {
    let mut head = [0u8; 17];
    input.read_exact(&mut head).ok()?;
    if &head[..8] != RESPONSE_MAGIC {
        return None;
    }
    let status = head[8];
    let length = u64::from_le_bytes(head[9..17].try_into().ok()?);
    if status != UNLOCKED {
        return if length == 0 {
            Refusal::from_code(status).map(Err)
        } else {
            None
        };
    }
    if length > MAX_UNLOCKED_PDF_BYTES as u64 {
        return None;
    }
    // Sized up front, so the unlocked document is never copied by a growing buffer.
    let mut unlocked = Zeroizing::new(vec![0u8; length as usize]);
    input.read_exact(&mut unlocked).ok()?;
    // Nothing may follow the answer.
    let mut extra = [0u8; 1];
    matches!(input.read(&mut extra), Ok(0)).then_some(Ok(unlocked))
}

/// The helper: confines itself, answers one request on stdin and stdout, and returns the exit
/// code. Started by `main` when the first argument is `HELPER_ARG`.
pub fn helper_main() -> i32 {
    if confine::this_process().is_err() {
        return 2;
    }
    let mut input = io::stdin().lock();
    let result = match read_request(&mut input) {
        Ok(Request::Read { password, pdf }) => unlock(&pdf, &password),
        Ok(Request::TooLarge) => Err(Refusal::TooLarge),
        Ok(Request::Malformed) | Err(_) => return 3,
    };
    match write_response(&mut io::stdout().lock(), &result) {
        Ok(()) => 0,
        Err(_) => 4,
    }
}

/// Unlocks `pdf` in the helper. Phones cannot start it, so there it is `Unavailable`.
pub(crate) fn unlock_in_helper(pdf: &[u8], password: &str) -> Outcome {
    #[cfg(desktop)]
    {
        let Ok(executable) = std::env::current_exe() else {
            return Outcome::Failed;
        };
        let mut command = std::process::Command::new(executable);
        command.arg(HELPER_ARG);
        run_helper(command, pdf, password, HELPER_TIME_LIMIT)
    }
    #[cfg(mobile)]
    {
        let _ = (pdf, password);
        Outcome::Unavailable
    }
}

/// Runs `command` as the helper: limited, given the request, stopped after `time_limit`.
#[cfg(desktop)]
pub(crate) fn run_helper(
    mut command: std::process::Command,
    pdf: &[u8],
    password: &str,
    time_limit: Duration,
) -> Outcome {
    use std::process::Stdio;
    use std::time::Instant;
    if pdf.len() > MAX_LOCKED_PDF_BYTES {
        return Outcome::Refused(Refusal::TooLarge);
    }
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    confine::before_start(&mut command);
    let Ok(mut child) = command.spawn() else {
        return Outcome::Failed;
    };
    // Held until the end: closing it stops the helper on Windows.
    let _job = match confine::after_start(&child) {
        Ok(job) => job,
        Err(_) => {
            confine::stop(&mut child);
            return Outcome::Failed;
        }
    };
    let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
        confine::stop(&mut child);
        return Outcome::Failed;
    };
    let deadline = Instant::now() + time_limit;
    // Written and read on threads of their own, holding their own copies: the helper may
    // answer before it has read everything, neither side may wait on a full pipe while the
    // clock runs, and nothing the helper leaves behind can keep myCarlos waiting.
    let request = (Zeroizing::new(password.as_bytes().to_vec()), pdf.to_vec());
    std::thread::spawn(move || {
        let (password, pdf) = request;
        let _ = write_request(&mut stdin, &password, &pdf);
    });
    let (answered, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = answered.send(read_response(&mut stdout));
    });
    let exited = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                confine::stop(&mut child);
                break None;
            }
        }
    };
    let answer = answer
        .recv_timeout(
            deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(200),
        )
        .ok()
        .flatten();
    match (exited, answer) {
        (Some(status), Some(Ok(unlocked))) if status.success() => Outcome::Unlocked(unlocked),
        (Some(status), Some(Err(refusal))) if status.success() => Outcome::Refused(refusal),
        _ => Outcome::Failed,
    }
}

/// How the helper is confined. Unix: no new file or socket can be opened, no file written, no
/// core dump, and CPU and data memory are capped. Windows: a job object caps memory, stops
/// any child process, and ends the helper when myCarlos lets go of it.
mod confine {
    #[cfg(all(unix, desktop))]
    pub(super) fn this_process() -> std::io::Result<()> {
        fn limit(resource: libc::c_int, value: libc::rlim_t) -> std::io::Result<()> {
            let limit = libc::rlimit {
                rlim_cur: value,
                rlim_max: value,
            };
            // SAFETY: setrlimit only reads the struct passed by reference.
            if unsafe { libc::setrlimit(resource as _, &limit) } == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        }
        close_inherited()?;
        #[cfg(target_os = "linux")]
        // SAFETY: plain prctl calls with constant arguments.
        unsafe {
            // Nothing it starts could gain privileges, and it cannot be traced or dumped.
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
        limit(libc::RLIMIT_CORE as libc::c_int, 0)?;
        limit(libc::RLIMIT_FSIZE as libc::c_int, 0)?;
        // No new process or thread (the helper uses one thread). Root is exempt; myCarlos
        // does not run as root.
        limit(libc::RLIMIT_NPROC as libc::c_int, 0)?;
        // Stdin, stdout and stderr stay open; nothing else can be: no file, socket or pipe.
        limit(libc::RLIMIT_NOFILE as libc::c_int, 3)
    }

    /// Closes every descriptor above stderr that the helper may have been given.
    #[cfg(all(unix, desktop))]
    fn close_inherited() -> std::io::Result<()> {
        #[cfg(target_os = "linux")]
        {
            // SAFETY: close_range only closes descriptors; none above 2 is in use here.
            if unsafe { libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32) } == 0 {
                return Ok(());
            }
        }
        // SAFETY: getdtablesize has no arguments; closing an unused descriptor is harmless.
        let highest = unsafe { libc::getdtablesize() }.clamp(3, 65_536);
        for descriptor in 3..highest {
            unsafe { libc::close(descriptor) };
        }
        Ok(())
    }

    #[cfg(windows)]
    pub(super) fn this_process() -> std::io::Result<()> {
        // Confined from outside, by the job object `after_start` puts it in.
        Ok(())
    }

    #[cfg(all(unix, desktop))]
    pub(super) fn before_start(command: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;
        let cpu_seconds = super::HELPER_TIME_LIMIT.as_secs() as libc::rlim_t;
        let data = super::HELPER_MEMORY_LIMIT as libc::rlim_t;
        // SAFETY: only setpgid and setrlimit, which are async-signal-safe, run between fork
        // and exec.
        unsafe {
            command.pre_exec(move || {
                // Its own process group, so that stopping it stops anything it started.
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                for (resource, value) in [
                    (libc::RLIMIT_CPU, cpu_seconds),
                    (libc::RLIMIT_DATA, data),
                    (libc::RLIMIT_CORE, 0),
                ] {
                    let limit = libc::rlimit {
                        rlim_cur: value,
                        rlim_max: value,
                    };
                    if libc::setrlimit(resource as _, &limit) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }

    /// Stops the helper and anything it started: its whole process group.
    #[cfg(all(unix, desktop))]
    pub(super) fn stop(child: &mut std::process::Child) {
        if let Ok(group) = libc::pid_t::try_from(child.id()) {
            // SAFETY: the group is the helper's own, made by setpgid before it started.
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Stops the helper; the job object allows it no child process.
    #[cfg(windows)]
    pub(super) fn stop(child: &mut std::process::Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Nothing to hold on Unix: the limits were set before the helper started.
    #[cfg(all(unix, desktop))]
    pub(super) struct Job;

    #[cfg(all(unix, desktop))]
    pub(super) fn after_start(_child: &std::process::Child) -> std::io::Result<Job> {
        Ok(Job)
    }

    #[cfg(windows)]
    pub(super) fn before_start(command: &mut std::process::Command) {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    /// Closed when dropped, which ends the helper if it is still running.
    #[cfg(windows)]
    pub(super) struct Job(windows::Win32::Foundation::HANDLE);

    #[cfg(windows)]
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateJobObjectW and is closed once.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }

    #[cfg(windows)]
    pub(super) fn after_start(child: &std::process::Child) -> std::io::Result<Job> {
        use std::os::windows::io::AsRawHandle;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        };
        let to_io = |error: windows::core::Error| std::io::Error::other(error);
        // SAFETY: the job handle is owned by `Job`; the information struct outlives the call;
        // the process handle is the live child's.
        unsafe {
            let job = Job(CreateJobObjectW(None, PCWSTR::null()).map_err(to_io)?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            limits.ProcessMemoryLimit = super::HELPER_MEMORY_LIMIT as usize;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(to_io)?;
            AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())).map_err(to_io)?;
            Ok(job)
        }
    }

    /// Phones never start the helper (`unlock_in_helper` is `Unavailable` there).
    #[cfg(mobile)]
    pub(super) fn this_process() -> std::io::Result<()> {
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWORD: &str = "FAKE-portal-2026";
    const NON_ASCII: &str = "FAKE-mot-de-passe-éàç-Łódź-日本";

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/locked-pdf")
                .join(name),
        )
        .unwrap()
    }

    /// The page text and each page's content, which decide what is drawn.
    fn pages(pdf: &[u8]) -> (String, Vec<Vec<u8>>) {
        let document = lopdf::Document::load_mem(pdf).unwrap();
        assert!(!document.is_encrypted());
        let numbers: Vec<u32> = document.get_pages().keys().copied().collect();
        (
            document.extract_text(&numbers).unwrap(),
            document
                .get_pages()
                .values()
                .map(|id| document.get_page_content(*id))
                .collect(),
        )
    }

    #[test]
    fn unlocks_what_carlos_sends_and_keeps_every_page_as_it_was() {
        for (locked, original, password) in [
            ("text-aes256.pdf", "text-original.pdf", PASSWORD),
            ("image-aes256.pdf", "image-original.pdf", PASSWORD),
            ("form-aes256.pdf", "form-original.pdf", PASSWORD),
            ("eform-aes256.pdf", "eform-original.pdf", PASSWORD),
            ("text-aes256-non-ascii.pdf", "text-original.pdf", NON_ASCII),
            ("text-aes128.pdf", "text-original.pdf", PASSWORD),
            ("text-rc4-128.pdf", "text-original.pdf", PASSWORD),
            ("text-rc4-40.pdf", "text-original.pdf", PASSWORD),
        ] {
            let unlocked = unlock(&fixture(locked), password).unwrap();
            assert!(
                !unlocked.windows(8).any(|window| window == b"/Encrypt"),
                "{locked} still names an /Encrypt dictionary"
            );
            assert_eq!(pages(&unlocked), pages(&fixture(original)), "{locked}");
        }
    }

    #[test]
    fn tells_a_wrong_or_missing_password_from_a_damaged_or_plain_file() {
        let locked = fixture("text-aes256.pdf");
        assert_eq!(
            unlock(&locked, "FAKE-wrong").unwrap_err(),
            Refusal::WrongPassword
        );
        assert_eq!(unlock(&locked, "").unwrap_err(), Refusal::WrongPassword);
        // A password differing only in normalization or case is still wrong.
        assert_eq!(
            unlock(
                &fixture("text-aes256-non-ascii.pdf"),
                &NON_ASCII.to_uppercase()
            )
            .unwrap_err(),
            Refusal::WrongPassword
        );
        assert_eq!(
            unlock(&fixture("text-aes256-damaged.pdf"), PASSWORD).unwrap_err(),
            Refusal::Damaged
        );
        assert_eq!(
            unlock(&fixture("text-original.pdf"), PASSWORD).unwrap_err(),
            Refusal::NotEncrypted
        );
        assert_eq!(
            unlock(b"not a pdf", PASSWORD).unwrap_err(),
            Refusal::Damaged
        );
    }

    #[test]
    fn refuses_a_document_over_the_limit_before_parsing_it() {
        let oversized = vec![b' '; MAX_LOCKED_PDF_BYTES + 1];
        assert_eq!(unlock(&oversized, PASSWORD).unwrap_err(), Refusal::TooLarge);
        assert_eq!(
            read_limited(&oversized[..]).unwrap().unwrap_err(),
            Refusal::TooLarge
        );
        assert_eq!(
            read_limited(&oversized[..MAX_LOCKED_PDF_BYTES])
                .unwrap()
                .unwrap()
                .len(),
            MAX_LOCKED_PDF_BYTES
        );
    }

    #[test]
    fn finds_the_encrypt_marker_even_split_between_reads() {
        struct Trickle<'a>(&'a [u8]);
        impl Read for Trickle<'_> {
            fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
                let count = self.0.len().min(out.len()).min(3);
                out[..count].copy_from_slice(&self.0[..count]);
                self.0 = &self.0[count..];
                Ok(count)
            }
        }
        assert!(may_be_locked(&fixture("text-aes256.pdf")[..]).unwrap());
        assert!(may_be_locked(Trickle(&fixture("text-rc4-40.pdf"))).unwrap());
        assert!(!may_be_locked(&fixture("text-original.pdf")[..]).unwrap());
        assert!(!may_be_locked(Trickle(&fixture("form-original.pdf"))).unwrap());
        let mut padded = vec![b'x'; 64 * 1024 - 3];
        padded.extend_from_slice(b"/Encrypt 5 0 R");
        assert!(may_be_locked(&padded[..]).unwrap());
    }

    #[cfg(all(unix, desktop))]
    fn shell(script: &str) -> std::process::Command {
        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn stops_a_helper_that_runs_too_long() {
        let started = std::time::Instant::now();
        let outcome = run_helper(
            shell("sleep 20"),
            b"%PDF-1.7 FAKE",
            PASSWORD,
            Duration::from_millis(300),
        );
        assert!(matches!(outcome, Outcome::Failed));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn takes_only_a_whole_answer_from_a_helper_that_ended_well() {
        const REFUSAL: &str = r"MCPDFRS1\001\000\000\000\000\000\000\000\000";
        for script in [
            "cat >/dev/null; printf 'not an answer'".to_owned(),
            format!("cat >/dev/null; printf '{REFUSAL}'; exit 1"),
            "exit 0".to_owned(),
        ] {
            let outcome = run_helper(
                shell(&script),
                b"%PDF-1.7 FAKE",
                PASSWORD,
                HELPER_TIME_LIMIT,
            );
            assert!(matches!(outcome, Outcome::Failed), "{script}");
        }
        let outcome = run_helper(
            shell(&format!("cat >/dev/null; printf '{REFUSAL}'")),
            b"%PDF-1.7 FAKE",
            PASSWORD,
            HELPER_TIME_LIMIT,
        );
        assert!(matches!(outcome, Outcome::Refused(Refusal::WrongPassword)));
        // Too large to send: refused before any helper starts.
        let outcome = run_helper(
            shell("exit 1"),
            &vec![0; MAX_LOCKED_PDF_BYTES + 1],
            PASSWORD,
            HELPER_TIME_LIMIT,
        );
        assert!(matches!(outcome, Outcome::Refused(Refusal::TooLarge)));
    }

    /// Run in its own process by the test below: confines itself as the helper does, then
    /// tries what a hostile document would want.
    #[cfg(all(unix, desktop))]
    #[test]
    #[ignore = "invoked as a subprocess by the helper confinement test"]
    fn confinement_child() {
        use std::os::fd::AsRawFd;
        let locked = fixture("text-aes256.pdf");
        let kept = std::fs::File::open(env!("CARGO_MANIFEST_DIR")).unwrap();
        confine::this_process().unwrap();
        // Descriptors it was given are closed.
        assert_eq!(unsafe { libc::fcntl(kept.as_raw_fd(), libc::F_GETFD) }, -1);
        std::mem::forget(kept);
        // No file can be opened, for reading or writing, and no socket or pipe.
        assert!(std::fs::File::open(env!("CARGO_MANIFEST_DIR")).is_err());
        assert!(std::fs::File::create(std::env::temp_dir().join("mycarlos-helper-probe")).is_err());
        assert!(std::net::TcpStream::connect(("127.0.0.1", 9)).is_err());
        assert!(std::net::UdpSocket::bind(("127.0.0.1", 0)).is_err());
        let mut pipe = [0; 2];
        assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, -1);
        // Unlocking still works: it needs only memory.
        assert!(unlock(&locked, PASSWORD).is_ok());
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn the_helper_cannot_open_files_or_sockets() {
        // Through pipes: no file may grow in there, and a test failure is written out.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "pdf_unlock::tests::confinement_child",
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn the_protocol_carries_a_request_and_each_answer() {
        let mut request = Vec::new();
        write_request(&mut request, NON_ASCII.as_bytes(), b"%PDF-1.7 FAKE").unwrap();
        match read_request(&mut &request[..]).unwrap() {
            Request::Read { password, pdf } => {
                assert_eq!(password.as_str(), NON_ASCII);
                assert_eq!(pdf, b"%PDF-1.7 FAKE");
            }
            _ => panic!("the request was not read"),
        }
        for answer in [
            Ok(Zeroizing::new(b"%PDF-1.7 unlocked".to_vec())),
            Err(Refusal::WrongPassword),
            Err(Refusal::NotEncrypted),
            Err(Refusal::Damaged),
            Err(Refusal::TooLarge),
            Err(Refusal::Unsupported),
        ] {
            let mut response = Vec::new();
            write_response(&mut response, &answer).unwrap();
            let read = read_response(&mut &response[..]).unwrap();
            assert_eq!(
                read.as_ref().map(|bytes| bytes.to_vec()),
                answer.as_ref().map(|bytes| bytes.to_vec())
            );
            // Cut short, or with anything after it: not an answer.
            assert!(read_response(&mut &response[..response.len() - 1]).is_none());
            let mut longer = response.clone();
            longer.push(0);
            if answer.is_ok() {
                assert!(read_response(&mut &longer[..]).is_none());
            }
        }
        assert!(read_response(&mut &b"MCPDFRS1\x09\0\0\0\0\0\0\0\0"[..]).is_none());
        let mut huge = b"MCPDFRQ1".to_vec();
        huge.extend_from_slice(&0u32.to_le_bytes());
        huge.extend_from_slice(&(MAX_LOCKED_PDF_BYTES as u64 + 1).to_le_bytes());
        assert!(matches!(
            read_request(&mut &huge[..]).unwrap(),
            Request::TooLarge
        ));
        let mut long_password = b"MCPDFRQ1".to_vec();
        long_password.extend_from_slice(&(MAX_PASSWORD_BYTES as u32 + 1).to_le_bytes());
        assert!(matches!(
            read_request(&mut &long_password[..]).unwrap(),
            Request::Malformed
        ));
    }
}
