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
    /// or is added here with its reason. (Files that are test modules are skipped on their own:
    /// see `test_only_files`.)
    const NOT_HIDDEN: &[(&str, &str)] = &[
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

    /// The next `#[cfg(test)]` or `#[cfg(all(test, ...))]` at or after `from`: where it starts and
    /// what follows it (further attributes skipped).
    fn next_cfg_test(text: &str, from: usize) -> Option<(usize, &str)> {
        let plain = text[from..].find("#[cfg(test)]").map(|at| from + at);
        let all = text[from..].find("#[cfg(all(test").map(|at| from + at);
        let start = match (plain, all) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => return None,
        };
        let end = start
            + text[start..]
                .find("]\n")
                .map_or(text.len() - start, |at| at + 1);
        // Further attributes and comment lines between the attribute and the item are skipped
        // (vault.rs has a `//` note between `#[cfg(test)]` and `mod tests {`).
        let mut after = text[end..].trim_start();
        loop {
            if after.starts_with("#[") {
                match after.find(']') {
                    Some(close) => after = after[close + 1..].trim_start(),
                    None => break,
                }
            } else if after.starts_with("//") {
                after = after.find('\n').map_or("", |at| after[at..].trim_start());
            } else if after.starts_with("/*") {
                match after.find("*/") {
                    Some(close) => after = after[close + 2..].trim_start(),
                    None => break,
                }
            } else {
                break;
            }
        }
        Some((start, after))
    }

    /// The module a declaration names, and the character after its name (`{` for an inline module,
    /// `;` for a file of its own): `after` is what follows a test-only attribute.
    fn module_declaration(after: &str) -> Option<(&str, char)> {
        let rest = after
            .trim_start_matches("pub(crate) ")
            .trim_start_matches("pub ")
            .strip_prefix("mod ")?;
        let name_end = rest
            .find(|c: char| !(c.is_alphanumeric() || c == '_'))
            .unwrap_or(rest.len());
        let next = rest[name_end..].trim_start().chars().next()?;
        Some((&rest[..name_end], next))
    }

    /// The file's text with every inline test module (`#[cfg(test)] mod name { ... }`, wherever it
    /// stands) blanked out, so that only production code is left. The blanking keeps every byte
    /// offset and line break where it was. A `mod name;` declaration only names another file and
    /// blanks nothing here; code after an inline test module is production code again.
    fn production_code(text: &str) -> String {
        let mut code = String::with_capacity(text.len());
        let mut copied = 0;
        let mut from = 0;
        while let Some((start, after)) = next_cfg_test(text, from) {
            if copied <= start && module_declaration(after).is_some_and(|(_, next)| next == '{') {
                let module = text.len() - after.len();
                // A block that never closes is blanked to the end of the file.
                let end = block_end(text, module).unwrap_or(text.len());
                code.push_str(&text[copied..start]);
                for c in text[start..end].chars() {
                    let blank = if c == '\n' { '\n' } else { ' ' };
                    code.extend(std::iter::repeat_n(blank, c.len_utf8()));
                }
                copied = end;
                from = end;
                continue;
            }
            from = start + 1;
        }
        code.push_str(&text[copied..]);
        code
    }

    /// How many `Command::new` sites a file's production code hides with `hide_console`, and the
    /// line of each one that does not.
    fn scan(text: &str) -> (usize, Vec<usize>) {
        let code = production_code(text);
        let (mut hidden, mut unhidden) = (0, Vec::new());
        for (at, _) in code.match_indices("Command::new(") {
            let body = enclosing_function(&code, at).unwrap_or("");
            if body.contains("hide_console(") {
                hidden += 1;
            } else {
                unhidden.push(code[..at].matches('\n').count() + 1);
            }
        }
        (hidden, unhidden)
    }

    /// The files this file declares as test-only modules: `#[cfg(test)] mod name;` (every line of
    /// `name.rs`, or `name/mod.rs`, beside it or under this file's own folder, is test code).
    fn test_only_files(file: &Path, text: &str) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let directory = file.parent().unwrap();
        let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
        // `vault.rs` keeps its children in `vault/`; lib.rs, main.rs and mod.rs keep them beside it.
        let home = if matches!(stem.as_str(), "lib" | "main" | "mod") {
            directory.to_path_buf()
        } else {
            directory.join(&stem)
        };
        let mut from = 0;
        while let Some((start, after)) = next_cfg_test(text, from) {
            if let Some((name, ';')) = module_declaration(after) {
                found.push(home.join(format!("{name}.rs")));
                found.push(home.join(name).join("mod.rs"));
            }
            from = start + 1;
        }
        found
    }

    /// The offset just past the `}` that closes the block opened by the first `{` at or after
    /// `from`, skipping comments and string and character literals; `None` if it never closes.
    fn block_end(text: &str, from: usize) -> Option<usize> {
        let bytes = text.as_bytes();
        let mut depth = 0usize;
        let mut started = false;
        let mut at = from;
        while at < bytes.len() {
            match bytes[at] {
                b'/' if bytes.get(at + 1) == Some(&b'/') => {
                    while at < bytes.len() && bytes[at] != b'\n' {
                        at += 1;
                    }
                    continue;
                }
                b'/' if bytes.get(at + 1) == Some(&b'*') => {
                    let end = text[at + 2..].find("*/")?;
                    at += end + 4;
                    continue;
                }
                b'"' => {
                    at += 1;
                    while at < bytes.len() && bytes[at] != b'"' {
                        at += if bytes[at] == b'\\' { 2 } else { 1 };
                    }
                }
                // A character literal ('{', '\n'), not a lifetime ('a).
                b'\''
                    if bytes.get(at + 2) == Some(&b'\'')
                        || (bytes.get(at + 1) == Some(&b'\\')
                            && bytes.get(at + 3) == Some(&b'\'')) =>
                {
                    at += if bytes[at + 1] == b'\\' { 3 } else { 2 };
                }
                b'{' => {
                    depth += 1;
                    started = true;
                }
                b'}' => {
                    depth = depth.checked_sub(1)?;
                    if started && depth == 0 {
                        return Some(at + 1);
                    }
                }
                _ => {}
            }
            at += 1;
        }
        None
    }

    /// The text of the innermost function (free or method) that contains offset `at`.
    fn enclosing_function(code: &str, at: usize) -> Option<&str> {
        let mut best: Option<(usize, usize)> = None;
        let mut from = 0;
        while let Some(found) = code[from..].find("fn ") {
            let start = from + found;
            from = start + 3;
            if start >= at {
                break;
            }
            // `fn` as a keyword, not the tail of another word.
            let before = code[..start].chars().next_back();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            // Past the signature, which has no `{` or `;` before its body (`where` clauses excepted).
            let Some(end) = block_end(code, start) else {
                continue;
            };
            if end > at && best.is_none_or(|(inner, _)| start > inner) {
                best = Some((start, end));
            }
        }
        best.map(|(start, end)| &code[start..end])
    }

    #[test]
    fn the_scan_reads_modules_and_functions_as_they_are() {
        // `mod name;` cuts nothing, `mod name {` does.
        let declared = "fn a() { Command::new(\"x\"); }\n#[cfg(test)]\nmod other;\nfn b() { Command::new(\"y\"); }\n";
        assert_eq!(production_code(declared), declared);
        let inline =
            "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn t() { Command::new(\"y\"); }\n}\n";
        let blanked = production_code(inline);
        assert_eq!(
            blanked.len(),
            inline.len(),
            "every offset stays where it was"
        );
        assert!(blanked.starts_with("fn a() {}\n") && !blanked.contains("Command"));
        assert_eq!(blanked.matches('\n').count(), inline.matches('\n').count());
        let attributed = "#[cfg(test)]\n#[allow(dead_code)]\nmod tests {\n}\nfn p() {}\n";
        assert_eq!(production_code(attributed).trim(), "fn p() {}");
        // A comment between the attributes and the module does not hide the module (vault.rs).
        let noted = "#[cfg(test)]\n// a note }\n/* and { another */\n#[allow(dead_code)]\nmod tests {\n    fn t() { Command::new(\"t\"); }\n}\nfn p() { Command::new(\"p\"); }\n";
        assert_eq!(scan(noted), (0, vec![8]));
        // Production code after an inline test module is still production code (#442 follow-up):
        // the first test module does not end the scan, and what is inside any of them is not scanned.
        let after = "fn early() { Command::new(\"a\"); hide_console(&mut c); }\n\
            #[cfg(test)]\nmod tests {\n    fn t() { Command::new(\"in a test\"); }\n}\n\
            fn late() {\n    let c = Command::new(\"b\");\n}\n\
            #[cfg(all(test, unix))]\nmod more {\n    fn u() { Command::new(\"in another\"); }\n}\n\
            fn last() { Command::new(\"c\"); hide_console(&mut c); }\n";
        assert_eq!(
            scan(after),
            (2, vec![7]),
            "the unhidden call after the module is found"
        );
        // Braces in the module's strings and comments do not end it early, a lifetime is no literal.
        let tricky = "#[cfg(test)]\nmod tests {\n    fn t<'a>(s: &'a str) { let _ = \"}\"; /* } */ }\n}\nfn p() { Command::new(\"z\"); }\n";
        assert_eq!(scan(tricky), (0, vec![5]));
        // A module that never closes hides everything after it rather than nothing.
        assert_eq!(scan("#[cfg(test)]\nmod tests {\n fn t() {\n"), (0, vec![]));
        // `#[cfg(all(test, target_os = "linux"))] mod name;` names a test-only file too.
        let conditional = "#[cfg(all(test, target_os = \"linux\"))]\nmod extraction;\n";
        let named_conditional = test_only_files(Path::new("/s/src/lib.rs"), conditional);
        assert_eq!(named_conditional[0], Path::new("/s/src/extraction.rs"));
        // The file a `#[cfg(test)] mod name;` names is test code entirely.
        let named = test_only_files(Path::new("/s/src/vault.rs"), declared);
        assert_eq!(named[0], Path::new("/s/src/vault/other.rs"));
        let in_lib = test_only_files(Path::new("/s/src/lib.rs"), declared);
        assert_eq!(in_lib[0], Path::new("/s/src/other.rs"));
        // A call is hidden only by `hide_console` in ITS function, not in a neighbour or in the next fn.
        let source = "fn one() {\n    let c = Command::new(\"a\");\n}\nfn two() {\n    hide_console(&mut c);\n}\n";
        let at = source.find("Command::new(").unwrap();
        let body = enclosing_function(source, at).unwrap();
        assert!(!body.contains("hide_console(") && body.contains("fn one"));
        // Methods in an impl are their own scope, indented or not.
        let methods = "impl X {\n    fn plain(&self) {\n        let c = Command::new(\"a\");\n    }\n    fn hidden(&self) {\n        let c = Command::new(\"b\"); hide_console(&mut c);\n    }\n}\n";
        let first =
            enclosing_function(methods, methods.find("Command::new(\"a\"").unwrap()).unwrap();
        let second =
            enclosing_function(methods, methods.find("Command::new(\"b\"").unwrap()).unwrap();
        assert!(!first.contains("hide_console(") && first.contains("fn plain"));
        assert!(second.contains("hide_console(") && second.contains("fn hidden"));
        // Braces in strings, characters and comments do not end a block early.
        let tricky = "fn f() {\n    let s = \"}\"; let c = '}'; // }\n    /* } */\n    let d = Command::new(\"z\"); hide_console(&mut d);\n}\nfn g() {}\n";
        let inner = enclosing_function(tricky, tricky.find("Command::new(").unwrap()).unwrap();
        assert!(inner.contains("hide_console(") && !inner.contains("fn g"));
        // A nested closure's own `fn` item is the innermost function for what it holds.
        let nested = "fn outer() {\n    fn inner() { let c = Command::new(\"a\"); }\n    hide_console(&mut c);\n}\n";
        let found = enclosing_function(nested, nested.find("Command::new(").unwrap()).unwrap();
        assert!(found.starts_with("fn inner") && !found.contains("hide_console("));
    }

    #[test]
    fn every_command_this_app_starts_hides_its_console_on_windows() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        sources(&root, &mut files);
        assert!(files.len() > 40, "the scan found the source files");
        let mut test_only = Vec::new();
        for file in &files {
            test_only.extend(test_only_files(
                file,
                &std::fs::read_to_string(file).unwrap(),
            ));
        }
        assert!(
            test_only
                .iter()
                .any(|path| path.ends_with("vault/native_portal_flow.rs")),
            "the scan knows vault.rs's test-only file"
        );
        let mut unhidden = Vec::new();
        let mut hidden = 0;
        for file in files {
            if test_only.contains(&file) {
                continue;
            }
            let relative = file
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let text = std::fs::read_to_string(&file).unwrap();
            let (found, lines) = scan(&text);
            hidden += found;
            if !NOT_HIDDEN.iter().any(|(name, _)| *name == relative) {
                unhidden.extend(lines.iter().map(|line| format!("{relative}:{line}")));
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
        let code = production_code(text);
        assert!(
            !code.contains("Command::new"),
            "desktop_background starts no process"
        );
    }
}
