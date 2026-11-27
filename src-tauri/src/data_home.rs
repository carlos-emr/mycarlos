//! Where the app keeps its data: the one place that asks Tauri for the machine-local data folder
//! (`app_local_data_dir()`), so a test can move it.
//!
//! In a DEBUG build (`debug_assertions`, which is what the evaluation installers and `cargo test`
//! are) the environment variable `MYCARLOS_TEST_DATA_DIR` may name another folder, so the native
//! Windows playtests can run the installed app against a data home they made themselves instead of
//! the account's own. In a RELEASE build the variable is ignored, whatever it says.
//!
//! The override is refused (the app does not start, rather than silently using the real folder) unless
//! the folder is:
//!  - an absolute path (never relative to wherever the app started);
//!  - a real directory, not a link, that exists;
//!  - empty, or already marked as a test home by an earlier run (the `.mycarlos-test-home` file this
//!    module writes into an empty one), so it can never be a folder that holds anything else;
//!  - not the real data folder, not inside it and not a parent of it.
//!
//! Using it is logged once as "test data home in use" (no path, nothing about any record), and
//! `runtime_info` then says `testDataHome: true`, so a test can prove the override took effect
//! before it creates anything. The proof is the point: a build that ignores the variable would
//! otherwise leave a test acting on the real account.
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

/// The variable a debug build reads.
pub(crate) const OVERRIDE_VAR: &str = "MYCARLOS_TEST_DATA_DIR";
/// Written into an empty test home so a later run recognises it as ours and nothing else.
const MARKER: &str = ".mycarlos-test-home";

static OVERRIDE_IN_USE: AtomicBool = AtomicBool::new(false);

/// Whether this run is using a test data home (for `runtime_info`).
pub(crate) fn override_in_use() -> bool {
    OVERRIDE_IN_USE.load(Ordering::Relaxed)
}

/// Why a requested test data home was refused. The app does not start on any of these.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refused {
    NotAbsolute,
    NotADirectory,
    NotEmptyAndNotATestHome,
    InsideOrAroundTheRealFolder,
    Unreadable,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The reason, never the path.
        let reason = match self {
            Self::NotAbsolute => "it is not an absolute path",
            Self::NotADirectory => "it is not an existing directory (a link or a file is refused)",
            Self::NotEmptyAndNotATestHome => {
                "it is not empty and was not made by an earlier test run"
            }
            Self::InsideOrAroundTheRealFolder => {
                "it is the app's real data folder, or inside or around it"
            }
            Self::Unreadable => "it could not be read",
        };
        write!(f, "{OVERRIDE_VAR} refused: {reason}")
    }
}

impl std::error::Error for Refused {}

/// Decides the data folder. Pure over its inputs so it is unit-tested: `debug` is whether this is a
/// debug build, `requested` the variable's value, `real` the folder Tauri would use.
///
/// A release build, or no variable (or an empty one), gives `real`. Otherwise the request is
/// validated, and returned only if it passes.
pub(crate) fn resolve(
    debug: bool,
    requested: Option<OsString>,
    real: &Path,
) -> Result<PathBuf, Refused> {
    let Some(requested) = requested.filter(|value| debug && !value.is_empty()) else {
        return Ok(real.to_path_buf());
    };
    let requested = PathBuf::from(requested);
    if !requested.is_absolute() {
        return Err(Refused::NotAbsolute);
    }
    // A link is refused rather than followed.
    let metadata = fs::symlink_metadata(&requested).map_err(|_| Refused::NotADirectory)?;
    if !metadata.file_type().is_dir() {
        return Err(Refused::NotADirectory);
    }
    let canonical = fs::canonicalize(&requested).map_err(|_| Refused::Unreadable)?;
    // The real folder may not exist yet on a fresh account: compare what can be compared.
    let real_canonical = fs::canonicalize(real).unwrap_or_else(|_| real.to_path_buf());
    if overlaps(&canonical, &real_canonical) {
        return Err(Refused::InsideOrAroundTheRealFolder);
    }
    claim(&canonical)?;
    Ok(canonical)
}

/// An empty folder becomes a test home (the marker is written); a marked one is ours already;
/// anything else is refused.
fn claim(directory: &Path) -> Result<(), Refused> {
    let marker = directory.join(MARKER);
    if marker.is_file() {
        return Ok(());
    }
    let empty = fs::read_dir(directory)
        .map_err(|_| Refused::Unreadable)?
        .next()
        .is_none();
    if !empty {
        return Err(Refused::NotEmptyAndNotATestHome);
    }
    fs::write(&marker, b"made for a myCarlos test run\n").map_err(|_| Refused::Unreadable)
}

