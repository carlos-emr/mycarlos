//! Signature preflight and PDF structure extraction in the existing confined helper.
//! The main process authenticates the signature and clinic pin before sending
//! a password for attachment extraction. Neither stage rewrites the document.
use crate::signed_pdf::{PinnedLink, Refusal, SignatureLayout, Verdict};
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub(crate) const MAGIC: &[u8; 8] = b"MCPDFSG1";
const RESPONSE: &[u8; 8] = b"MCPDFSA1";
const MAX_MANIFEST: usize = 16 * 1024;
const MAX_RESPONSE: usize = 128 * 1024;
const MANIFEST_NAME: &[u8] = b"carlos-document-manifest.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    layout: SignatureLayout,
    manifest: Option<Vec<u8>>,
}

/// A deliberately conservative candidate scan, before parsing/decrypting PDF
/// objects. It grants no trust: a full parsed structure is required afterwards.
fn preflight(pdf: &[u8]) -> Result<SignatureLayout, Refusal> {
    const NAME: &[u8] = b"/ByteRange";
    let mut ranges = Vec::new();
    let mut at = 0;
    while let Some(offset) = pdf[at..].windows(NAME.len()).position(|part| part == NAME) {
        at += offset + NAME.len();
        if pdf
            .get(at)
            .is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'[')
        {
            continue;
        }
        let tail = &pdf[at..pdf.len().min(at.saturating_add(192))];
        let tail = tail.trim_ascii_start();
        if tail.first() != Some(&b'[') {
            return Err(Refusal::BadRange);
        }
        let end = tail
            .iter()
            .position(|byte| *byte == b']')
            .ok_or(Refusal::BadRange)?;
        let values: Vec<usize> = tail[1..end]
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|part| !part.is_empty())
            .map(|part| {
                if part.is_empty() || !part.iter().all(u8::is_ascii_digit) {
                    return Err(Refusal::BadRange);
                }
                std::str::from_utf8(part)
                    .ok()
                    .and_then(|text| text.parse().ok())
                    .ok_or(Refusal::BadRange)
            })
            .collect::<Result<_, _>>()?;
        let range: [usize; 4] = values.try_into().map_err(|_| Refusal::BadRange)?;
        ranges.push(range);
        if ranges.len() == 2 {
            break;
        }
    }
    let update_after_signature = ranges.first().is_some_and(|[_, _, c, d]| {
        c.checked_add(*d)
            .and_then(|end| pdf.get(end..))
            .is_some_and(|tail| tail.windows(5).any(|part| part == b"%%EOF"))
    });
    Ok(SignatureLayout {
        byte_ranges: ranges,
        update_after_signature,
        encrypted: pdf.windows(8).any(|part| part == b"/Encrypt"),
    })
}

fn resolve<'a>(
    doc: &'a lopdf::Document,
    object: &'a lopdf::Object,
) -> Result<&'a lopdf::Object, Refusal> {
    doc.dereference(object)
        .map(|(_, value)| value)
        .map_err(|_| Refusal::BadStructure)
}

fn ranges(dictionary: &lopdf::Dictionary) -> Result<[usize; 4], Refusal> {
    let values = dictionary
        .get(b"ByteRange")
        .and_then(lopdf::Object::as_array)
        .map_err(|_| Refusal::BadStructure)?;
    if values.len() != 4 {
        return Err(Refusal::BadStructure);
    }
    let mut result = [0; 4];
    for (to, value) in result.iter_mut().zip(values) {
        *to = value
            .as_i64()
            .ok()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or(Refusal::BadStructure)?;
    }
    Ok(result)
}

