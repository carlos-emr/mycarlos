//! The redacting `Debug` (`redact_debug!`): what it prints, and a scan that keeps the list of
//! redacted types honest. FAKE data only.

use std::path::{Path, PathBuf};

struct Probe {
    #[allow(dead_code)]
    secret: String,
}
// The inner macro has no `cfg`, so the impl exists in this test build.
redact_debug_impl!(Probe);

#[test]
fn a_redacted_type_prints_only_its_name_in_both_debug_forms() {
    let probe = Probe {
        secret: "FAKE Jamie Patient, health number 0000".to_owned(),
    };
    assert_eq!(format!("{probe:?}"), "Probe { .. }");
    assert_eq!(format!("{probe:#?}"), "Probe { .. }");
    assert_eq!(format!("{:?}", Some(&probe)), "Some(Probe { .. })");
}

/// Production sources: every `.rs` under `src`, apart from files named for tests, each cut at its
/// first `#[cfg(test)]` that is followed by a module line.
fn production_sources() -> Vec<(PathBuf, Vec<String>)> {
    let mut found = Vec::new();
    let mut folders = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(folder) = folders.pop() {
        for item in std::fs::read_dir(&folder).unwrap() {
            let path = item.unwrap().path();
            if path.is_dir() {
                folders.push(path);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if !name.ends_with(".rs") || name.contains("test") || name == "ui_text_ids.rs" {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            found.push((path, production_lines(&text)));
        }
    }
    found
}

fn production_lines(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let cut = (0..lines.len())
        .find(|&n| {
            lines[n].trim() == "#[cfg(test)]"
                && lines.get(n + 1).is_some_and(|next| {
                    let next = next.trim_start();
                    next.starts_with("mod ")
                        || next.starts_with("pub mod ")
                        || next.starts_with("pub(crate) mod ")
                })
        })
        .unwrap_or(lines.len());
    lines[..cut].iter().map(|line| (*line).to_owned()).collect()
}

/// A type's definition in `lines`: the attribute lines above it, the lines of its own braces, and
/// its name.
struct Definition {
    name: String,
    attributes: Vec<String>,
    fields: Vec<(String, String)>,
}

fn definitions(lines: &[String]) -> Vec<Definition> {
    let mut found = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let rest = ["pub(crate) ", "pub ", ""]
            .iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
            .unwrap_or(trimmed);
        let Some(after) = rest
            .strip_prefix("struct ")
            .or_else(|| rest.strip_prefix("enum "))
        else {
            continue;
        };
        let name: String = after
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if name.is_empty() {
            continue;
        }
        let mut attributes = Vec::new();
        let mut above = index;
        while above > 0 {
            let previous = lines[above - 1].trim();
            if previous.starts_with("#[") || previous.starts_with("///") || previous.is_empty() {
                if previous.starts_with("#[") {
                    attributes.push(previous.to_owned());
                }
                above -= 1;
                if previous.is_empty() {
                    break;
                }
            } else {
                break;
            }
        }
        let mut fields = Vec::new();
        let mut depth = 0_i32;
        for body in &lines[index..] {
            depth += body.matches('{').count() as i32 - body.matches('}').count() as i32;
            if let Some((field, ty)) = body.trim().trim_end_matches(',').split_once(':') {
                let field = field
                    .trim()
                    .trim_start_matches("pub(crate) ")
                    .trim_start_matches("pub ");
                if !field.is_empty() && field.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    fields.push((field.to_owned(), ty.trim().to_owned()));
                }
            }
            if depth <= 0 {
                break;
            }
        }
        found.push(Definition {
            name,
            attributes,
            fields,
        });
    }
    found
}

fn derives_plain_debug(attributes: &[String]) -> bool {
    attributes.iter().any(|attribute| {
        attribute.starts_with("#[derive(")
            && attribute
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .any(|word| word == "Debug")
    })
}

fn derives_debug_in_tests_only(attributes: &[String]) -> bool {
    attributes
        .iter()
        .any(|attribute| attribute.replace(' ', "") == "#[cfg_attr(test,derive(Debug))]")
}

/// Field names that hold a person's, a document's or an answer's text.
const TEXT_FIELDS: &[&str] = &[
    "text",
    "readable_text",
    "context",
    "name",
    "original_name",
    "display_name",
    "full_name",
    "clinic_name",
    "provider_name",
    "body",
    "contents",
    "token",
    "title",
    "term",
    "quote",
    "quotes",
    "answer",
    "summary",
    "overview",
    "heading",
    "passphrase",
    "secret",
    "code",
    "receipt_code",
];

