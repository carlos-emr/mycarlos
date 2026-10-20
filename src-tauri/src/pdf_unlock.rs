//! Opening a password-protected PDF once, at import (#54).
//!
//! Decrypting means parsing a PDF from an untrusted sender, so it never happens in the process
//! that holds vault keys (THREAT_MODEL IMP-02). The app starts its own executable again with
//! `HELPER_ARG`: a fresh process with no vault, keys or window. It limits itself, reads one
//! document and its password from stdin, writes the document without its password to stdout,
//! and exits. Only the unlocked copy is kept, in the vault; the password is never stored.
//!
//! What protects the vault keys is that they are in another process, which other processes of
//! the user cannot read (`protect_process_memory`; on Windows the helper runs at low
//! integrity). The helper's limits (see `confine`) bound what a malformed document costs and
//! stop the helper's own code from opening files or connections. They are not a sandbox:
//! code that took over the helper could get around them. A real sandbox (seccomp and Landlock,
//! AppContainer, the App Sandbox) is a separate step.
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
/// The memory the helper may use: a data limit on Linux, a job limit on Windows, and on macOS
/// its footprint as myCarlos checks it (`confine::over_memory`).
#[cfg(desktop)]
const HELPER_MEMORY_LIMIT: u64 = 1 << 30;
/// The first argument that starts the executable as the helper.
pub const HELPER_ARG: &str = "--mycarlos-pdf-helper";
/// The longest password accepted, in UTF-8 bytes. PDF passwords are far shorter.
const MAX_PASSWORD_BYTES: usize = 4096;

const REQUEST_MAGIC: &[u8; 8] = b"MCPDFRQ1";
pub(crate) const RESPONSE_MAGIC: &[u8; 8] = b"MCPDFRS1";
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
    /// The page asked for is not in it.
    NoSuchPage,
}

impl Refusal {
    pub(crate) fn code(self) -> u8 {
        match self {
            Refusal::WrongPassword => 1,
            Refusal::NotEncrypted => 2,
            Refusal::Damaged => 3,
            Refusal::TooLarge => 4,
            Refusal::Unsupported => 5,
            Refusal::NoSuchPage => 6,
        }
    }

    pub(crate) fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            1 => Refusal::WrongPassword,
            2 => Refusal::NotEncrypted,
            3 => Refusal::Damaged,
            4 => Refusal::TooLarge,
            5 => Refusal::Unsupported,
            6 => Refusal::NoSuchPage,
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

/// Whether a document might be password-protected, as the vault writes it out (#54): its
/// trailer then names an `/Encrypt` dictionary. This reads PDF names and nothing else (`/` and
/// the name's characters, with `#hh` escapes decoded, so `/Encr#79pt` counts too). It parses no
/// object, so it is safe beside the vault keys. A match is only a hint; the helper decides. It
/// stops the export, with an error, at the first `/Encrypt`, so the rest is not decrypted.
#[derive(Default)]
pub(crate) struct LockScan {
    scanner: NameScanner,
    found: bool,
}

impl LockScan {
    /// Whether `/Encrypt` has been found so far.
    pub(crate) fn found(&self) -> bool {
        self.found
    }

