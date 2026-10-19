//! Opening a password-protected PDF once, at import (#54).
//!
//! Decrypting means parsing a PDF from an untrusted sender, so it never happens in the process
//! that holds vault keys (THREAT_MODEL IMP-02). The app starts its own executable again with
//! `HELPER_ARG`: a fresh process with no vault, keys or window. It limits itself, reads one
//! document and its password from stdin, writes the document without its password to stdout,
//! and exits. Only the unlocked copy is kept, in the vault; the password is never stored.
//!
//! What protects the vault keys is that they are in another process, which other processes of
//! the user cannot read (`protect_process_memory`; on Windows the helper runs in an
//! AppContainer, at low integrity). The helper is also sandboxed before it reads anything (see
//! `confine`, #63): code that took it over could open no file, connection or program. Its
//! limits bound what a malformed document costs. If the sandbox cannot be set up, the helper
//! reads nothing (`Outcome::NoSandbox`).
//!
//! The limits and the sandbox are all here, so that they are easy to review and change.

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
/// The helper's exit code when it could not sandbox itself, and so read nothing.
const NO_SANDBOX: i32 = 2;
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
    /// The helper could not be sandboxed on this system, so it was given nothing to read.
    NoSandbox,
}

/// Whether a document might be password-protected: its trailer then names an `/Encrypt`
/// dictionary. This reads PDF names and nothing else (`/` and the name's characters, with
/// `#hh` escapes decoded, so `/Encr#79pt` counts too). It parses no object, so it is safe
/// beside the vault keys. A match is only a hint; the helper decides.
pub(crate) fn may_be_locked(mut reader: impl Read) -> io::Result<bool> {
    let mut scanner = NameScanner::default();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => return Ok(scanner.end_name()),
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if buffer[..read].iter().any(|&byte| scanner.push(byte)) {
            return Ok(true);
        }
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
/// another process already needs privileges; on Windows the helper runs in an AppContainer, at
/// low integrity.)
/// Called first in `main`.
pub fn protect_process_memory() {
    #[cfg(target_os = "linux")]
    // SAFETY: a plain prctl call with constant arguments.
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
}

/// The helper: sandboxes itself, answers one request on stdin and stdout, and returns the exit
/// code. Started by `main` when the first argument is `HELPER_ARG`.
pub fn helper_main() -> i32 {
    if confine::this_process().is_err() {
        return NO_SANDBOX;
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
        Outcome::NoSandbox => Err("NoSandbox".to_owned()),
        Outcome::Failed | Outcome::Unavailable => Err("Failed".to_owned()),
    }
}

/// For tests/pdf_helper.rs only: starts the helper at `executable` as myCarlos does (sandboxed,
/// limited), sends `request` as it is, and returns its exit code and everything it wrote.
/// `None` for the code when it could not be started.
#[doc(hidden)]
#[cfg(desktop)]
pub fn ask_helper_at(executable: &std::path::Path, request: &[u8]) -> (Option<i32>, Vec<u8>) {
    let mut command = helper_command(executable);
    command.env_clear();
    talk(command, request.to_vec()).unwrap_or_default()
}

/// Starts `command` as the helper, sends it `request`, and waits for it to end: its exit code
/// and all it wrote. For tests, which want to see what failed; myCarlos uses `exchange`.
#[cfg(desktop)]
fn talk(
    command: std::process::Command,
    request: Vec<u8>,
) -> Result<(Option<i32>, Vec<u8>), Unanswered> {
    let (mut helper, mut input, mut output) = confine::start(command)?;
    let writer = std::thread::spawn(move || {
        let _ = input.write_all(&request);
    });
    let mut written = Vec::new();
    let _ = output.read_to_end(&mut written);
    let _ = writer.join();
    Ok((helper.wait(), written))
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
        Ok(Ok(unlocked)) => Outcome::Unlocked(unlocked),
        Ok(Err(refusal)) => Outcome::Refused(refusal),
        Err(Unanswered::NoSandbox) => Outcome::NoSandbox,
        Err(Unanswered::Failed) => Outcome::Failed,
    }
}

/// Why the helper gave no answer.
#[cfg(desktop)]
#[derive(Debug)]
pub(crate) enum Unanswered {
    /// It could not be started, ran too long or out of memory, was cancelled, failed, or
    /// answered wrongly.
    Failed,
    /// It could not be sandboxed on this system: it read nothing (`NO_SANDBOX`), or, on
    /// Windows, it was not started.
    NoSandbox,
}