/// Require exactly one signature dictionary and exactly one reachable AcroForm
/// signature value referencing it, with no hidden second signature or cycles.
fn signature_structure(doc: &lopdf::Document) -> Result<[usize; 4], Refusal> {
    use lopdf::Object;
    let signatures: Vec<_> = doc
        .objects
        .iter()
        .filter_map(|(id, object)| {
            object
                .as_dict()
                .ok()
                .filter(|dict| dict.get(b"Type").and_then(Object::as_name).ok() == Some(b"Sig"))
                .map(|dict| (*id, dict))
        })
        .take(3)
        .collect();
    let [(signature_id, signature)] = signatures.as_slice() else {
        return Err(Refusal::BadStructure);
    };
    if signature.get(b"SubFilter").and_then(Object::as_name).ok() != Some(b"ETSI.CAdES.detached")
        || signature.get(b"Filter").and_then(Object::as_name).ok() != Some(b"Adobe.PPKLite")
    {
        return Err(Refusal::BadStructure);
    }
    let catalog = doc.catalog().map_err(|_| Refusal::BadStructure)?;
    if catalog.get(b"Type").and_then(Object::as_name).ok() != Some(b"Catalog") {
        return Err(Refusal::BadStructure);
    }
    let form = resolve(
        doc,
        catalog
            .get(b"AcroForm")
            .map_err(|_| Refusal::BadStructure)?,
    )?
    .as_dict()
    .map_err(|_| Refusal::BadStructure)?;
    let fields = resolve(doc, form.get(b"Fields").map_err(|_| Refusal::BadStructure)?)?
        .as_array()
        .map_err(|_| Refusal::BadStructure)?;
    let mut todo: Vec<_> = fields.iter().map(|field| (field, false, 0usize)).collect();
    let mut seen = std::collections::HashSet::new();
    let mut values = Vec::new();
    let mut visited = 0;
    while let Some((field, inherited, depth)) = todo.pop() {
        visited += 1;
        if visited > 256 || depth > 32 {
            return Err(Refusal::BadStructure);
        }
        if let Ok(id) = field.as_reference() {
            if !seen.insert(id) {
                return Err(Refusal::BadStructure);
            }
        }
        let field = resolve(doc, field)?
            .as_dict()
            .map_err(|_| Refusal::BadStructure)?;
        let is_signature = field
            .get(b"FT")
            .and_then(Object::as_name)
            .map(|name| name == b"Sig")
            .unwrap_or(inherited);
        if is_signature {
            if let Ok(value) = field.get(b"V") {
                values.push(value.as_reference().map_err(|_| Refusal::BadStructure)?);
            }
        }
        if let Ok(kids) = field.get(b"Kids") {
            let kids = resolve(doc, kids)?
                .as_array()
                .map_err(|_| Refusal::BadStructure)?;
            if kids.len() > 256 {
                return Err(Refusal::BadStructure);
            }
            todo.extend(kids.iter().map(|kid| (kid, is_signature, depth + 1)));
        }
    }
    if values.as_slice() != [*signature_id] {
        return Err(Refusal::BadStructure);
    }
    ranges(signature)
}

fn exact_name(bytes: &[u8]) -> bool {
    bytes == MANIFEST_NAME
        || (bytes.starts_with(&[0xfe, 0xff])
            && bytes[2..].len() == MANIFEST_NAME.len() * 2
            && bytes[2..]
                .chunks_exact(2)
                .zip(MANIFEST_NAME)
                .all(|(pair, byte)| pair == [0, *byte]))
}

