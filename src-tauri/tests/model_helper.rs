//! The real myCarlos executable, started as the AI helper's model process in its stub mode
//! (src/model_helper.rs; test builds with the `ai-helper-stub` feature only), through the app's
//! own launcher: sandboxed as in the app (on Windows, in its AppContainer and job). No model is
//! loaded: the stub answers canned FAKE text, and reports what its sandbox lets it do.
#![cfg(any(target_os = "linux", windows))]

use mycarlos_tauri_poc_lib::model_helper_testing::StubRunner;
use std::time::{Duration, Instant};

/// The executable, which AppContainers may read and run on Windows, as the installer allows.
fn executable() -> &'static std::path::Path {
    let executable = std::path::Path::new(env!("CARGO_BIN_EXE_mycarlos-tauri-poc"));
    #[cfg(windows)]
    for path in [executable, executable.parent().unwrap()] {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(["/grant", "*S-1-15-2-1:(RX)"])
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "{}", path.display());
    }
    executable
}

fn stub(delay_ms: u64) -> StubRunner {
    StubRunner::new(executable(), delay_ms, Duration::from_secs(20), None)
}

#[test]
fn the_stub_starts_sandboxed_and_answers_through_the_runner() {
    let runner = stub(0);
    assert_eq!(runner.start().unwrap(), "FAKE stub");
    let (sentences, last_page) = runner
        .summarize(&[
            (0, "FAKE blood test results were normal today."),
            (3, "FAKE page four."),
        ])
        .unwrap();
    assert_eq!(last_page, 3);
    assert_eq!(sentences.len(), 1);
    // The stub quotes the first words of the first page: located, so kept.
    assert_eq!(sentences[0].1, "FAKE blood test results were normal");
    assert_eq!(
        runner.explain("HbA1c").unwrap(),
        "FAKE explanation of HbA1c."
    );
    runner.stop();
    assert!(!runner.is_running());
}

#[test]
fn a_start_that_expects_the_verified_model_refuses_the_stub() {
    // A production start expects the verified model's hash, never all zeros.
    let runner = StubRunner::new(
        executable(),
        0,
        Duration::from_secs(20),
        Some(&"ab".repeat(32)),
    );
    assert_eq!(
        runner.start(),
        Err("Start(\"not the verified model\")".to_owned())
    );
    assert!(!runner.is_running());
}

#[test]
fn the_sandbox_denies_files_the_network_and_programs_but_allows_threads() {
    let dir = tempfile::tempdir().unwrap();
    let secret = dir.path().join("FAKE-patient-note.txt");
    std::fs::write(&secret, "FAKE note").unwrap();
    let written = dir.path().join("FAKE-written.txt");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let runner = stub(0);
    runner.start().unwrap();
    let probe = |what: String| runner.probe(&what).unwrap();
    assert_eq!(probe(format!("read:{}", secret.display())), "denied");
    assert_eq!(probe(format!("write:{}", written.display())), "denied");
    assert!(!written.exists());
    assert_eq!(probe(format!("connect:{port}")), "denied");
    assert_eq!(probe("exec".to_owned()), "denied");
    assert_eq!(probe("model".to_owned()), "denied");
    // The model needs threads.
    assert_eq!(probe("thread".to_owned()), "allowed");
    runner.stop();
}

#[test]
fn a_cancel_stops_the_request_in_flight_and_the_helper_within_seconds() {
    let runner = std::sync::Arc::new(stub(0));
    runner.start().unwrap();
    let asked = {
        let runner = runner.clone();
        std::thread::spawn(move || runner.probe("hang"))
    };
    std::thread::sleep(Duration::from_millis(500));
    let cancelled_at = Instant::now();
    runner.cancel();
    assert_eq!(asked.join().unwrap(), Err("Cancelled".to_owned()));
    assert!(cancelled_at.elapsed() < Duration::from_secs(5));
    assert!(!runner.is_running());
    // The next request starts it again.
    runner.start().unwrap();
    assert_eq!(
        runner.explain("again").unwrap(),
        "FAKE explanation of again."
    );
    runner.stop();
}