    /// Whether the whole document named `/Encrypt`, once all of it was written.
    pub(crate) fn finish(mut self) -> bool {
        self.found || self.scanner.end_name()
    }
}

impl io::Write for LockScan {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if data.iter().any(|&byte| self.scanner.push(byte)) {
            self.found = true;
            return Err(io::Error::other("the document names /Encrypt"));
        }
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The scan of `LockScan` over a reader, for the tests.
#[cfg(test)]
fn may_be_locked(mut reader: impl Read) -> io::Result<bool> {
    let mut scan = LockScan::default();
    match io::copy(&mut reader, &mut scan) {
        Err(_) if scan.found() => Ok(true),
        Err(error) => Err(error),
        Ok(_) => Ok(scan.finish()),
    }
}

/// Reads PDF names out of a byte stream, one byte at a time, decoding `#hh` escapes, and tells
/// when a name `Encrypt` ends. Names longer than `NAME_LIMIT` bytes are not kept.
#[derive(Default)]
struct NameScanner {
    name: [u8; NAME_LIMIT],
    length: usize,
    in_name: bool,
    too_long: bool,
    /// Hex digits read after `#`: the first one's value, if one has been.
    escape: Option<Option<u8>>,
}

const NAME_LIMIT: usize = 16;

impl NameScanner {
    /// Takes one byte; true when it ends the name `Encrypt`.
    fn push(&mut self, byte: u8) -> bool {
        let delimiter = byte.is_ascii_whitespace()
            || byte == 0
            || matches!(
                byte,
                b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
            );
        if delimiter {
            let ended = self.end_name();
            self.in_name = byte == b'/';
            return ended;
        }
        if !self.in_name {
            return false;
        }
        let digit = (byte as char).to_digit(16).map(|digit| digit as u8);
        match (self.escape, digit) {
            (None, _) if byte == b'#' => self.escape = Some(None),
            (None, _) => self.keep(byte),
            (Some(None), Some(high)) => self.escape = Some(Some(high)),
            (Some(Some(high)), Some(low)) => {
                self.escape = None;
                self.keep(high << 4 | low);
            }
            // Not an escape after all. Such a name is malformed; it cannot be `Encrypt`.
            (Some(_), None) => {
                self.escape = None;
                self.too_long = true;
            }
        }
        false
    }

    /// Ends the current name, if any; true when it was `Encrypt`.
    fn end_name(&mut self) -> bool {
        let matched = self.in_name
            && !self.too_long
            && self.escape.is_none()
            && &self.name[..self.length] == b"Encrypt";
        self.in_name = false;
        self.too_long = false;
        self.length = 0;
        self.escape = None;
        matched
    }