/// Sends one `request` to the helper started by `command` and reads its answer with `read`,
/// all within `time_limit`. `Failed` when the helper could not be started, ran too long, failed,
/// answered wrongly, or `cancelled` came true meanwhile, which stops it at once; `NoSandbox`
/// when it could not be sandboxed. The request is wiped once sent.
#[cfg(desktop)]
pub(crate) fn exchange<T: Send + 'static>(
    mut command: std::process::Command,
    request: Zeroizing<Vec<u8>>,
    time_limit: Duration,
    read: fn(&mut io::PipeReader) -> Option<T>,
    cancelled: &dyn Fn() -> bool,
) -> Result<T, Unanswered> {
    use std::time::Instant;
    command.env_clear();
    let (mut helper, mut input, mut output) = confine::start(command)?;
    let deadline = Instant::now() + time_limit;
    // Written and read on threads of their own, holding their own copies: the helper may
    // answer before it has read everything, neither side may wait on a full pipe while the
    // clock runs, and nothing the helper leaves behind can keep myCarlos waiting.
    std::thread::spawn(move || {
        let _ = input.write_all(&request);
    });
    let (answered, answer) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = answered.send(read(&mut output));
    });
    let exited = loop {
        match helper.try_wait() {
            Ok(Some(code)) => break Some(code),
            Ok(None) if Instant::now() < deadline && !cancelled() && !helper.over_memory() => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                helper.stop();
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
        (Some(0), Some(answer)) => Ok(answer),
        (Some(NO_SANDBOX), _) => Err(Unanswered::NoSandbox),
        _ => Err(Unanswered::Failed),
    }
}

/// The helper's sandbox and limits (#63). Whatever takes over the helper while it reads a
/// document can open no file, connection or program, and its limits bound what a malformed
/// document can cost. If the sandbox cannot be set up, the helper reads nothing.
///
/// - Linux: the helper closes the descriptors it was given, cannot gain privileges or be
///   traced, can write no file, start no process or thread, dump no core, and has a CPU time
///   and memory limit. Landlock then denies it every file and network access the kernel knows
///   (where the kernel has Landlock), it can hold no descriptor beyond stdin, stdout and
///   stderr, and last a seccomp filter allows only the calls it needs to read its request, use
///   memory and write its answer. Any other call fails. Without seccomp it reads nothing.
/// - macOS: the same limits, except memory, which myCarlos watches instead and stops it over
///   (`Helper::over_memory`), and `sandbox_init` with a profile that allows nothing.
/// - Windows: myCarlos starts it in an AppContainer with no capabilities (no network, no user
///   files, low integrity), handing it only its two pipes, and puts it in a job object before
///   it runs: the job caps its memory, allows no other process, and ends it when myCarlos lets
///   go. The helper checks it is in the AppContainer before it reads anything.
mod confine {
    #[cfg(desktop)]
    use super::Unanswered;
    use std::io;

