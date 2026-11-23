//! Child processes on Windows must not open a console window: one started from the GUI app without
//! `CREATE_NO_WINDOW` shows a black console for an instant (Ben saw it when turning on "Start myCarlos
//! when I sign in", which started `reg.exe`). Every `std::process::Command` this app starts on
//! Windows goes through `hide_console`, and a source scan below fails the build when a new one does
//! not (or is not on the reviewed list with its reason).

use std::process::Command;

/// The Windows process creation flag that stops a child from getting a console window.
#[cfg_attr(not(windows), allow(dead_code))] // used on Windows; the test pins it everywhere
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Starts `command` without a console window on Windows; nothing to do elsewhere.
pub(crate) fn hide_console(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn the_flag_is_create_no_window() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn hiding_the_console_leaves_the_command_as_it_was() {
        let mut command = Command::new("example");
        hide_console(&mut command).arg("one");
        assert_eq!(command.get_program(), "example");
        assert_eq!(command.get_args().count(), 1);
    }

    /// `std::process::Command::new` sites in non-test code that are not hidden by `hide_console`,
    /// each with why that is right. A new site fails the scan below until it uses `hide_console`
    /// or is added here with its reason.
    const NOT_HIDDEN: &[(&str, &str)] = &[
        (
            "extraction_acceptance_tests.rs",
            "test support: the module is declared under #[cfg(test)]",
        ),
        ("throttle.rs", "a unix-only test (mkfifo)"),
        (
            "model_helper/confine.rs",
            "the sandbox's own self-test, run inside the confined helper on Linux",
        ),
    ];

    fn sources(directory: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                sources(&path, found);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                found.push(path);
            }
        }
    }

    /// Where a file's test module starts (the first `#[cfg(test)]` that is followed by a module).
    fn test_module_start(text: &str) -> usize {
        let mut from = 0;
        while let Some(at) = text[from..].find("#[cfg(test)]") {
            let start = from + at;
            let rest = text[start + "#[cfg(test)]".len()..].trim_start();
            let rest = rest.trim_start_matches(|c: char| c.is_whitespace());
            let mut after = rest;
            // Skip further attributes between the cfg and the item.
            while after.starts_with("#[") {
                match after.find(']') {
                    Some(end) => after = after[end + 1..].trim_start(),
                    None => break,
                }
            }
            if after.starts_with("mod ") || after.starts_with("pub(crate) mod ") {
                return start;
            }
            from = start + 1;
        }
        text.len()
    }

    #[test]
    fn every_command_this_app_starts_hides_its_console_on_windows() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&root, &mut files);
        assert!(files.len() > 40, "the scan found the source files");
        let mut unhidden = Vec::new();
        let mut hidden = 0;
        for file in files {
            let relative = file
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(&file).unwrap();
            let code = &text[..test_module_start(&text)];
            for (at, _) in code.match_indices("Command::new(") {
                // `hide_console(` must come within the function that makes the command.
                let after = &code[at..code[at..].find("\nfn ").map_or(code.len(), |end| at + end)];
                if after.contains("hide_console(") {
                    hidden += 1;
                } else if !NOT_HIDDEN.iter().any(|(name, _)| *name == relative) {
                    let line = code[..at].matches('\n').count() + 1;
                    unhidden.push(format!("{relative}:{line}"));
                }
            }
        }
        assert!(
            unhidden.is_empty(),
            "these start a process without process_flags::hide_console (CREATE_NO_WINDOW on Windows), \
             and are not on the NOT_HIDDEN list: {unhidden:?}"
        );
        // Not vacuous: the sites that are hidden were found.
        assert!(hidden >= 2, "the scan found the hidden sites ({hidden})");
    }

    #[test]
    fn the_registry_login_item_starts_no_process() {
        let text = include_str!("desktop_background.rs");
        let code = &text[..test_module_start(text)];
        assert!(
            !code.contains("Command::new"),
            "desktop_background starts no process"
        );
    }
}