fn manifest(doc: &lopdf::Document) -> Result<Option<Vec<u8>>, Refusal> {
    use lopdf::Object;
    let catalog = doc.catalog().map_err(|_| Refusal::BadStructure)?;
    let Ok(names) = catalog.get(b"Names") else {
        return Ok(None);
    };
    let names = resolve(doc, names)?
        .as_dict()
        .map_err(|_| Refusal::BadManifest)?;
    let Ok(embedded) = names.get(b"EmbeddedFiles") else {
        return Ok(None);
    };
    let mut todo = vec![(embedded, 0usize)];
    let mut visited = 0;
    let mut matches = Vec::new();
    while let Some((node, depth)) = todo.pop() {
        visited += 1;
        if visited > 128 || depth > 16 {
            return Err(Refusal::BadManifest);
        }
        let node = resolve(doc, node)?
            .as_dict()
            .map_err(|_| Refusal::BadManifest)?;
        if let Ok(entries) = node.get(b"Names") {
            let entries = resolve(doc, entries)?
                .as_array()
                .map_err(|_| Refusal::BadManifest)?;
            if entries.len() > 256 || !entries.len().is_multiple_of(2) {
                return Err(Refusal::BadManifest);
            }
            for pair in entries.chunks_exact(2) {
                if pair[0].as_str().ok().is_some_and(exact_name) {
                    matches.push(pair[1].as_reference().map_err(|_| Refusal::BadManifest)?);
                }
            }
        }
        if let Ok(kids) = node.get(b"Kids") {
            let kids = resolve(doc, kids)?
                .as_array()
                .map_err(|_| Refusal::BadManifest)?;
            if kids.len() > 128 {
                return Err(Refusal::BadManifest);
            }
            todo.extend(kids.iter().map(|kid| (kid, depth + 1)));
        }
    }
    if matches.is_empty() {
        return Ok(None);
    }
    let [file] = matches.as_slice() else {
        return Err(Refusal::BadManifest);
    };
    let associated = resolve(doc, catalog.get(b"AF").map_err(|_| Refusal::BadManifest)?)?
        .as_array()
        .map_err(|_| Refusal::BadManifest)?;
    if associated.len() > 128
        || associated
            .iter()
            .filter(|value| value.as_reference().ok() == Some(*file))
            .count()
            != 1
    {
        return Err(Refusal::BadManifest);
    }
    let file = doc
        .get_object(*file)
        .and_then(Object::as_dict)
        .map_err(|_| Refusal::BadManifest)?;
    if file.get(b"AFRelationship").and_then(Object::as_name).ok() != Some(b"Data")
        || !file
            .get(b"F")
            .and_then(Object::as_str)
            .ok()
            .is_some_and(exact_name)
        || file
            .get(b"UF")
            .is_ok_and(|name| !name.as_str().ok().is_some_and(exact_name))
    {
        return Err(Refusal::BadManifest);
    }
    let ef = resolve(doc, file.get(b"EF").map_err(|_| Refusal::BadManifest)?)?
        .as_dict()
        .map_err(|_| Refusal::BadManifest)?;
    let stream = resolve(doc, ef.get(b"F").map_err(|_| Refusal::BadManifest)?)?
        .as_stream()
        .map_err(|_| Refusal::BadManifest)?;
    let bytes = stream
        .decompressed_content_with_limit(MAX_MANIFEST)
        .map_err(|_| Refusal::BadManifest)?;
    if bytes.len() > MAX_MANIFEST {
        return Err(Refusal::BadManifest);
    }
    Ok(Some(bytes))
}

/// Only runs in the confined child, after main authenticated the signature.
fn extract(pdf: &[u8], password: &str) -> Result<Report, Refusal> {
    let layout = preflight(pdf)?;
    let doc = lopdf::Document::load_mem_with_options(
        pdf,
        lopdf::LoadOptions {
            password: (!password.is_empty()).then(|| password.to_owned()),
            strict: true,
            max_decompressed_size: Some(16 * 1024 * 1024),
            ..Default::default()
        },
    )
    .map_err(|_| Refusal::BadStructure)?;
    if doc.is_encrypted() {
        return Err(Refusal::EncryptedManifest);
    }
    if layout.byte_ranges.as_slice() != [signature_structure(&doc)?] {
        return Err(Refusal::BadStructure);
    }
    Ok(Report {
        layout,
        manifest: manifest(&doc)?,
    })
}

pub(crate) fn answer(input: &mut impl Read, out: &mut impl Write) -> i32 {
    let mut stage = [0];
    if input.read_exact(&mut stage).is_err() {
        return 3;
    }
    let result = match crate::pdf_unlock::read_password_and_pdf(input) {
        Ok(crate::pdf_unlock::Request::Read { password, pdf }) => match stage[0] {
            0 if password.is_empty() => preflight(&pdf).map(|layout| Report {
                layout,
                manifest: None,
            }),
            1 => extract(&pdf, &password),
            _ => return 3,
        },
        _ => return 3,
    };
    let Ok(bytes) = serde_json::to_vec(&result) else {
        return 3;
    };
    if bytes.len() > MAX_RESPONSE {
        return 3;
    }
    if out
        .write_all(RESPONSE)
        .and_then(|()| out.write_all(&(bytes.len() as u32).to_le_bytes()))
        .and_then(|()| out.write_all(&bytes))
        .and_then(|()| out.flush())
        .is_ok()
    {
        0
    } else {
        3
    }
}