    #[cfg(all(unix, desktop))]
    pub(super) fn this_process() -> io::Result<()> {
        close_inherited()?;
        #[cfg(target_os = "linux")]
        // SAFETY: plain prctl calls with constant arguments.
        unsafe {
            // Nothing it starts could gain privileges, and it cannot be traced or dumped.
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                || libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        limit(libc::RLIMIT_CORE as libc::c_int, 0)?;
        limit(libc::RLIMIT_FSIZE as libc::c_int, 0)?;
        // No new process or thread (the helper uses one thread). Root is exempt; myCarlos
        // does not run as root.
        limit(libc::RLIMIT_NPROC as libc::c_int, 0)?;
        // Setting these up takes a descriptor, so they come before the descriptor limit.
        #[cfg(target_os = "linux")]
        let _ = landlock();
        #[cfg(target_os = "macos")]
        sandbox()?;
        // Stdin, stdout and stderr stay open; nothing else can be: no file, socket or pipe.
        limit(libc::RLIMIT_NOFILE as libc::c_int, 3)?;
        // Last: it refuses the calls the steps above make.
        #[cfg(target_os = "linux")]
        seccomp()?;
        Ok(())
    }

    #[cfg(all(unix, desktop))]
    fn limit(resource: libc::c_int, value: libc::rlim_t) -> io::Result<()> {
        let limit = libc::rlimit {
            rlim_cur: value,
            rlim_max: value,
        };
        // SAFETY: setrlimit only reads the struct passed by reference.
        if unsafe { libc::setrlimit(resource as _, &limit) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Closes every descriptor above stderr that the helper may have been given.
    #[cfg(all(unix, desktop))]
    fn close_inherited() -> io::Result<()> {
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

    /// Denies this thread every file and network access the kernel's Landlock can deny, and
    /// signals and abstract sockets beyond itself: no rule allows any of them anywhere. A
    /// kernel without Landlock enforces nothing here; seccomp still holds. Returns what was
    /// enforced, for tests.
    #[cfg(target_os = "linux")]
    pub(super) fn landlock() -> Result<landlock::RestrictionStatus, landlock::RulesetError> {
        use landlock::{Access, AccessFs, AccessNet, Ruleset, RulesetAttr, Scope, ABI};
        // Every right this crate knows; an older kernel enforces the ones it has.
        let abi = ABI::V9;
        Ruleset::default()
            .handle_access(AccessFs::from_all(abi))?
            .handle_access(AccessNet::from_all(abi))?
            .scope(Scope::from_all(abi))?
            .create()?
            .restrict_self()
    }

    /// Allows this thread, the helper's only one, just the calls it needs once it holds its
    /// pipes: reading stdin, writing stdout and stderr, memory that is never executable,
    /// waiting on its own locks, and ending (`abort` included). Any other call fails with
    /// EPERM: no file, socket, pipe or program, no signal to another process, and no change to
    /// its limits or sandbox. Built for x86_64 and aarch64 only: elsewhere it cannot be, and
    /// the helper does not run.
    #[cfg(target_os = "linux")]
    pub(super) fn seccomp() -> io::Result<()> {
        use seccompiler::SeccompCmpArgLen::Dword;
        use seccompiler::SeccompCmpOp::{Eq, MaskedEq};
        use seccompiler::{
            BpfProgram, SeccompAction, SeccompCondition, SeccompFilter, SeccompRule, TargetArch,
        };
        #[cfg(target_arch = "x86_64")]
        const ARCH: Option<TargetArch> = Some(TargetArch::x86_64);
        #[cfg(target_arch = "aarch64")]
        const ARCH: Option<TargetArch> = Some(TargetArch::aarch64);
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        const ARCH: Option<TargetArch> = None;
        let arch = ARCH.ok_or(io::ErrorKind::Unsupported)?;
        // Allowed when argument `arg` is `value`.
        let when = |arg: u8, value: u64| {
            SeccompCondition::new(arg, Dword, Eq, value)
                .and_then(|condition| SeccompRule::new(vec![condition]))
                .map_err(io::Error::other)
        };
        // Memory that is never executable: `prot`, the third argument, without PROT_EXEC.
        let not_executable = || {
            SeccompCondition::new(2, Dword, MaskedEq(libc::PROT_EXEC as u64), 0)
                .and_then(|condition| SeccompRule::new(vec![condition]))
                .map_err(io::Error::other)
        };
        // SAFETY: plain calls without arguments.
        let (process, thread) = unsafe { (libc::getpid(), libc::gettid()) };
        // abort() signals this thread, and nothing else may be signalled.
        let to_itself = SeccompRule::new(vec![
            SeccompCondition::new(0, Dword, Eq, process as u64).map_err(io::Error::other)?,
            SeccompCondition::new(1, Dword, Eq, thread as u64).map_err(io::Error::other)?,
        ])
        .map_err(io::Error::other)?;
        let rules = [
            (libc::SYS_read, vec![when(0, 0)?]),
            (libc::SYS_write, vec![when(0, 1)?, when(0, 2)?]),
            (libc::SYS_writev, vec![when(0, 1)?, when(0, 2)?]),
            (libc::SYS_brk, vec![]),
            (libc::SYS_mmap, vec![not_executable()?]),
            (libc::SYS_mprotect, vec![not_executable()?]),
            (libc::SYS_munmap, vec![]),
            (libc::SYS_mremap, vec![]),
            (libc::SYS_madvise, vec![]),
            (libc::SYS_futex, vec![]),
            (libc::SYS_sched_yield, vec![]),
            (libc::SYS_getrandom, vec![]),
            (libc::SYS_clock_gettime, vec![]),
            (libc::SYS_rt_sigreturn, vec![]),
            (libc::SYS_rt_sigprocmask, vec![]),
            (libc::SYS_rt_sigaction, vec![]),
            (libc::SYS_sigaltstack, vec![]),
            (libc::SYS_getpid, vec![]),
            (libc::SYS_gettid, vec![]),
            (libc::SYS_tgkill, vec![to_itself]),
            (libc::SYS_exit, vec![]),
            (libc::SYS_exit_group, vec![]),
        ]
        .into_iter()
        .collect();
        let filter = SeccompFilter::new(
            rules,
            SeccompAction::Errno(libc::EPERM as u32),
            SeccompAction::Allow,
            arch,
        )
        .map_err(io::Error::other)?;
        let program = BpfProgram::try_from(filter).map_err(io::Error::other)?;
        seccompiler::apply_filter(&program).map_err(io::Error::other)
    }

    /// Puts this process in a sandbox that allows it nothing: no file, network, process or
    /// system service. It keeps what it already holds: its pipes and its memory.
    /// `sandbox_init` is deprecated but supported, and needs no code signing; an App Sandbox
    /// with entitlements of its own waits for signing (#24).
    #[cfg(target_os = "macos")]
    fn sandbox() -> io::Result<()> {
        extern "C" {
            fn sandbox_init(
                profile: *const libc::c_char,
                flags: u64,
                error: *mut *mut libc::c_char,
            ) -> libc::c_int;
            fn sandbox_free_error(error: *mut libc::c_char);
        }
        let mut error = std::ptr::null_mut();
        // SAFETY: the profile is a C string constant; flags 0 means it is a profile's text; an
        // error message is freed as documented.
        unsafe {
            if sandbox_init(c"(version 1) (deny default)".as_ptr(), 0, &mut error) == 0 {
                return Ok(());
            }
            if !error.is_null() {
                sandbox_free_error(error);
            }
        }
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }

    /// Starts `command` as the helper, limited before it runs (its own process group, CPU
    /// time, memory on Linux, no core dump); it sandboxes itself (`this_process`). Returns it
    /// with pipes to its stdin and from its stdout. Its stderr goes nowhere.
    #[cfg(all(unix, desktop))]
    pub(super) fn start(
        mut command: std::process::Command,
    ) -> Result<(Helper, io::PipeWriter, io::PipeReader), Unanswered> {
        use std::os::unix::process::CommandExt;
        let (helper_reads, input) = io::pipe().map_err(|_| Unanswered::Failed)?;
        let (output, helper_writes) = io::pipe().map_err(|_| Unanswered::Failed)?;
        command
            .stdin(helper_reads)
            .stdout(helper_writes)
            .stderr(std::process::Stdio::null());
        let cpu_seconds = super::HELPER_TIME_LIMIT.as_secs() as libc::rlim_t;
        #[cfg(not(target_os = "macos"))]
        let data = super::HELPER_MEMORY_LIMIT as libc::rlim_t;
        // SAFETY: only setpgid and setrlimit, which are async-signal-safe, run between fork
        // and exec.
        unsafe {
            command.pre_exec(move || {
                // Its own process group, so that stopping it stops anything it started.
                if libc::setpgid(0, 0) != 0 {
                    return Err(io::Error::last_os_error());
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
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        let child = command.spawn().map_err(|_| Unanswered::Failed)?;
        // Closes this process's copies of the helper's ends, so that its output ends with it.
        drop(command);
        Ok((Helper(child), input, output))
    }

    /// The running helper.
    #[cfg(all(unix, desktop))]
    pub(super) struct Helper(std::process::Child);

    #[cfg(all(unix, desktop))]
    impl Helper {
        /// Its exit code once it has ended (-1 when a signal ended it), `None` while it runs.
        pub(super) fn try_wait(&mut self) -> io::Result<Option<i32>> {
            Ok(self.0.try_wait()?.map(|status| status.code().unwrap_or(-1)))
        }

        /// Waits for it to end; its exit code as `try_wait` gives it.
        pub(super) fn wait(&mut self) -> Option<i32> {
            self.0.wait().ok().map(|status| status.code().unwrap_or(-1))
        }

        /// Whether the helper uses more memory than it may, checked each time myCarlos looks
        /// at it while it runs (every 20 ms), so it may pass the limit briefly before it is
        /// stopped. macOS only: its footprint, the memory macOS counts against it. A footprint
        /// that cannot be read counts as over, so that the check cannot quietly stop working.
        /// It can always be read: the helper is myCarlos's own child, of the same user, and not
        /// yet waited for, and macOS answers for such a process even once it has exited. The
        /// helper's sandbox does not stop myCarlos reading it.
        #[cfg(target_os = "macos")]
        pub(super) fn over_memory(&self) -> bool {
            let Ok(pid) = libc::c_int::try_from(self.0.id()) else {
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

        /// On Linux the data limit was set before the helper started.
        #[cfg(not(target_os = "macos"))]
        pub(super) fn over_memory(&self) -> bool {
            false
        }

        /// Stops the helper and anything it started: its whole process group.
        pub(super) fn stop(&mut self) {
            if let Ok(group) = libc::pid_t::try_from(self.0.id()) {
                // SAFETY: the group is the helper's own, made by setpgid before it started.
                unsafe { libc::killpg(group, libc::SIGKILL) };
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// Checks that this process, the helper, is in an AppContainer, where `start` puts it. A
    /// helper started any other way reads nothing. (A process cannot put itself in one.)
    #[cfg(windows)]
    pub(super) fn this_process() -> io::Result<()> {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        use windows::Win32::Security::{GetTokenInformation, TokenIsAppContainer, TOKEN_QUERY};
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        let mut in_container = 0u32;
        // SAFETY: the token handle is closed below; the answer is a DWORD, the size given.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(io::Error::other)?;
            let mut size = 0u32;
            let asked = GetTokenInformation(
                token,
                TokenIsAppContainer,
                Some((&mut in_container as *mut u32).cast()),
                std::mem::size_of::<u32>() as u32,
                &mut size,
            );
            let _ = CloseHandle(token);
            asked.map_err(io::Error::other)?;
        }
        if in_container == 0 {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        Ok(())
    }

    /// The helper's AppContainer SID, freed when dropped.
    #[cfg(windows)]
    struct AppContainer(windows::Win32::Security::PSID);

    #[cfg(windows)]
    impl Drop for AppContainer {
        fn drop(&mut self) {
            // SAFETY: the SID came from the AppContainer calls below and is freed once.
            unsafe {
                windows::Win32::Security::FreeSid(self.0);
            }
        }
    }

    /// The helper's AppContainer: made the first time, the same one after. It has no
    /// capabilities: no network, and no files but those any app may read, such as Windows'
    /// own and myCarlos's program, which the installer allows.
    #[cfg(windows)]
    fn app_container() -> windows::core::Result<AppContainer> {
        use windows::core::w;
        use windows::Win32::Foundation::ERROR_ALREADY_EXISTS;
        use windows::Win32::Security::Isolation::{
            CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
        };
        let name = w!("mycarlos.pdfhelper");
        // SAFETY: constant names; the SID returned is owned by `AppContainer`.
        unsafe {
            match CreateAppContainerProfile(
                name,
                w!("myCarlos PDF helper"),
                w!("Opens PDF documents for myCarlos, with no access to files or the network."),
                None,
            ) {
                Ok(sid) => Ok(AppContainer(sid)),
                Err(error) if error.code() == ERROR_ALREADY_EXISTS.to_hresult() => {
                    DeriveAppContainerSidFromAppContainerName(name).map(AppContainer)
                }
                Err(error) => Err(error),
            }
        }
    }

    /// Starts `command` as the helper: in its AppContainer, with only the two pipes, its
    /// folder the program's, and only the environment `command` sets (`exchange` sets none).
    /// It is put in its job before it runs. Without the AppContainer it is not started:
    /// `NoSandbox`, as when the AppContainer may not run the program (an install the
    /// installer did not prepare). (std's `Command` cannot yet start a process in an
    /// AppContainer.)
    #[cfg(windows)]
    pub(super) fn start(
        command: std::process::Command,
    ) -> Result<(Helper, io::PipeWriter, io::PipeReader), Unanswered> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, HANDLE};
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows::Win32::System::Threading::ResumeThread;
        fn failed<E>(_: E) -> Unanswered {
            Unanswered::Failed
        }
        let container = app_container().map_err(|_| Unanswered::NoSandbox)?;
        let job = job().map_err(failed)?;
        let (helper_reads, input) = io::pipe().map_err(failed)?;
        let (output, helper_writes) = io::pipe().map_err(failed)?;
        let (process, thread) =
            create_suspended(&command, &container, &helper_reads, &helper_writes).map_err(
                |error| {
                    if error.code() == ERROR_ACCESS_DENIED.to_hresult() {
                        Unanswered::NoSandbox
                    } else {
                        Unanswered::Failed
                    }
                },
            )?;
        // This process's copies of the helper's ends, so that its output ends with it.
        drop((helper_reads, helper_writes));
        let mut helper = Helper { process, job };
        // SAFETY: both handles are live: the job's, and the new process's main thread's.
        let running = unsafe {
            AssignProcessToJobObject(helper.job.0, helper.handle()).is_ok()
                && ResumeThread(HANDLE(thread.as_raw_handle())) != u32::MAX
        };
        if !running {
            helper.stop();
            return Err(Unanswered::Failed);
        }
        Ok((helper, input, output))
    }

    /// Creates the helper suspended, as `start` describes.
    #[cfg(windows)]
    fn create_suspended(
        command: &std::process::Command,
        container: &AppContainer,
        stdin: &io::PipeReader,
        stdout: &io::PipeWriter,
    ) -> windows::core::Result<(
        std::os::windows::io::OwnedHandle,
        std::os::windows::io::OwnedHandle,
    )> {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT};
        use windows::Win32::Security::SECURITY_CAPABILITIES;
        use windows::Win32::System::Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
            UpdateProcThreadAttribute, CREATE_NO_WINDOW, CREATE_SUSPENDED,
            CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
        };
        let wide = |text: &std::ffi::OsStr| text.encode_wide().chain([0]).collect::<Vec<u16>>();
        let program = std::path::Path::new(command.get_program());
        let application = wide(program.as_os_str());
        let mut line = Vec::new();
        push_argument(&mut line, program.as_os_str());
        for argument in command.get_args() {
            push_argument(&mut line, argument);
        }
        line.push(0);
        // Each "name=value" ends with a NUL, and the block with another; empty, it is two NULs.
        let mut environment = Vec::new();
        for (name, value) in command.get_envs() {
            if let Some(value) = value {
                environment.extend(name.encode_wide());
                environment.push(u16::from(b'='));
                environment.extend(value.encode_wide());
                environment.push(0);
            }
        }
        if environment.is_empty() {
            environment.push(0);
        }
        environment.push(0);
        let folder = program
            .parent()
            .filter(|folder| !folder.as_os_str().is_empty())
            .map(|folder| wide(folder.as_os_str()));
        let handles = [
            HANDLE(stdin.as_raw_handle()),
            HANDLE(stdout.as_raw_handle()),
        ];
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: container.0,
            ..Default::default()
        };
        // SAFETY: every buffer, string, handle and struct handed over outlives the calls that
        // read it; the attribute list is deleted once, after CreateProcessW; the two handles
        // returned are the new process's and its thread's, owned by the caller.
        unsafe {
            for handle in handles {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)?;
            }
            let mut size = 0usize;
            // Asks for the size, failing as documented.
            let _ = InitializeProcThreadAttributeList(None, 2, None, &mut size);
            let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
            InitializeProcThreadAttributeList(Some(list), 2, None, &mut size)?;
            let created = UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some((&capabilities as *const SECURITY_CAPABILITIES).cast()),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
            .and_then(|()| {
                // It inherits these two handles and no other.
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    Some(handles.as_ptr().cast()),
                    std::mem::size_of_val(&handles),
                    None,
                    None,
                )
            })
            .and_then(|()| {
                let mut startup = STARTUPINFOEXW::default();
                startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
                startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = handles[0];
                startup.StartupInfo.hStdOutput = handles[1];
                startup.lpAttributeList = list;
                let mut information = PROCESS_INFORMATION::default();
                CreateProcessW(
                    PCWSTR(application.as_ptr()),
                    Some(PWSTR(line.as_mut_ptr())),
                    None,
                    None,
                    true,
                    EXTENDED_STARTUPINFO_PRESENT
                        | CREATE_SUSPENDED
                        | CREATE_NO_WINDOW
                        | CREATE_UNICODE_ENVIRONMENT,
                    Some(environment.as_ptr().cast()),
                    folder
                        .as_ref()
                        .map_or(PCWSTR::null(), |folder| PCWSTR(folder.as_ptr())),
                    &startup.StartupInfo,
                    &mut information,
                )
                .map(|()| {
                    (
                        OwnedHandle::from_raw_handle(information.hProcess.0),
                        OwnedHandle::from_raw_handle(information.hThread.0),
                    )
                })
            });
            DeleteProcThreadAttributeList(list);
            created
        }
    }

    /// Adds `argument` to a command line as the C runtime and Rust split it again.
    #[cfg(windows)]
    fn push_argument(line: &mut Vec<u16>, argument: &std::ffi::OsStr) {
        use std::os::windows::ffi::OsStrExt;
        let (space, tab, quote, backslash) = (
            u16::from(b' '),
            u16::from(b'\t'),
            u16::from(b'"'),
            u16::from(b'\\'),
        );
        let argument: Vec<u16> = argument.encode_wide().collect();
        if !line.is_empty() {
            line.push(space);
        }
        if !argument.is_empty()
            && !argument
                .iter()
                .any(|&unit| unit == space || unit == tab || unit == quote)
        {
            line.extend(argument);
            return;
        }
        line.push(quote);
        let mut backslashes = 0;
        for unit in argument {
            if unit == backslash {
                backslashes += 1;
            } else {
                if unit == quote {
                    // The backslashes before a quote are doubled, and the quote escaped.
                    line.extend(std::iter::repeat_n(backslash, backslashes + 1));
                }
                backslashes = 0;
            }
            line.push(unit);
        }
        // Backslashes before the closing quote are doubled too.
        line.extend(std::iter::repeat_n(backslash, backslashes));
        line.push(quote);
    }

    /// The running helper, in its job.
    #[cfg(windows)]
    pub(super) struct Helper {
        process: std::os::windows::io::OwnedHandle,
        /// Closed after the process handle, which ends the helper if it still runs.
        job: Job,
    }

    #[cfg(windows)]
    impl Helper {
        fn handle(&self) -> windows::Win32::Foundation::HANDLE {
            use std::os::windows::io::AsRawHandle;
            windows::Win32::Foundation::HANDLE(self.process.as_raw_handle())
        }

        /// Its exit code once it has ended, `None` while it runs.
        pub(super) fn try_wait(&mut self) -> io::Result<Option<i32>> {
            use windows::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
            use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
            // SAFETY: the process handle is live while `self` is.
            unsafe {
                match WaitForSingleObject(self.handle(), 0) {
                    WAIT_TIMEOUT => Ok(None),
                    WAIT_OBJECT_0 => {
                        let mut code = 0u32;
                        GetExitCodeProcess(self.handle(), &mut code).map_err(io::Error::other)?;
                        Ok(Some(code as i32))
                    }
                    _ => Err(io::Error::last_os_error()),
                }
            }
        }

        /// Waits for it to end; its exit code.
        pub(super) fn wait(&mut self) -> Option<i32> {
            use windows::Win32::System::Threading::{WaitForSingleObject, INFINITE};
            // SAFETY: the process handle is live while `self` is.
            unsafe { WaitForSingleObject(self.handle(), INFINITE) };
            self.try_wait().ok().flatten()
        }

        /// The job's memory limit holds it.
        pub(super) fn over_memory(&self) -> bool {
            false
        }

        /// Stops the helper; the job allows it no other process.
        pub(super) fn stop(&mut self) {
            use windows::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
            // SAFETY: the process handle is live while `self` is.
            unsafe {
                let _ = TerminateProcess(self.handle(), 1);
                WaitForSingleObject(self.handle(), 5_000);
            }
        }
    }

    /// Closed when dropped, which ends the helper if it is still running.
    #[cfg(windows)]
    struct Job(windows::Win32::Foundation::HANDLE);

    #[cfg(windows)]
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle came from CreateJobObjectW and is closed once.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }

    /// The helper's job: its memory capped, one process, ended when closed or if it crashes.
    #[cfg(windows)]
    fn job() -> windows::core::Result<Job> {
        use windows::core::PCWSTR;
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
            JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        };
        // SAFETY: the job handle is owned by `Job`; the information struct outlives the call.
        unsafe {
            let job = Job(CreateJobObjectW(None, PCWSTR::null())?);
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
            )?;
            Ok(job)
        }
    }

    /// Phones never start the helper (`unlock_in_helper` is `Unavailable` there).
    #[cfg(mobile)]
    pub(super) fn this_process() -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
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
        assert!(matches!(answer, Err(Unanswered::Failed)));
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
        // A helper that could not sandbox itself.
        let outcome = run_helper(
            shell("cat >/dev/null; exit 2"),
            b"%PDF-1.7 FAKE",
            PASSWORD,
            HELPER_TIME_LIMIT,
        );
        assert!(matches!(outcome, Outcome::NoSandbox));
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
    #[cfg(desktop)]
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

    /// Sandboxed as the helper: on macOS this shows myCarlos can still read its footprint.
    #[cfg(desktop)]
    #[test]
    #[ignore = "invoked as a subprocess by the helper memory test"]
    fn growing_child() {
        confine::this_process().unwrap();
        take_memory_and_wait(HELPER_MEMORY_LIMIT as usize + 256 * 1024 * 1024);
    }

    /// Not sandboxed: on Linux, seccomp would refuse the wait.
    #[cfg(desktop)]
    #[test]
    #[ignore = "invoked as a subprocess by the helper memory test"]
    fn small_child() {
        take_memory_and_wait(256 * 1024 * 1024);
    }

    /// This test binary, to be started as the helper, running only the ignored test `name`.
    #[cfg(desktop)]
    fn helper_running(name: &str) -> std::process::Command {
        let program = std::env::current_exe().unwrap();
        #[cfg(windows)]
        allow_app_containers(&program);
        let test = format!("pdf_unlock::tests::{name}");
        let child = ["--ignored", "--exact", test.as_str()];
        // A name that matched no test would run nothing, and end at once.
        let listed = std::process::Command::new(&program)
            .args(child)
            .arg("--list")
            .output()
            .unwrap();
        let listing = format!("{test}: test");
        assert!(String::from_utf8_lossy(&listed.stdout)
            .lines()
            .any(|line| line == listing));
        let mut command = std::process::Command::new(&program);
        command.args(child);
        command
    }

    /// Lets AppContainers read and run `program`, as the installer does for myCarlos (and as
    /// WINDOWS.md has developers do for their builds), so that it can start as the helper.
    #[cfg(windows)]
    fn allow_app_containers(program: &std::path::Path) {
        for path in [program, program.parent().unwrap()] {
            let status = std::process::Command::new("icacls")
                .arg(path)
                .args(["/grant", "*S-1-15-2-1:(RX)"])
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "{}", path.display());
        }
    }

    /// The test `name` run without the sandbox, given `input`: its exit code and output.
    #[cfg(desktop)]
    fn run_unsandboxed(name: &str, input: &[u8]) -> (Option<i32>, String) {
        use std::process::Stdio;
        let mut child = helper_running(name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let output = child.wait_with_output().unwrap();
        let printed =
            String::from_utf8_lossy(&output.stdout) + String::from_utf8_lossy(&output.stderr);
        (output.status.code(), printed.into_owned())
    }

    /// The test `name` started as myCarlos starts the helper, given `input`: its exit code and
    /// output.
    #[cfg(desktop)]
    fn run_as_helper(name: &str, input: &[u8]) -> (Option<i32>, String) {
        let (code, output) = talk(helper_running(name), input.to_vec()).unwrap();
        (code, String::from_utf8_lossy(&output).into_owned())
    }

    #[cfg(desktop)]
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
        // Then one that grows past it, sandboxed. Linux refuses it the memory (its data
        // limit), and Windows too (its job); macOS has no such limit, so myCarlos sees the
        // footprint and stops it. Either way well before the time limit.
        let command = helper_running("growing_child");
        let started = std::time::Instant::now();
        let outcome = run_helper(command, b"%PDF-1.7 FAKE", PASSWORD, HELPER_TIME_LIMIT);
        assert!(matches!(outcome, Outcome::Failed));
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(15), "{elapsed:?}");
    }

    /// What code that took over the helper might try, each once: whether each worked.
    #[cfg(desktop)]
    fn escape_attempts(
        file: &std::path::Path,
        port: u16,
        program: &std::path::Path,
    ) -> Vec<(&'static str, bool)> {
        use std::process::Stdio;
        let connect = || std::net::TcpStream::connect(("127.0.0.1", port)).is_ok();
        #[allow(unused_mut)]
        let mut attempts = vec![
            ("read a file", std::fs::read(file).is_ok()),
            (
                "write a file",
                std::fs::write(file.with_extension("written"), b"FAKE").is_ok(),
            ),
            ("connect", connect()),
            (
                "start a program",
                std::process::Command::new(program)
                    .arg("--list")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok(),
            ),
        ];
        #[cfg(unix)]
        {
            attempts.push((
                "bind a socket",
                std::net::UdpSocket::bind(("127.0.0.1", 0)).is_ok(),
            ));
            attempts.push(("make a pipe", io::pipe().is_ok()));
            // Closing a descriptor frees a slot under the descriptor limit (where seccomp
            // lets it be closed at all): still nothing opens.
            // SAFETY: stdin was read to its end and is not used again.
            unsafe { libc::close(0) };
            attempts.push(("read a file, stdin closed", std::fs::read(file).is_ok()));
            attempts.push(("connect, stdin closed", connect()));
        }
        attempts
    }

    /// Run in its own process by the test below, sandboxed as it is told, then tries the
    /// attempts above: all must work without the sandbox, and none with it.
    #[cfg(desktop)]
    #[test]
    #[ignore = "invoked as a subprocess by the helper sandbox test"]
    fn escape_child() {
        // Its orders: the sandbox, a file it could read before, a port where a connection
        // would be taken, and a program it could start.
        let mut orders = String::new();
        io::stdin().read_to_string(&mut orders).unwrap();
        let [sandbox, file, port, program] = orders.lines().collect::<Vec<_>>()[..] else {
            panic!("{orders:?}");
        };
        let (file, program) = (std::path::Path::new(file), std::path::Path::new(program));
        match sandbox {
            "none" => {}
            "helper" => {
                #[cfg(unix)]
                let kept = std::fs::File::open(file).unwrap();
                confine::this_process().unwrap();
                // Descriptors it was given are closed.
                #[cfg(unix)]
                {
                    use std::os::fd::AsRawFd;
                    assert_eq!(unsafe { libc::fcntl(kept.as_raw_fd(), libc::F_GETFD) }, -1);
                    std::mem::forget(kept);
                }
            }
            #[cfg(target_os = "linux")]
            "seccomp" => confine::seccomp().unwrap(),
            other => panic!("{other}"),
        }
        let attempts = escape_attempts(file, port.parse().unwrap(), program);
        let unsandboxed = sandbox == "none";
        assert!(
            attempts.iter().all(|&(_, worked)| worked == unsandboxed),
            "{sandbox}: {attempts:?}"
        );
        #[cfg(target_os = "linux")]
        if !unsandboxed {
            // Nor can it become another program. (Were it allowed, the exit code would tell.)
            let shell = c"/bin/sh";
            let arguments = [
                shell.as_ptr(),
                c"-c".as_ptr(),
                c"exit 7".as_ptr(),
                std::ptr::null(),
            ];
            // SAFETY: NUL-terminated strings and a NULL-terminated list.
            assert_eq!(
                unsafe { libc::execv(shell.as_ptr(), arguments.as_ptr()) },
                -1
            );
        }
    }

    #[cfg(desktop)]
    #[test]
    fn a_sandboxed_helper_can_read_write_connect_to_or_start_nothing() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("FAKE-readable.txt");
        std::fs::write(&file, b"FAKE").unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let program = std::env::current_exe().unwrap();
        let orders = |sandbox: &str| {
            format!(
                "{sandbox}\n{}\n{port}\n{}\n",
                file.display(),
                program.display()
            )
        };
        // The control, without the sandbox: every attempt works, so none fails by mistake.
        let (code, output) = run_unsandboxed("escape_child", orders("none").as_bytes());
        assert_eq!(code, Some(0), "{output}");
        // Sandboxed as myCarlos's helper is, started as myCarlos starts it.
        let (code, output) = run_as_helper("escape_child", orders("helper").as_bytes());
        assert_eq!(code, Some(0), "{output}");
        // On Linux, seccomp alone holds too: without Landlock or the descriptor limit.
        #[cfg(target_os = "linux")]
        {
            let (code, output) = run_as_helper("escape_child", orders("seccomp").as_bytes());
            assert_eq!(code, Some(0), "{output}");
        }
        drop(listener);
    }