/// A path as comparable text: without Windows' `\\?\` verbatim prefix (`canonicalize` adds it, and
/// the real folder may not exist yet to be canonicalized the same way) and, on Windows, lower case.
fn comparable(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    let plain = text.strip_prefix(r"\\?\").unwrap_or(&text);
    if cfg!(windows) {
        PathBuf::from(plain.to_lowercase())
    } else {
        PathBuf::from(plain.to_string())
    }
}

/// Whether `a` is `b`, inside `b`, or a parent of `b`.
fn overlaps(a: &Path, b: &Path) -> bool {
    let (a, b) = (comparable(a), comparable(b));
    a.starts_with(&b) || b.starts_with(&a)
}

/// The machine-local data folder every part of the app uses: Tauri's, or in a debug build the
/// validated `MYCARLOS_TEST_DATA_DIR`. A refused override is an error, so the app does not start
/// against the wrong folder.
pub(crate) fn local_data_dir<R: tauri::Runtime>(
    app: &impl tauri::Manager<R>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let real = app.path().app_local_data_dir()?;
    let chosen = resolve(
        cfg!(debug_assertions),
        std::env::var_os(OVERRIDE_VAR),
        &real,
    )?;
    if chosen != real && !OVERRIDE_IN_USE.swap(true, Ordering::Relaxed) {
        // Once, with no path.
        eprintln!("test data home in use");
    }
    Ok(chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(path: &Path) -> Option<OsString> {
        Some(path.as_os_str().to_owned())
    }

    #[test]
    fn a_debug_build_uses_an_empty_absolute_folder_and_marks_it() {
        let real = tempfile::tempdir().unwrap();
        let test_home = tempfile::tempdir().unwrap();
        let chosen = resolve(true, os(test_home.path()), real.path()).unwrap();
        assert_eq!(chosen, fs::canonicalize(test_home.path()).unwrap());
        assert!(test_home.path().join(MARKER).is_file());
        // A second run recognises its own home even though it is no longer empty.
        fs::create_dir(test_home.path().join("vault-home")).unwrap();
        assert_eq!(
            resolve(true, os(test_home.path()), real.path()).unwrap(),
            chosen
        );
    }

    #[test]
    fn a_release_build_ignores_the_variable() {
        let real = tempfile::tempdir().unwrap();
        let test_home = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(false, os(test_home.path()), real.path()).unwrap(),
            real.path().to_path_buf()
        );
        // And touches nothing there.
        assert!(!test_home.path().join(MARKER).exists());
        // Even a relative or empty value is simply ignored in release.
        assert_eq!(
            resolve(false, Some("relative/dir".into()), real.path()).unwrap(),
            real.path().to_path_buf()
        );
    }

    #[test]
    fn no_variable_or_an_empty_one_is_the_real_folder() {
        let real = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(true, None, real.path()).unwrap(),
            real.path().to_path_buf()
        );
        assert_eq!(
            resolve(true, Some(OsString::new()), real.path()).unwrap(),
            real.path().to_path_buf()
        );
    }

    #[test]
    fn a_relative_path_is_refused_in_a_debug_build() {
        let real = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(true, Some("relative/dir".into()), real.path()),
            Err(Refused::NotAbsolute)
        );
    }

    #[test]
    fn a_missing_folder_a_file_and_a_link_are_refused() {
        let real = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve(true, os(&scratch.path().join("missing")), real.path()),
            Err(Refused::NotADirectory)
        );
        let file = scratch.path().join("a-file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            resolve(true, os(&file), real.path()),
            Err(Refused::NotADirectory)
        );
        #[cfg(unix)]
        {
            let target = scratch.path().join("target");
            fs::create_dir(&target).unwrap();
            let link = scratch.path().join("link");
            std::os::unix::fs::symlink(&target, &link).unwrap();
            assert_eq!(
                resolve(true, os(&link), real.path()),
                Err(Refused::NotADirectory)
            );
        }
    }

    #[test]
    fn a_folder_that_holds_something_else_is_refused() {
        let real = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("Quarterly.pdf"), b"x").unwrap();
        assert_eq!(
            resolve(true, os(other.path()), real.path()),
            Err(Refused::NotEmptyAndNotATestHome)
        );
        assert!(!other.path().join(MARKER).exists());
    }

    #[test]
    fn the_real_folder_and_anything_inside_or_around_it_is_refused() {
        let outer = tempfile::tempdir().unwrap();
        let real = outer.path().join("real-data");
        fs::create_dir(&real).unwrap();
        let inside = real.join("vault-home");
        fs::create_dir(&inside).unwrap();
        for candidate in [&real, &inside, outer.path()] {
            assert_eq!(
                resolve(true, os(candidate), &real),
                Err(Refused::InsideOrAroundTheRealFolder),
                "{candidate:?}"
            );
        }
        assert!(!real.join(MARKER).exists());
        assert!(!inside.join(MARKER).exists());
    }

    #[test]
    fn a_refusal_names_no_path() {
        for refused in [
            Refused::NotAbsolute,
            Refused::NotADirectory,
            Refused::NotEmptyAndNotATestHome,
            Refused::InsideOrAroundTheRealFolder,
            Refused::Unreadable,
        ] {
            let text = refused.to_string();
            assert!(text.contains(OVERRIDE_VAR), "{text}");
            assert!(!text.contains('/') && !text.contains('\\'), "{text}");
        }
    }
}