#[cfg(desktop)]
fn read_response(input: &mut io::PipeReader) -> Option<Result<Report, Refusal>> {
    let mut magic = [0; 8];
    input.read_exact(&mut magic).ok()?;
    if &magic != RESPONSE {
        return None;
    }
    let mut size = [0; 4];
    input.read_exact(&mut size).ok()?;
    let size = u32::from_le_bytes(size) as usize;
    if size > MAX_RESPONSE {
        return None;
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).ok()?;
    let result: Result<Report, Refusal> = serde_json::from_slice(&bytes).ok()?;
    if result.as_ref().is_ok_and(|report| {
        report.layout.byte_ranges.len() > 2
            || report
                .manifest
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_MANIFEST)
    }) {
        return None;
    }
    Some(result)
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    Refused(Refusal),
    #[cfg_attr(desktop, allow(dead_code))]
    Unavailable,
    HelperFailed,
    Cancelled,
    TooLarge,
}

/// Captures only the existing authenticated object-verification read, up to
/// the helper's input budget. The original encrypted object is never changed.
pub(crate) struct ImportProbe {
    bytes: zeroize::Zeroizing<Vec<u8>>,
    over: bool,
}

impl ImportProbe {
    pub(crate) fn new() -> Self {
        Self {
            bytes: zeroize::Zeroizing::new(Vec::new()),
            over: false,
        }
    }

    pub(crate) fn finish(self, cancelled: &dyn Fn() -> bool) -> Option<Failure> {
        self.finish_with(|bytes| {
            // No authenticated portal linking exists yet. Test pins are never
            // a production fallback, so this path cannot grant Verified.
            verify(bytes, "", &[], cancelled)
                .err()
                .unwrap_or(Failure::Refused(Refusal::UnknownSigner))
        })
    }

    fn finish_with(self, verify: impl FnOnce(&[u8]) -> Failure) -> Option<Failure> {
        if self.over {
            return Some(Failure::TooLarge);
        }
        if !self.bytes.starts_with(b"%PDF-")
            || !self.bytes.windows(9).any(|part| part == b"/ByteRange")
        {
            return None;
        }
        Some(verify(&self.bytes))
    }
}