    fn keep(&mut self, byte: u8) {
        if self.length == NAME_LIMIT {
            self.too_long = true;
        } else {
            self.name[self.length] = byte;
            self.length += 1;
        }
    }
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
    write_password_and_pdf(out, password, pdf)
}

/// The body every request starts with: the password, then the document.
pub(crate) fn write_password_and_pdf(
    out: &mut impl Write,
    password: &[u8],
    pdf: &[u8],
) -> io::Result<()> {
    out.write_all(&(password.len() as u32).to_le_bytes())?;
    out.write_all(password)?;
    out.write_all(&(pdf.len() as u64).to_le_bytes())?;
    out.write_all(pdf)?;
    out.flush()
}

/// A request as the helper reads it, or why it could not be.
pub(crate) enum Request {
    Read {
        password: Zeroizing<String>,
        pdf: Vec<u8>,
    },
    TooLarge,
    Malformed,
}

#[cfg(test)]
fn read_request(input: &mut impl Read) -> io::Result<Request> {
    let mut magic = [0u8; 8];
    input.read_exact(&mut magic)?;
    if &magic != REQUEST_MAGIC {
        return Ok(Request::Malformed);
    }
    read_password_and_pdf(input)
}

/// Reads the body `write_password_and_pdf` wrote.
pub(crate) fn read_password_and_pdf(input: &mut impl Read) -> io::Result<Request> {
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

/// Keeps other processes of the same user, a taken-over PDF helper among them, from reading
/// this one's memory, where the vault keys are, and keeps those keys out of core dumps. On
/// Linux a process that is not dumpable cannot be traced or read by them. (On macOS reading
/// another process already needs privileges; on Windows the helper runs at low integrity.)
/// Called first in `main`.
pub fn protect_process_memory() {
    #[cfg(target_os = "linux")]
    // SAFETY: a plain prctl call with constant arguments.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
}

/// The helper: confines itself, answers one request on stdin and stdout, and returns the exit
/// code. Started by `main` when the first argument is `HELPER_ARG`.
pub fn helper_main() -> i32 {
    if confine::this_process().is_err() {
        return 2;
    }
    let mut input = io::stdin().lock();
    let mut magic = [0u8; 8];
    if input.read_exact(&mut magic).is_err() {
        return 3;
    }
    if &magic == crate::pdf_view::VIEW_MAGIC {
        return crate::pdf_view::answer(&mut input, &mut io::stdout().lock());
    }
    if &magic != REQUEST_MAGIC {
        return 3;
    }
    let result = match read_password_and_pdf(&mut input) {
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
        run_helper(
            helper_command(&executable),
            pdf,
            password,
            HELPER_TIME_LIMIT,
        )
    }
    #[cfg(mobile)]
    {
        let _ = (pdf, password);
        Outcome::Unavailable
    }
}

/// For tests/pdf_helper.rs only: `unlock_in_helper` with the helper at `executable`, so that
/// CI starts the real helper, limits it and reads its answer exactly as myCarlos does, on each
/// desktop system. It is no command, so nothing in the webview can reach it.
#[doc(hidden)]
#[cfg(desktop)]
pub fn unlock_with_helper_at(
    executable: &std::path::Path,
    pdf: &[u8],
    password: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    match run_helper(helper_command(executable), pdf, password, HELPER_TIME_LIMIT) {
        Outcome::Unlocked(unlocked) => Ok(unlocked),
        Outcome::Refused(refusal) => Err(format!("{refusal:?}")),
        Outcome::Failed | Outcome::Unavailable => Err("Failed".to_owned()),
    }
}

/// Starts `executable` as the helper: for unlocking, and for drawing pages (`pdf_view`).
#[cfg(desktop)]
pub(crate) fn helper_command(executable: &std::path::Path) -> std::process::Command {
    let mut command = std::process::Command::new(executable);
    command.arg(HELPER_ARG);
    command
}

/// Runs `command` as the helper: limited, given the request, stopped after `time_limit`.
#[cfg(desktop)]
pub(crate) fn run_helper(
    command: std::process::Command,
    pdf: &[u8],
    password: &str,
    time_limit: Duration,
) -> Outcome {
    if pdf.len() > MAX_LOCKED_PDF_BYTES {
        return Outcome::Refused(Refusal::TooLarge);
    }
    let mut request = Zeroizing::new(Vec::with_capacity(pdf.len() + password.len() + 20));
    if write_request(&mut *request, password.as_bytes(), pdf).is_err() {
        return Outcome::Failed;
    }
    match exchange(command, request, time_limit, read_response, &|| false) {
        Some(Ok(unlocked)) => Outcome::Unlocked(unlocked),
        Some(Err(refusal)) => Outcome::Refused(refusal),
        None => Outcome::Failed,
    }
}

/// Sends one `request` to the helper started by `command` and reads its answer with `read`,
/// all within `time_limit`. `None` when the helper could not be started, ran too long, failed,
/// answered wrongly, or `cancelled` came true meanwhile, which stops it at once. The request is
/// wiped once sent.
#[cfg(desktop)]
pub(crate) fn exchange<T: Send + 'static>(
    mut command: std::process::Command,
    request: Zeroizing<Vec<u8>>,
    time_limit: Duration,
    read: fn(&mut std::process::ChildStdout) -> Option<T>,
    cancelled: &dyn Fn() -> bool,
) -> Option<T> {
    use std::process::Stdio;
    use std::time::Instant;
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    confine::before_start(&mut command);
    let mut child = command.spawn().ok()?;
    // Held until the end: closing it stops the helper on Windows.
    let _job = match confine::after_start(&child) {
        Ok(job) => job,
        Err(_) => {
            confine::stop(&mut child);
            return None;
        }
    };
    let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
        confine::stop(&mut child);
        return None;
    };
    let deadline = Instant::now() + time_limit;
    // Written and read on threads of their own, holding their own copies: the helper may
    // answer before it has read everything, neither side may wait on a full pipe while the
    // clock runs, and nothing the helper leaves behind can keep myCarlos waiting.
    std::thread::spawn(move || {
        let _ = stdin.write_all(&request);
    });
    let (answered, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = answered.send(read(&mut stdout));
    });
    let exited = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None)
                if Instant::now() < deadline && !cancelled() && !confine::over_memory(&child) =>
            {
                std::thread::sleep(Duration::from_millis(20))
            }
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
    match exited {
        Some(status) if status.success() => answer,
        _ => None,
    }
}

