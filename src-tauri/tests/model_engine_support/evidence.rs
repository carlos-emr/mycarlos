//! Evidence validation for the manual harness. These tests never start a helper or model.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

/// Decode recursively without discarding contradictory duplicate fields.
pub(super) fn strict_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
    struct Unique(Value);
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct UniqueVisitor;
            impl<'de> Visitor<'de> for UniqueVisitor {
                type Value = Unique;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("JSON without duplicate object fields")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                    let mut object = serde_json::Map::new();
                    while let Some((key, Unique(value))) = map.next_entry::<String, Unique>()? {
                        if object.insert(key.clone(), value).is_some() {
                            return Err(serde::de::Error::custom(format!(
                                "duplicate JSON field: {key}"
                            )));
                        }
                    }
                    Ok(Unique(Value::Object(object)))
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                    let mut values = Vec::new();
                    while let Some(Unique(value)) = seq.next_element()? {
                        values.push(value);
                    }
                    Ok(Unique(Value::Array(values)))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_unit<E: serde::de::Error>(self) -> Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
            }
            deserializer.deserialize_any(UniqueVisitor)
        }
    }
    serde_json::from_slice::<Unique>(bytes).map(|value| value.0)
}

pub(super) fn executable_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn page_hash(document: &Value) -> Result<String, String> {
    let pages = document["pages"].as_array().ok_or("missing pages")?;
    if pages.is_empty() {
        return Err("empty pages".to_owned());
    }
    let mut hash = Sha256::new();
    let mut previous = None;
    for page in pages {
        let index = u32::try_from(page["index"].as_u64().ok_or("invalid page index")?)
            .map_err(|_| "page index exceeds u32")?;
        if previous.is_some_and(|last| index <= last) {
            return Err("page indexes must rise".to_owned());
        }
        previous = Some(index);
        let text = page["text"].as_str().ok_or("missing page text")?;
        hash.update(index.to_le_bytes());
        hash.update((text.len() as u64).to_le_bytes());
        hash.update(text.as_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub(super) fn document_manifest(documents: &[(String, Value)]) -> Result<Value, String> {
    let mut manifest = BTreeMap::new();
    for (id, document) in documents {
        if document["id"].as_str() != Some(id.as_str()) || id.is_empty() {
            return Err("document ID mismatch".to_owned());
        }
        let lang = document["lang"]
            .as_str()
            .ok_or("missing document language")?;
        let entry = json!({"pagesSha256": page_hash(document)?, "docLang": lang});
        if manifest.insert(id.clone(), entry).is_some() {
            return Err(format!("duplicate document ID {id}"));
        }
    }
    if manifest.is_empty() {
        return Err("empty document set".to_owned());
    }
    Ok(json!(manifest))
}

pub(super) struct Resume {
    pub(super) done: BTreeSet<String>,
    pub(super) needs_header: bool,
    pub(super) complete: bool,
}

pub(super) fn resume(bytes: &[u8], expected: &Value) -> Result<Resume, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "resume output is not UTF-8")?;
    if text.trim().is_empty() {
        return Ok(Resume {
            done: BTreeSet::new(),
            needs_header: true,
            complete: false,
        });
    }
    if !text.ends_with('\n') {
        return Err("resume output has an incomplete final write; preserve it and recover a copy before retrying".to_owned());
    }
    let records = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| strict_json(line.as_bytes()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "malformed resume JSON; preserve the file and recover a copy")?;
    let first = &records[0];
    if first["kind"] != "run" {
        return Err("resume output must start with its run header".to_owned());
    }
    for key in [
        "build",
        "lang",
        "threads",
        "commit",
        "variant",
        "runnerSha256",
        "harnessSha256",
        "documents",
    ] {
        if first.get(key).is_none() || first[key] != expected[key] {
            return Err(format!("resume identity differs or is missing: {key}"));
        }
    }
    for key in ["sha256", "chatFormat"] {
        if first["model"].get(key).is_none() || first["model"][key] != expected["model"][key] {
            return Err(format!(
                "resume model identity differs or is missing: {key}"
            ));
        }
    }
    let manifest = expected["documents"]
        .as_object()
        .ok_or("missing expected input manifest")?;
    let mut done = BTreeSet::new();
    let mut complete = false;
    for record in &records[1..] {
        if complete {
            return Err("records after terminal completion are not resumable".to_owned());
        }
        match record["kind"].as_str() {
            Some("document") => {
                let id = record["id"]
                    .as_str()
                    .ok_or("missing completed document ID")?;
                let input = manifest
                    .get(id)
                    .ok_or("completed ID is outside the current input set")?;
                if record["pagesSha256"] != input["pagesSha256"]
                    || record["docLang"] != input["docLang"]
                {
                    return Err(format!("completed document input differs: {id}"));
                }
                if !record.get("result").is_some_and(Value::is_object)
                    && !record.get("error").is_some_and(Value::is_string)
                {
                    return Err(format!("completed document has no result or failure: {id}"));
                }
                if !done.insert(id.to_owned()) {
                    return Err(format!("duplicate completed document: {id}"));
                }
            }
            Some("end") => {
                if record["answered"].as_u64() != Some(done.len() as u64)
                    || done.len() != manifest.len()
                {
                    return Err(
                        "terminal completion does not cover the declared input set".to_owned()
                    );
                }
                complete = true;
            }
            _ => return Err("unexpected record in resume output".to_owned()),
        }
    }
    Ok(Resume {
        done,
        needs_header: false,
        complete,
    })
}

/// Sync the actual attempted failure, then stop before consuming the next document.
/// A subsequent explicit run can resume the unattempted IDs; failed attempts stay recorded.
pub(super) fn write_attempts<'a>(
    documents: impl Iterator<Item = &'a (String, Value)>,
    mut attempt: impl FnMut(&str, &Value) -> Value,
    mut append: impl FnMut(&Value),
) -> Result<usize, usize> {
    let mut count = 0;
    for (id, document) in documents {
        let record = attempt(id, document);
        let failed = record.get("error").is_some();
        append(&record);
        count += 1;
        if failed {
            return Err(count);
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> Vec<(String, Value)> {
        ["blue", "green"]
            .into_iter()
            .map(|id| {
                (
                    id.to_owned(),
                    json!({"id":id,"lang":"en","pages":[{"index":0,"text":"FAKE blue card."}]}),
                )
            })
            .collect()
    }

    fn run() -> Value {
        json!({"kind":"run","build":{"fingerprint":"invented-build"},"lang":"en","threads":3,
            "commit":"invented-revision","variant":"invented-variant","runnerSha256":"invented-executable",
            "harnessSha256":"invented-harness",
            "model":{"sha256":"invented-model","chatFormat":"builtin"},
            "documents":document_manifest(&inputs()).unwrap()})
    }

    fn output(records: &[Value]) -> Vec<u8> {
        records
            .iter()
            .map(|v| format!("{v}\n"))
            .collect::<String>()
            .into_bytes()
    }

    fn attempted(run: &Value, id: &str, failed: bool) -> Value {
        let mut record = json!({"kind":"document","id":id,"docLang":"en",
            "pagesSha256":run["documents"][id]["pagesSha256"]});
        if failed {
            record["error"] = json!("synthetic timeout");
        } else {
            record["result"] = json!({"sentences":[]});
        }
        record
    }

    #[test]
    fn duplicate_fields_are_rejected_at_every_depth() {
        for bytes in [
            br#"{"error":"Timeout","error":null}"#.as_slice(),
            br#"{"model":{"sha256":"a","sha256":"b"}}"#.as_slice(),
            br#"{"sentences":[{"text":"a","text":"b"}]}"#.as_slice(),
            br#"{"pages":[{"index":0,"text":"a","text":"b"}]}"#.as_slice(),
        ] {
            assert!(strict_json(bytes).is_err());
            let mut output = output(&[run()]);
            output.extend_from_slice(bytes);
            output.push(b'\n');
            assert!(resume(&output, &run()).is_err());
        }
        assert_eq!(
            strict_json(br#"{"a":[1,null,true,"text",1.5]}"#).unwrap(),
            json!({"a":[1,null,true,"text",1.5]})
        );
    }

    #[test]
    fn an_empty_file_is_a_new_run() {
        assert!(resume(b"", &run()).unwrap().needs_header);
    }

    #[test]
    fn each_implementation_configuration_and_input_change_refuses_resume() {
        let original = run();
        for key in [
            "build",
            "lang",
            "threads",
            "commit",
            "variant",
            "runnerSha256",
            "harnessSha256",
            "documents",
        ] {
            let mut changed = original.clone();
            changed[key] = json!("different");
            assert!(
                resume(&output(std::slice::from_ref(&original)), &changed).is_err(),
                "{key}"
            );
        }
        for key in ["sha256", "chatFormat"] {
            let mut changed = original.clone();
            changed["model"][key] = json!("different");
            assert!(
                resume(&output(std::slice::from_ref(&original)), &changed).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn partial_tail_or_malformed_json_is_refused_without_discarding_evidence() {
        let original = run();
        let mut bytes = output(std::slice::from_ref(&original));
        bytes.extend_from_slice(b"{\"kind\":");
        let snapshot = bytes.clone();
        assert!(resume(&bytes, &original).is_err());
        assert_eq!(bytes, snapshot);
        assert!(resume(b"{broken}\n", &original).is_err());
    }

    #[test]
    fn failed_attempts_are_preserved_but_remaining_documents_stay_resumable() {
        let original = run();
        let docs = inputs();
        let mut visited = Vec::new();
        let mut records = vec![original.clone()];
        let result = write_attempts(
            docs.iter(),
            |id, _| {
                visited.push(id.to_owned());
                attempted(&original, id, true)
            },
            |record| records.push(record.clone()),
        );
        assert_eq!(result, Err(1));
        assert_eq!(visited, ["blue"]);
        let state = resume(&output(&records), &original).unwrap();
        assert!(state.done.contains("blue"));
        assert!(!state.done.contains("green"));
        assert!(!state.complete);
        write_attempts(
            docs.iter().filter(|(id, _)| !state.done.contains(id)),
            |id, _| attempted(&original, id, false),
            |record| records.push(record.clone()),
        )
        .unwrap();
        records.push(json!({"kind":"end","answered":2}));
        assert!(records[1].get("error").is_some());
        assert!(resume(&output(&records), &original).unwrap().complete);
    }

    #[test]
    fn changed_completed_input_or_duplicate_attempt_cannot_be_skipped() {
        let original = run();
        let good = attempted(&original, "blue", false);
        let mut changed = good.clone();
        changed["pagesSha256"] = json!("different");
        assert!(resume(&output(&[original.clone(), changed]), &original).is_err());
        assert!(resume(&output(&[original.clone(), good.clone(), good]), &original).is_err());
    }

    #[test]
    fn completion_requires_all_inputs_and_is_terminal() {
        let original = run();
        let blue = attempted(&original, "blue", false);
        assert!(resume(
            &output(&[
                original.clone(),
                blue.clone(),
                json!({"kind":"end","answered":1})
            ]),
            &original
        )
        .is_err());
        let mut records = vec![
            original.clone(),
            blue,
            attempted(&original, "green", false),
            json!({"kind":"end","answered":2}),
        ];
        assert!(resume(&output(&records), &original).unwrap().complete);
        records.push(attempted(&original, "green", false));
        assert!(resume(&output(&records), &original).is_err());
    }

    #[test]
    fn manifest_tracks_unicode_page_bytes_and_document_language() {
        let original = document_manifest(&inputs()).unwrap();
        let mut docs = inputs();
        docs[0].1["pages"][0]["text"] = json!("FAKE café card.");
        assert_ne!(original, document_manifest(&docs).unwrap());
        docs[0].1["lang"] = json!("fr");
        let translated = document_manifest(&docs).unwrap();
        assert_ne!(translated["blue"]["docLang"], original["blue"]["docLang"]);
        docs.push(docs[0].clone());
        assert!(document_manifest(&docs).is_err());
    }
}