impl Write for ImportProbe {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        use zeroize::Zeroize;
        if !self.over {
            if self.bytes.len().saturating_add(bytes.len())
                > crate::pdf_unlock::MAX_LOCKED_PDF_BYTES
            {
                self.bytes.zeroize();
                self.over = true;
            } else {
                self.bytes.extend_from_slice(bytes);
            }
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn verify(
    pdf: &[u8],
    password: &str,
    links: &[PinnedLink],
    cancelled: &dyn Fn() -> bool,
) -> Result<Verdict, Failure> {
    #[cfg(desktop)]
    {
        use crate::pdf_unlock;
        use zeroize::Zeroizing;
        if pdf.len() > pdf_unlock::MAX_LOCKED_PDF_BYTES
            || password.len() > pdf_unlock::MAX_PASSWORD_BYTES
        {
            return Err(Failure::TooLarge);
        }
        let executable = std::env::current_exe().map_err(|_| Failure::HelperFailed)?;
        let ask = |stage, password: &str| {
            if cancelled() {
                return Err(Failure::Cancelled);
            }
            let mut request = Zeroizing::new(Vec::with_capacity(pdf.len() + password.len() + 21));
            request.extend_from_slice(MAGIC);
            request.push(stage);
            pdf_unlock::write_password_and_pdf(&mut *request, password.as_bytes(), pdf)
                .map_err(|_| Failure::HelperFailed)?;
            let answer = pdf_unlock::exchange(
                pdf_unlock::helper_command(&executable),
                request,
                pdf_unlock::HELPER_TIME_LIMIT,
                read_response,
                cancelled,
            );
            if cancelled() {
                return Err(Failure::Cancelled);
            }
            answer
                .map_err(|_| Failure::HelperFailed)?
                .map_err(Failure::Refused)
        };
        let candidate = ask(0, "")?;
        crate::signed_pdf::authenticate(pdf, &candidate.layout, links).map_err(Failure::Refused)?;
        let full = ask(1, password)?;
        if full.layout != candidate.layout {
            return Err(Failure::Refused(Refusal::BadStructure));
        }
        crate::signed_pdf::check(pdf, &full.layout, full.manifest.as_deref(), links)
            .map_err(Failure::Refused)
    }
    #[cfg(not(desktop))]
    {
        let _ = (pdf, password, links, cancelled);
        Err(Failure::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn current_fixtures_pass_the_complete_two_stage_check_with_explicit_fake_pins() {
        let fixtures: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../tests/fixtures/mycarlos-signed-pdf-fixtures.json"
        ))
        .unwrap();
        let link = &fixtures["link"];
        let links = [PinnedLink {
            clinic_id: link["clinic_id"].as_str().unwrap().to_owned(),
            recipient_id: link["recipient_id"].as_str().unwrap().to_owned(),
            signer_kids: vec![link["signer_kid"].as_str().unwrap().to_owned()],
        }];
        for document in fixtures["documents"].as_array().unwrap() {
            let pdf = STANDARD
                .decode(document["pdf_b64"].as_str().unwrap())
                .unwrap();
            let candidate = preflight(&pdf).unwrap();
            let result = crate::signed_pdf::authenticate(&pdf, &candidate, &links).and_then(|()| {
                let full = extract(&pdf, document["password"].as_str().unwrap_or(""))?;
                assert_eq!(full.layout, candidate);
                crate::signed_pdf::check(&pdf, &full.layout, full.manifest.as_deref(), &links)
            });
            let code = match result {
                Ok(Verdict::Verified { .. }) => "verified".to_owned(),
                Ok(Verdict::SignedNotMatched { .. }) => "signed_not_matched".to_owned(),
                Err(refusal) => serde_json::to_value(refusal)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned(),
            };
            assert_eq!(
                code,
                document["expect"].as_str().unwrap(),
                "{}",
                document["name"]
            );
            assert!(
                crate::signed_pdf::authenticate(&pdf, &candidate, &[]).is_err(),
                "no fixture may become trusted without an authenticated pin"
            );
        }
    }

    #[test]
    fn malformed_preflight_ranges_and_unbounded_numbers_are_refused() {
        for pdf in [
            b"/ByteRange [-1 2 3 4]".as_slice(),
            b"/ByteRange [0 1 2]",
            b"/ByteRange [0 1 2 999999999999999999999999999999999999]",
            b"/ByteRange [0 1.5 2 4]",
            b"/ByteRange [0 1 2 4",
        ] {
            assert!(matches!(preflight(pdf), Err(Refusal::BadRange)));
        }
    }

    #[test]
    fn the_import_probe_uses_exact_original_bytes_without_a_trust_fallback() {
        let original = b"%PDF-1.7\n/ByteRange [0 1 3 5]\nFAKE document";
        let mut probe = ImportProbe::new();
        for chunk in original.chunks(7) {
            probe.write_all(chunk).unwrap();
        }
        let mut calls = 0;
        let reason = probe.finish_with(|bytes| {
            calls += 1;
            assert_eq!(bytes, original);
            Failure::Refused(Refusal::UnknownSigner)
        });
        assert!(matches!(
            reason,
            Some(Failure::Refused(Refusal::UnknownSigner))
        ));
        assert_eq!(calls, 1);
        let mut unsigned = ImportProbe::new();
        unsigned.write_all(b"%PDF-1.7\nFAKE unsigned").unwrap();
        assert!(unsigned
            .finish_with(|_| panic!("unsigned imports need no subprocess"))
            .is_none());
    }
}