#[test]
fn a_lock_stops_the_helper_while_it_works() {
    let runner = std::sync::Arc::new(stub(30_000));
    runner.start().unwrap();
    let asked = {
        let runner = runner.clone();
        std::thread::spawn(move || runner.explain("slow"))
    };
    std::thread::sleep(Duration::from_millis(500));
    runner.lock();
    assert_eq!(asked.join().unwrap(), Err("Cancelled".to_owned()));
    assert!(!runner.is_running());
}

#[test]
fn an_answer_that_takes_too_long_stops_the_helper() {
    let runner = StubRunner::new(executable(), 0, Duration::from_millis(800), None);
    runner.start().unwrap();
    let started = Instant::now();
    assert_eq!(runner.probe("hang"), Err("Timeout".to_owned()));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!runner.is_running());
}

#[test]
fn a_helper_that_crashes_ends_without_an_answer_and_without_a_core_file() {
    let runner = stub(0);
    runner.start().unwrap();
    let outcome = runner.probe("crash");
    assert!(
        matches!(outcome.as_deref(), Err(error) if error.contains("ended without answering")),
        "{outcome:?}"
    );
    assert!(!runner.is_running());
}

/// Windows, CI only: with Windows Error Reporting's LocalDumps turned on for this executable (a
/// machine-wide setting, so only CI sets it, and removes it again), a helper that ends by a Rust
/// abort (`__fastfail`), by an allocation over its job's memory cap, or by a memory fault leaves
/// no crash dump and no report in WER's queue or archive: either could hold document text
/// (AI-06).
#[cfg(windows)]
#[test]
#[ignore = "sets a machine-wide LocalDumps entry; the Windows CI job runs it with --ignored"]
fn a_crashing_helper_leaves_no_crash_dump_even_with_local_dumps_on() {
    let dumps = tempfile::tempdir().unwrap();
    let key = format!(
        r"HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\{}",
        executable().file_name().unwrap().to_string_lossy()
    );
    let reg = |args: &[&str]| {
        let status = std::process::Command::new("reg")
            .args(args)
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "reg {args:?}");
    };
    // WER's report folders, the machine's and the user's: names of reports about this program.
    let reports = || {
        let mut found = Vec::new();
        for root in [std::env::var("ProgramData"), std::env::var("LOCALAPPDATA")]
            .into_iter()
            .flatten()
        {
            for kind in ["ReportQueue", "ReportArchive"] {
                let folder = std::path::Path::new(&root)
                    .join("Microsoft")
                    .join("Windows")
                    .join("WER")
                    .join(kind);
                for entry in std::fs::read_dir(folder).into_iter().flatten().flatten() {
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if name.contains("mycarlos") {
                        found.push(name);
                    }
                }
            }
        }
        found.sort();
        found
    };
    let reports_before = reports();
    let folder = dumps.path().to_string_lossy().into_owned();
    reg(&[
        "add",
        &key,
        "/v",
        "DumpFolder",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        &folder,
        "/f",
    ]);
    reg(&[
        "add",
        &key,
        "/v",
        "DumpType",
        "/t",
        "REG_DWORD",
        "/d",
        "2",
        "/f",
    ]);
    let mut outcomes = Vec::new();
    for crash in ["crash", "oom", "fault"] {
        let runner = stub(0);
        runner.start().unwrap();
        outcomes.push((crash, runner.probe(crash)));
        assert!(!runner.is_running());
    }
    // Windows Error Reporting writes a dump after the process has gone: give it time.
    std::thread::sleep(Duration::from_secs(10));
    reg(&["delete", &key, "/f"]);
    let written: Vec<_> = std::fs::read_dir(dumps.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(
        written.is_empty(),
        "dumps written: {written:?} ({outcomes:?})"
    );
    assert_eq!(reports(), reports_before, "WER reports ({outcomes:?})");
    for (crash, outcome) in outcomes {
        assert!(outcome.is_err(), "{crash}: {outcome:?}");
    }
}

#[test]
fn a_helper_over_its_memory_limit_or_faulting_ends_without_an_answer() {
    for crash in ["oom", "fault"] {
        let runner = stub(0);
        runner.start().unwrap();
        let outcome = runner.probe(crash);
        assert!(
            matches!(outcome.as_deref(), Err(error) if error.contains("ended without answering")),
            "{crash}: {outcome:?}"
        );
        assert!(!runner.is_running());
    }
}
