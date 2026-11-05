//! The model helper's own sandbox steps (see the module docs). Linux: two stages, one before
//! the model loads and a narrower one after. Windows: myCarlos already started it confined; it
//! checks so, and turns crash reports off.

use super::ModelFile;
use std::io;

// --- Linux ----------------------------------------------------------------------------------

/// Before the model loads: every descriptor but the model's closed, no privileges, no tracing,
/// no core, no file written, Landlock denying every file and network access the kernel knows
/// (the helper's own memfd stays readable), then the load filter. Without Landlock it does not
/// go on: the load filter allows read-only opens, which only Landlock confines.
#[cfg(target_os = "linux")]
pub(super) fn before_load(model: &ModelFile) -> io::Result<()> {
    let keep = match model {
        ModelFile::Descriptor(fd) if *fd == super::MODEL_FD => super::MODEL_FD + 1,
        _ => 3,
    };
    close_from(keep)?;
    // SAFETY: plain prctl calls with constant arguments.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            || libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    limit(libc::RLIMIT_CORE, 0)?;
    limit(libc::RLIMIT_FSIZE, 0)?;
    let status = landlock().map_err(io::Error::other)?;
    if status.ruleset == landlock::RulesetStatus::NotEnforced {
        return Err(io::Error::from(io::ErrorKind::Unsupported));
    }
    // Its pipes, the model, and what loading opens of it; nothing else can be opened anyway.
    limit(libc::RLIMIT_NOFILE, 16)?;
    seccomp(Stage::Load)
}

/// Once the model is in memory: its descriptor closed, and the answer filter on every thread.
#[cfg(target_os = "linux")]
pub(super) fn after_load(model: &ModelFile) -> io::Result<()> {
    if let ModelFile::Descriptor(fd) = model {
        if *fd == super::MODEL_FD {
            // SAFETY: the model's descriptor, which nothing uses once loaded.
            unsafe { libc::close(*fd) };
        }
    }
    seccomp(Stage::Answer)
}