/// The types that derive a plain `Debug` with a text-like `String` field and are fine so: each
/// with the reason. A new entry needs a reviewer's reason; the default is `redact_debug!`.
const ALLOWED: &[(&str, &str)] = &[
    ("Settings", "the AI model's catalogue name, public"),
    ("ModelInfo", "the AI model's catalogue name, public"),
    (
        "Notice",
        "a Linux desktop notification: the app name and one fixed sentence from the catalogue, never a name or document text",
    ),
];

fn redacted_names(lines: &[String]) -> Vec<String> {
    let mut names = Vec::new();
    for line in lines {
        let line = line.trim();
        if let Some(list) = line
            .strip_prefix("redact_debug!(")
            .and_then(|rest| rest.strip_suffix(");"))
        {
            names.extend(list.split(',').map(|name| name.trim().to_owned()));
        }
    }
    names
}

fn offences_in(path: &Path, lines: &[String]) -> Vec<String> {
    let mut offences = Vec::new();
    let defined = definitions(lines);
    for name in redacted_names(lines) {
        match defined.iter().find(|definition| definition.name == name) {
            None => offences.push(format!(
                "{}: redact_debug!({name}) has no definition here",
                path.display()
            )),
            Some(definition) => {
                if derives_plain_debug(&definition.attributes)
                    || !derives_debug_in_tests_only(&definition.attributes)
                {
                    offences.push(format!(
                        "{}: {name} is redacted but not by cfg_attr(test, derive(Debug)) alone",
                        path.display()
                    ));
                }
            }
        }
    }
    for definition in &defined {
        let texty: Vec<&str> = definition
            .fields
            .iter()
            .filter(|(field, ty)| TEXT_FIELDS.contains(&field.as_str()) && ty.contains("String"))
            .map(|(field, _)| field.as_str())
            .collect();
        if derives_plain_debug(&definition.attributes)
            && !texty.is_empty()
            && !ALLOWED.iter().any(|(name, _)| *name == definition.name)
        {
            offences.push(format!(
                "{}: {} derives Debug and holds text ({}): redact it or list it in ALLOWED with a reason",
                path.display(),
                definition.name,
                texty.join(", ")
            ));
        }
    }
    offences
}

/// What a green run of this scan does NOT prove (it is a ratchet, not an audit):
/// - Tuple structs and tuple variants are not read: a text field is only seen when it is a named
///   field on its own line, so `UnlocatedQuotes(Vec<(usize, String)>)` and `RunnerError::Model(String)`
///   are redacted by hand, and a new one like them has to be added by hand.
/// - A `#[derive(...)]` split over several lines is not read (none exists today).
/// - Files with "test" in their name are skipped, and so is everything after a source file's first
///   `#[cfg(test)]` module.
/// - Only a `String` field whose NAME is in `TEXT_FIELDS` counts as text: a text held in a `Vec<u8>`,
///   a `PathBuf`, or a field called something else (`message`, `reason`) is not seen.
#[test]
fn every_redacted_type_derives_debug_only_in_tests_and_no_text_type_prints_in_release() {
    let mut offences = Vec::new();
    for (path, lines) in production_sources() {
        offences.extend(offences_in(&path, &lines));
    }
    assert!(offences.is_empty(), "{offences:#?}");
}

#[test]
fn the_scan_finds_a_text_type_with_plain_debug_and_a_redaction_that_kept_it() {
    let lines = |text: &str| production_lines(text);
    let plain = lines("#[derive(Clone, Debug)]\npub struct Leaky {\n    pub title: String,\n}\n");
    assert_eq!(offences_in(Path::new("x.rs"), &plain).len(), 1);
    let numbers = lines("#[derive(Debug)]\nstruct Count {\n    pub total: u64,\n}\n");
    assert!(offences_in(Path::new("x.rs"), &numbers).is_empty());
    let redacted = lines(
        "#[cfg_attr(test, derive(Debug))]\n#[derive(Clone)]\npub struct Safe {\n    pub title: String,\n}\nredact_debug!(Safe);\n",
    );
    assert!(offences_in(Path::new("x.rs"), &redacted).is_empty());
    // A redaction whose type still derives plain Debug (a duplicate impl in a release build), or
    // that has no definition, is found.
    let kept = lines(
        "#[derive(Debug)]\npub struct Safe {\n    pub title: String,\n}\nredact_debug!(Safe);\n",
    );
    assert!(!offences_in(Path::new("x.rs"), &kept).is_empty());
    let missing = lines("redact_debug!(Nowhere);\n");
    assert_eq!(offences_in(Path::new("x.rs"), &missing).len(), 1);
    // The test module is not production.
    let tested = lines(
        "#[cfg(test)]\nmod tests {\n    #[derive(Debug)]\n    struct T { text: String }\n}\n",
    );
    assert!(offences_in(Path::new("x.rs"), &tested).is_empty());
}