    /// Run in its own process by the test below: Landlock alone, where the kernel has it.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "invoked as a subprocess by the Landlock test"]
    fn landlock_child() {
        let mut orders = String::new();
        io::stdin().read_to_string(&mut orders).unwrap();
        let [file, port] = orders.lines().collect::<Vec<_>>()[..] else {
            panic!("{orders:?}");
        };
        let status = confine::landlock().unwrap();
        println!("Landlock: {status:?}");
        if let landlock::LandlockStatus::Available { effective_abi, .. } = status.landlock {
            assert_ne!(status.ruleset, landlock::RulesetStatus::NotEnforced);
            let read = std::fs::read(file).unwrap_err();
            assert_eq!(read.kind(), io::ErrorKind::PermissionDenied, "{read}");
            // TCP is in Landlock from its fourth version.
            if effective_abi >= landlock::ABI::V4 {
                let port: u16 = port.parse().unwrap();
                assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err());
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn landlock_alone_denies_files_and_connections_where_the_kernel_has_it() {
        let folder = tempfile::tempdir().unwrap();
        let file = folder.path().join("FAKE-readable.txt");
        std::fs::write(&file, b"FAKE").unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let orders = format!("{}\n{port}\n", file.display());
        let (code, output) = run_unsandboxed("landlock_child", orders.as_bytes());
        assert_eq!(code, Some(0), "{output}");
        drop(listener);
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

    /// Windows CI runs this: in its AppContainer, the helper cannot open myCarlos to read it.
    #[cfg(windows)]
    #[test]
    #[ignore = "invoked as a subprocess by the AppContainer test"]
    fn app_container_child() {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_VM_READ};
        let mut parent = String::new();
        io::stdin().read_to_string(&mut parent).unwrap();
        let parent: u32 = parent.trim().parse().unwrap();
        confine::this_process().unwrap();
        // SAFETY: OpenProcess only returns a handle or an error.
        assert!(unsafe { OpenProcess(PROCESS_VM_READ, false, parent) }.is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_helper_in_its_app_container_cannot_read_mycarlos() {
        let parent = std::process::id().to_string();
        let (code, output) = run_as_helper("app_container_child", parent.as_bytes());
        assert_eq!(code, Some(0), "{output}");
    }

    #[cfg(windows)]
    #[test]
    fn a_helper_outside_its_app_container_reads_nothing() {
        // This test's own process is in none.
        assert!(confine::this_process().is_err());
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