#[cfg(target_os = "linux")]
fn limit(resource: libc::__rlimit_resource_t, value: libc::rlim_t) -> io::Result<()> {
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: setrlimit only reads the struct passed by reference.
    if unsafe { libc::setrlimit(resource, &limit) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Closes every descriptor from `first` on.
#[cfg(target_os = "linux")]
fn close_from(first: i32) -> io::Result<()> {
    // SAFETY: close_range only closes descriptors; none from `first` on is in use here.
    if unsafe { libc::syscall(libc::SYS_close_range, first as u32, u32::MAX, 0u32) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Every file and network right and scope this crate knows, allowed nowhere.
#[cfg(target_os = "linux")]
fn landlock() -> Result<landlock::RestrictionStatus, landlock::RulesetError> {
    use landlock::{Access, AccessFs, AccessNet, Ruleset, RulesetAttr, Scope, ABI};
    let abi = ABI::V9;
    Ruleset::default()
        .handle_access(AccessFs::from_all(abi))?
        .handle_access(AccessNet::from_all(abi))?
        .scope(Scope::from_all(abi))?
        .create()?
        .restrict_self()
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    /// Loading: read-only opens (Landlock leaves only the memfd), reads, and setting up the
    /// answer filter.
    Load,
    /// Answering: stdin in, stdout and stderr out, memory and threads.
    Answer,
}

/// Both stages allow: writing stdout and stderr, memory that is never executable, threads (a
/// clone that shares this process, never a new process), waiting, time and randomness,
/// reading its limits, signals to itself (`abort`), and ending. Anything else fails with ENOSYS
/// (so that the C library falls back from clone3 to clone): no socket, no program, no signal to
/// another process, no change to its limits. Built for x86_64 and aarch64 only.
#[cfg(target_os = "linux")]
fn seccomp(stage: Stage) -> io::Result<()> {
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
    let condition = |arg: u8, op, value: u64| {
        SeccompCondition::new(arg, Dword, op, value).map_err(io::Error::other)
    };
    let rule =
        |conditions: Vec<SeccompCondition>| SeccompRule::new(conditions).map_err(io::Error::other);
    // Allowed when argument `arg` is `value`.
    let when = |arg: u8, value: u64| rule(vec![condition(arg, Eq, value)?]);
    // Allowed when argument `arg`, masked, is `value`.
    let masked =
        |arg: u8, mask: u64, value: u64| rule(vec![condition(arg, MaskedEq(mask), value)?]);
    // Memory that is never executable: `prot`, the third argument, without PROT_EXEC.
    let not_executable = || masked(2, libc::PROT_EXEC as u64, 0);
    // SAFETY: a plain call without arguments.
    let process = unsafe { libc::getpid() } as u64;
    let thread = libc::CLONE_THREAD as u64;
    let mut rules: Vec<(i64, Vec<SeccompRule>)> = vec![
        (libc::SYS_write, vec![when(0, 1)?, when(0, 2)?]),
        (libc::SYS_writev, vec![when(0, 1)?, when(0, 2)?]),
        (libc::SYS_close, vec![]),
        (libc::SYS_brk, vec![]),
        (libc::SYS_mmap, vec![not_executable()?]),
        (libc::SYS_mprotect, vec![not_executable()?]),
        (libc::SYS_munmap, vec![]),
        (libc::SYS_mremap, vec![]),
        (libc::SYS_madvise, vec![]),
        (libc::SYS_futex, vec![]),
        (libc::SYS_sched_yield, vec![]),
        (libc::SYS_sched_getaffinity, vec![]),
        (libc::SYS_getrandom, vec![]),
        (libc::SYS_clock_gettime, vec![]),
        (libc::SYS_clock_nanosleep, vec![]),
        (libc::SYS_nanosleep, vec![]),
        (libc::SYS_clone, vec![masked(0, thread, thread)?]),
        (libc::SYS_set_robust_list, vec![]),
        (libc::SYS_rseq, vec![]),
        // Reading a limit (no new value), as thread creation does.
        (libc::SYS_prlimit64, vec![when(2, 0)?]),
        (libc::SYS_sysinfo, vec![]),
        (libc::SYS_rt_sigreturn, vec![]),
        (libc::SYS_rt_sigprocmask, vec![]),
        (libc::SYS_rt_sigaction, vec![]),
        (libc::SYS_sigaltstack, vec![]),
        (libc::SYS_getpid, vec![]),
        (libc::SYS_gettid, vec![]),
        // A signal to one of its own threads only.
        (libc::SYS_tgkill, vec![when(0, process)?]),
        (libc::SYS_exit, vec![]),
        (libc::SYS_exit_group, vec![]),
    ];
    match stage {
        Stage::Load => {
            let writes = (libc::O_ACCMODE | libc::O_CREAT | libc::O_TRUNC | libc::O_APPEND) as u64;
            rules.extend([
                (libc::SYS_read, vec![]),
                (libc::SYS_pread64, vec![]),
                (libc::SYS_lseek, vec![]),
                (libc::SYS_openat, vec![masked(2, writes, 0)?]),
                (libc::SYS_fstat, vec![]),
                (libc::SYS_newfstatat, vec![]),
                (libc::SYS_statx, vec![]),
                (libc::SYS_fadvise64, vec![]),
                // For the answer filter, set up by `after_load`.
                (
                    libc::SYS_prctl,
                    vec![when(0, libc::PR_SET_NO_NEW_PRIVS as u64)?],
                ),
                (
                    libc::SYS_seccomp,
                    vec![when(0, libc::SECCOMP_SET_MODE_FILTER as u64)?],
                ),
            ]);
        }
        Stage::Answer => rules.push((libc::SYS_read, vec![when(0, 0)?])),
    }
    let filter = SeccompFilter::new(
        rules.into_iter().collect(),
        SeccompAction::Errno(libc::ENOSYS as u32),
        SeccompAction::Allow,
        arch,
    )
    .map_err(io::Error::other)?;
    let program = BpfProgram::try_from(filter).map_err(io::Error::other)?;
    match stage {
        Stage::Load => seccompiler::apply_filter(&program),
        // Every thread, whatever loading left running.
        Stage::Answer => seccompiler::apply_filter_all_threads(&program),
    }
    .map_err(io::Error::other)
}

// --- Windows --------------------------------------------------------------------------------

/// myCarlos started it in its AppContainer and job (`pdf_unlock::confine`); it checks it is in
/// the AppContainer, and makes sure a crash ends it at once without a report or a dump.
#[cfg(windows)]
pub(super) fn before_load(_model: &ModelFile) -> io::Result<()> {
    no_crash_reports();
    crate::pdf_unlock::check_confined()
}

/// Nothing to narrow on Windows: the AppContainer and job hold from the start. The helper keeps
/// its handle on the model file (llama.cpp maps it), which is harmless: myCarlos holds the file
/// with writers denied until the helper ends.
#[cfg(windows)]
pub(super) fn after_load(_model: &ModelFile) -> io::Result<()> {
    Ok(())
}

/// AI-06: no Windows Error Reporting dialog, report or dump for this process. An exception
/// nothing handles ends it on the spot, and abort() reports nothing.
#[cfg(windows)]
fn no_crash_reports() {
    use windows::Win32::System::Diagnostics::Debug::{
        SetErrorMode, SetUnhandledExceptionFilter, EXCEPTION_POINTERS, SEM_FAILCRITICALERRORS,
        SEM_NOGPFAULTERRORBOX, SEM_NOOPENFILEERRORBOX,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
    extern "C" {
        fn _set_abort_behavior(flags: u32, mask: u32) -> u32;
    }
    const WRITE_ABORT_MSG: u32 = 1;
    const CALL_REPORTFAULT: u32 = 2;
    unsafe extern "system" fn end_now(_: *const EXCEPTION_POINTERS) -> i32 {
        // SAFETY: ends this process; nothing runs after.
        unsafe {
            let _ = TerminateProcess(GetCurrentProcess(), 0xC0DE);
        }
        0
    }
    // SAFETY: process-wide settings with constant arguments, and a handler that only ends the
    // process.
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
        SetUnhandledExceptionFilter(Some(end_now));
        _set_abort_behavior(0, WRITE_ABORT_MSG | CALL_REPORTFAULT);
    }
}

// --- Probes (test builds only) --------------------------------------------------------------

/// What the sandbox lets the helper do, for the stub's tests: "allowed" or "denied".
/// `read:<path>`, `write:<path>`, `connect:<port>` (loopback), `exec` (start a program),
/// `thread` (start a thread, which the model needs), `model` (read descriptor 3). The stub also
/// takes `crash` (a Rust abort), `oom` (an allocation over its memory limit), `fault` (a memory
/// fault), and `hang`.
#[cfg(feature = "ai-helper-stub")]
pub(super) fn probe(what: &str) -> &'static str {
    let allowed = if let Some(path) = what.strip_prefix("read:") {
        std::fs::read(path).is_ok()
    } else if let Some(path) = what.strip_prefix("write:") {
        std::fs::write(path, b"FAKE").is_ok()
    } else if let Some(port) = what.strip_prefix("connect:") {
        port.parse::<u16>()
            .is_ok_and(|port| std::net::TcpStream::connect(("127.0.0.1", port)).is_ok())
    } else if what == "exec" {
        std::env::args_os()
            .next()
            .is_some_and(|program| std::process::Command::new(program).status().is_ok())
    } else if what == "thread" {
        std::thread::spawn(|| 7)
            .join()
            .is_ok_and(|seven| seven == 7)
    } else if what == "model" {
        model_readable()
    } else {
        false
    };
    if allowed {
        "allowed"
    } else {
        "denied"
    }
}

#[cfg(all(feature = "ai-helper-stub", unix))]
fn model_readable() -> bool {
    let mut byte = [0u8; 1];
    // SAFETY: reads one byte into a local buffer from a descriptor that may not be open.
    unsafe { libc::read(super::MODEL_FD, byte.as_mut_ptr().cast(), 1) >= 0 }
}

#[cfg(all(feature = "ai-helper-stub", not(unix)))]
fn model_readable() -> bool {
    false
}