/// The helper's limits. They bound what a malformed document can cost and stop the helper's
/// own code from opening a file or connection by mistake; they are not a sandbox against code
/// that has taken the helper over (for example, closing a descriptor frees a slot under
/// RLIMIT_NOFILE). Unix: descriptors it did not need are closed, a new one cannot be opened
/// while three are in use, no file can be written, no process started (unless run as root),
/// no core dumped, and CPU time and memory are capped (on macOS, which refuses a data limit,
/// myCarlos checks the helper's memory instead and stops it). Windows: it runs at low integrity,
/// so it cannot open myCarlos's process or write the user's files, and a job object caps its
/// memory, allows no child process, and ends it when myCarlos lets go. It can still read files
/// the user can read; there is no network block on Windows yet.
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

    /// Drops this process to low integrity before it reads anything: it can then open no
    /// process or file of normal integrity for writing, or any process for reading memory.
    /// The job object `after_start` puts it in does the rest.
    #[cfg(windows)]
    pub(super) fn this_process() -> std::io::Result<()> {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{
            CreateWellKnownSid, SetTokenInformation, TokenIntegrityLevel, WinLowLabelSid, PSID,
            SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_MANDATORY_LABEL,
            TOKEN_QUERY,
        };
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        // winnt.h's SE_GROUP_INTEGRITY, without the crate feature that names it.
        const SE_GROUP_INTEGRITY: u32 = 0x20;
        let to_io = |error: windows::core::Error| std::io::Error::other(error);
        // SAFETY: the token handle is closed below; the SID buffer outlives the call that
        // reads it; the label struct points into that buffer.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_ADJUST_DEFAULT | TOKEN_QUERY,
                &mut token,
            )
            .map_err(to_io)?;
            let mut sid = [0u8; SECURITY_MAX_SID_SIZE as usize];
            let mut sid_size = sid.len() as u32;
            let lowered = CreateWellKnownSid(
                WinLowLabelSid,
                None,
                Some(PSID(sid.as_mut_ptr().cast())),
                &mut sid_size,
            )
            .and_then(|()| {
                let label = TOKEN_MANDATORY_LABEL {
                    Label: SID_AND_ATTRIBUTES {
                        Sid: PSID(sid.as_mut_ptr().cast()),
                        Attributes: SE_GROUP_INTEGRITY,
                    },
                };
                SetTokenInformation(
                    token,
                    TokenIntegrityLevel,
                    &label as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + sid_size,
                )
            });
            let _ = CloseHandle(token);
            lowered.map_err(to_io)
        }
    }

    #[cfg(all(unix, desktop))]
    pub(super) fn before_start(command: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;
        let cpu_seconds = super::HELPER_TIME_LIMIT.as_secs() as libc::rlim_t;
        #[cfg(not(target_os = "macos"))]
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
                    // macOS refuses a data limit below the address space a process already
                    // has, which there includes the shared system libraries: hundreds of GB on
                    // Apple silicon. `over_memory` checks the helper's memory there instead.
                    #[cfg(not(target_os = "macos"))]
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

    /// Whether the helper uses more memory than it may, checked each time myCarlos looks at
    /// it while it runs (every 20 ms), so it may pass the limit briefly before it is stopped.
    /// macOS only: its footprint, the memory macOS counts against it. A footprint that cannot
    /// be read counts as over, so that the check cannot quietly stop working. It can always be
    /// read: the helper is myCarlos's own child, of the same user, and not yet waited for, and
    /// macOS answers for such a process even once it has exited.
    #[cfg(target_os = "macos")]
    pub(super) fn over_memory(child: &std::process::Child) -> bool {
        let Ok(pid) = libc::c_int::try_from(child.id()) else {
            return true;
        };
        let mut usage = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
        // SAFETY: the buffer is a rusage_info_v2, the flavour asked for, and is read only
        // after the call filled it.
        unsafe {
            libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V2, usage.as_mut_ptr().cast()) != 0
                || usage.assume_init().ri_phys_footprint > super::HELPER_MEMORY_LIMIT
        }
    }

    /// Elsewhere the limit was set before the helper started: a data limit, or the job.
    #[cfg(all(desktop, not(target_os = "macos")))]
    pub(super) fn over_memory(_child: &std::process::Child) -> bool {
        false
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
    }

    #[test]
    fn finds_the_encrypt_name_however_it_is_written_or_read() {
        for (text, expected) in [
            (&b"<< /Encrypt 5 0 R >>"[..], true),
            (b"<</Size 9/Encr#79pt 5 0 R>>", true),
            (b"<</#45#6e#63#72#79#70#74 5 0 R>>", true),
            (b"trailer<</Encrypt", true),
            (b"<< /EncryptMetadata false >>", false),
            (b"<< /Encrypted 5 0 R >>", false),
            (b"(Encrypt) Tj", false),
            (b"<< /Encr#7 9pt >>", false),
            (b"<< /Encr#zzypt >>", false),
        ] {
            assert_eq!(
                may_be_locked(text).unwrap(),
                expected,
                "{}",
                String::from_utf8_lossy(text)
            );
        }
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
        assert!(may_be_locked(Trickle(b"<</Size 9/Encr#79pt 5 0 R>>")).unwrap());
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
    fn stops_a_helper_as_soon_as_it_is_cancelled() {
        let started = std::time::Instant::now();
        let answer = exchange(
            shell("sleep 20"),
            Zeroizing::new(b"FAKE".to_vec()),
            HELPER_TIME_LIMIT,
            read_response,
            &|| started.elapsed() > Duration::from_millis(200),
        );
        assert!(answer.is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn takes_only_a_whole_answer_from_a_helper_that_ended_well() {
        // A refusal as the helper writes it, sent by the shell from a file: the bytes are
        // written here, not by the shell's printf, whose escapes differ between systems.
        let mut refusal = tempfile::NamedTempFile::new().unwrap();
        refusal.write_all(b"MCPDFRS1\x01\0\0\0\0\0\0\0\0").unwrap();
        let refusal = refusal.path().to_str().unwrap();
        assert!(!refusal.contains('\''), "{refusal}");
        for script in [
            "cat >/dev/null; printf 'not an answer'".to_owned(),
            format!("cat >/dev/null; cat '{refusal}'; exit 1"),
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
            shell(&format!("cat >/dev/null; cat '{refusal}'")),
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

    /// Takes `bytes` of memory, writing to each page so that it counts, then waits to be
    /// stopped. Run as the helper by the memory test below.
    #[cfg(all(unix, desktop))]
    fn take_memory_and_wait(bytes: usize) {
        const STEP: usize = 64 * 1024 * 1024;
        let mut held = Vec::new();
        for _ in 0..bytes.div_ceil(STEP) {
            let mut step = vec![0u8; STEP];
            for page in step.chunks_mut(4096) {
                page[0] = 1;
            }
            held.push(std::hint::black_box(step));
        }
        std::thread::sleep(Duration::from_secs(60));
        std::hint::black_box(&held);
    }

    #[cfg(all(unix, desktop))]
    #[test]
    #[ignore = "invoked as a subprocess by the helper memory test"]
    fn growing_child() {
        take_memory_and_wait(HELPER_MEMORY_LIMIT as usize + 256 * 1024 * 1024);
    }

    #[cfg(all(unix, desktop))]
    #[test]
    #[ignore = "invoked as a subprocess by the helper memory test"]
    fn small_child() {
        take_memory_and_wait(256 * 1024 * 1024);
    }

    /// This test binary, to be started as the helper, running only the ignored test `name`.
    #[cfg(all(unix, desktop))]
    fn helper_running(name: &str) -> std::process::Command {
        let test = format!("pdf_unlock::tests::{name}");
        let child = ["--ignored", "--exact", test.as_str()];
        // A name that matched no test would run nothing, and end at once.
        let listed = std::process::Command::new(std::env::current_exe().unwrap())
            .args(child)
            .arg("--list")
            .output()
            .unwrap();
        let listing = format!("{test}: test");
        assert!(String::from_utf8_lossy(&listed.stdout)
            .lines()
            .any(|line| line == listing));
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(child);
        command
    }

    #[cfg(all(unix, desktop))]
    #[test]
    fn stops_a_helper_that_grows_past_its_memory_limit() {
        // Each is started as myCarlos starts the helper. First one well under the limit: it
        // lives until its time limit, so the child really runs as the helper, and the memory
        // check does not stop it early.
        let command = helper_running("small_child");
        let started = std::time::Instant::now();
        let outcome = run_helper(command, b"%PDF-1.7 FAKE", PASSWORD, Duration::from_secs(2));
        assert!(matches!(outcome, Outcome::Failed));
        let elapsed = started.elapsed();
        assert!(elapsed >= Duration::from_secs(2), "{elapsed:?}");
        // Then one that grows past it. Linux refuses it the memory (its data limit); macOS has
        // no such limit, so myCarlos sees the footprint and stops it. Either way well before
        // the time limit.
        let command = helper_running("growing_child");
        let started = std::time::Instant::now();
        let outcome = run_helper(command, b"%PDF-1.7 FAKE", PASSWORD, HELPER_TIME_LIMIT);
        assert!(matches!(outcome, Outcome::Failed));
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(15), "{elapsed:?}");
    }

    /// Run in its own process by the test below: limits itself as the helper does, then tries
    /// the opens the limits are meant to stop.
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
    fn the_limited_helper_opens_no_file_or_socket() {
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

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "invoked as a subprocess by the process memory test"]
    fn protected_child() {
        protect_process_memory();
        assert_eq!(unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) }, 0);
        // A confined helper of the same user cannot read this process's memory. Root may,
        // so that part runs only for an ordinary user, as myCarlos does.
        if unsafe { libc::geteuid() } != 0 {
            let parent = std::process::id();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", "pdf_unlock::tests::reader_child"])
                .env("MYCARLOS_TEST_PARENT", parent.to_string())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "invoked as a subprocess by protected_child"]
    fn reader_child() {
        let parent: libc::pid_t = std::env::var("MYCARLOS_TEST_PARENT")
            .unwrap()
            .parse()
            .unwrap();
        confine::this_process().unwrap();
        let mut byte = 0u8;
        let local = libc::iovec {
            iov_base: (&mut byte as *mut u8).cast(),
            iov_len: 1,
        };
        // Any address: the call is refused before it is looked at.
        let remote = libc::iovec {
            iov_base: 0x1000 as *mut libc::c_void,
            iov_len: 1,
        };
        let read = unsafe { libc::process_vm_readv(parent, &local, 1, &remote, 1, 0) };
        assert_eq!(read, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        );
        let none = std::ptr::null_mut::<libc::c_void>();
        assert_eq!(
            unsafe { libc::ptrace(libc::PTRACE_ATTACH, parent, none, none) },
            -1
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn mycarlos_is_not_dumpable_and_a_helper_cannot_read_it() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "pdf_unlock::tests::protected_child"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Windows CI runs this: at low integrity, the helper cannot open myCarlos to read it.
    #[cfg(windows)]
    #[test]
    #[ignore = "invoked as a subprocess by the low integrity test"]
    fn low_integrity_child() {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_VM_READ};
        let parent: u32 = std::env::var("MYCARLOS_TEST_PARENT")
            .unwrap()
            .parse()
            .unwrap();
        confine::this_process().unwrap();
        // SAFETY: OpenProcess only returns a handle or an error.
        assert!(unsafe { OpenProcess(PROCESS_VM_READ, false, parent) }.is_err());
        assert!(std::fs::File::create(std::env::temp_dir().join("mycarlos-helper-probe")).is_err());
        assert!(unlock(&fixture("text-aes256.pdf"), PASSWORD).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_low_integrity_helper_cannot_read_mycarlos() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "pdf_unlock::tests::low_integrity_child",
            ])
            .env("MYCARLOS_TEST_PARENT", std::process::id().to_string())
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
