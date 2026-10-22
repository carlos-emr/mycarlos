//! Checks a PDF that CARLOS signed for a patient (#55; carlos-portal #41 M1):
//! one PAdES signature (ETSI.CAdES.detached, ECDSA P-256 with SHA-256) that
//! covers the whole file, made with a clinic key pinned for one of the
//! patient's portal links, and the `carlos-document-manifest.json` embedded
//! in the signed revision.
//!
//! The checks run in A3's order, and the first failure decides:
//! 1. the reported signature: exactly one in the supplied layout, its byte
//!    range covering the whole file with nothing after it, its /Contents
//!    one CMS SignedData and zero padding, the
//!    signed attributes' digest and the ECDSA signature correct, and the
//!    signer's key pinned for a link;
//! 2. the manifest's shape (RFC 8785 JSON, exactly the agreed members);
//! 3. the manifest's kid and clinic against the signer and the link;
//! 4. its recipient against the link: the same recipient is Verified, and
//!    none or another is "signed, not matched to you", never Verified.
//!
//! This module parses CMS and the manifest, never PDF objects. The confined
//! helper first supplies conservative signature ranges. Main authenticates the
//! signature and pinned key before sending a password for complete PDF structure
//! and attachment extraction. The current CMS manifest-digest attribute binds the
//! exact extracted bytes, including an encrypted email attachment. Unknown pins
//! never become trusted; production authenticated linking remains future work.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cms::cert::CertificateChoices;
use cms::content_info::CmsVersion;
use cms::content_info::ContentInfo;
use cms::signed_data::{CertificateSet, EncapsulatedContentInfo, SignerIdentifier};
use der::asn1::{ObjectIdentifier, OctetString, SetOfVec};
use der::{Any, Decode, Encode, Reader, SliceReader, Tag, TagNumber, Tagged};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use x509_cert::spki::AlgorithmIdentifierOwned;
use x509_cert::Certificate;

const ID_SIGNED_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.2");
const ID_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.1");
const ID_CONTENT_TYPE: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.3");
const ID_MESSAGE_DIGEST: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.4");
const ID_SIGNING_CERT_V2: ObjectIdentifier =
    ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.16.2.47");
const ID_SHA256: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.1");
const ID_EC_PUBLIC_KEY: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");
const ID_P256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");
const ID_ECDSA_SHA256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.4.3.2");
/// 2.25.132515939282652475535231260060469025505, the agreed manifest-digest
/// attribute. Its UUID arc exceeds const-oid 0.9's u32 arcs. Compare its exact,
/// canonical DER value, without changing the producer OID or the signed bytes.
const ID_MANIFEST_DIGEST: &[u8] = &[
    0x69, 0x81, 0xc7, 0xb1, 0xd2, 0x8f, 0xa3, 0x98, 0x82, 0xb0, 0xcf, 0xbe, 0xa2, 0xb7, 0xa8, 0xff,
    0xde, 0xe7, 0xb5, 0x61,
];

/// The most bytes a signature's /Contents may decode to. CARLOS reserves
/// 8 KiB; anything far larger is not its signature.
const MAX_CONTENTS_BYTES: usize = 64 * 1024;
/// The most bytes an embedded manifest may have.
const MAX_MANIFEST_BYTES: usize = 16 * 1024;

/// Where the PDF's signatures are, as the PDF helper found them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignatureLayout {
    /// Each signature's /ByteRange `[a, b, c, d]`: bytes `a..a+b` and
    /// `c..c+d` are signed, and `a+b..c` holds the /Contents.
    pub byte_ranges: Vec<[usize; 4]>,
    /// Whether a complete revision (an incremental update) follows the
    /// signed one, rather than loose bytes.
    pub update_after_signature: bool,
    /// Whether the PDF is encrypted (has an /Encrypt dictionary), so its
    /// embedded manifest is stored encrypted.
    pub encrypted: bool,
}

/// A portal link's pins, as linking stored them (carlos-portal #42).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedLink {
    pub clinic_id: String,
    pub recipient_id: String,
    /// The clinic's signing keys for this link: base64url SHA-256 of each
    /// key's SubjectPublicKeyInfo DER.
    pub signer_kids: Vec<String>,
}

/// Why a signed PDF is not shown as signed. The names are A3's fixture
/// codes; the document still imports, as an unverified one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    Unsigned,
    TwoSignatures,
    BadRange,
    IncompleteRange,
    ExtraUpdate,
    BadContents,
    BadSignature,
    NotP256,
    UnknownSigner,
    BadManifest,
    /// The exact extracted manifest does not match the authenticated CMS digest.
    ManifestNotSigned,
    /// A password is still required to extract the encrypted manifest.
    EncryptedManifest,
    KidMismatch,
    ClinicMismatch,
    BadStructure,
}

/// Before the helper receives a document password, establish a valid signature
/// from a pinned clinic key. This is repeated against its complete structure report.
pub(crate) fn authenticate(
    pdf: &[u8],
    layout: &SignatureLayout,
    links: &[PinnedLink],
) -> Result<(), Refusal> {
    let signed = check_signature(pdf, layout)?;
    if !links
        .iter()
        .any(|link| link.signer_kids.contains(&signed.kid))
    {
        return Err(Refusal::UnknownSigner);
    }
    Ok(())
}

/// What CARLOS put inside the signed revision (A3's manifest note).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: u8,
    pub typ: String,
    pub document_id: String,
    pub version: u32,
    pub issued_at: i64,
    #[serde(deserialize_with = "present_nullable")]
    pub clinic_id: Option<String>,
    #[serde(deserialize_with = "present_nullable")]
    pub clinic_name: Option<String>,
    #[serde(deserialize_with = "present_nullable")]
    pub provider_name: Option<String>,
    pub kid: String,
    /// Present in every manifest; null when the patient had no portal link.
    #[serde(deserialize_with = "present_nullable")]
    pub recipient_id: Option<String>,
    pub patient: ManifestPatient,
    pub document: ManifestDocument,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestPatient {
    #[serde(deserialize_with = "present_nullable")]
    pub name: Option<String>,
    #[serde(deserialize_with = "present_nullable")]
    pub birth_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestDocument {
    #[serde(deserialize_with = "present_nullable")]
    pub title: Option<String>,
    #[serde(rename = "type", deserialize_with = "present_nullable")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "present_nullable")]
    pub service_date: Option<String>,
    pub media_type: String,
}

/// Optional v1 values may explicitly be null; their members must still exist.
/// Plain Option/default deserialization would incorrectly accept missing keys.
fn present_nullable<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::deserialize(d)
}

/// A signature that checked out, made with a key pinned for a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// From the clinic, and for the patient this link belongs to.
    Verified { kid: String, manifest: Manifest },
    /// From the clinic, but with no manifest, or one for no recipient or for
    /// someone else: never shown as Verified.
    SignedNotMatched {
        kid: String,
        clinic_id: String,
        manifest: Option<Manifest>,
    },
}

/// Checks `pdf` against the patient's links. `layout` and `manifest` come
/// from the PDF helper; the manifest is `None` when the signed revision
/// embeds none.
pub fn check(
    pdf: &[u8],
    layout: &SignatureLayout,
    manifest: Option<&[u8]>,
    links: &[PinnedLink],
) -> Result<Verdict, Refusal> {
    let signed = check_signature(pdf, layout)?;
    let pinned: Vec<&PinnedLink> = links
        .iter()
        .filter(|link| link.signer_kids.contains(&signed.kid))
        .collect();
    if pinned.is_empty() {
        return Err(Refusal::UnknownSigner);
    }
    let Some(bytes) = manifest else {
        return Ok(Verdict::SignedNotMatched {
            kid: signed.kid,
            clinic_id: pinned[0].clinic_id.clone(),
            manifest: None,
        });
    };
    // The CMS signed attribute binds the exact extracted bytes, including an
    // encrypted attachment after its password was supplied. Never reserialize
    // the JSON before hashing it, or trust a helper's attachment report alone.
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(Refusal::BadManifest);
    }
    if signed.manifest_digest.as_deref() != Some(&Sha256::digest(bytes)[..]) {
        return Err(Refusal::ManifestNotSigned);
    }
    let manifest = parse_manifest(bytes)?;
    bind_manifest(signed.kid, manifest, &pinned)
}

/// Only called after the exact manifest digest and signer are authenticated.
/// Optional descriptive metadata cannot supply an absent clinic/recipient binding.
fn bind_manifest(
    kid: String,
    manifest: Manifest,
    pinned: &[&PinnedLink],
) -> Result<Verdict, Refusal> {
    if manifest.kid != kid {
        return Err(Refusal::KidMismatch);
    }
    let Some(claimed_clinic) = manifest.clinic_id.clone() else {
        return Ok(Verdict::SignedNotMatched {
            kid,
            clinic_id: pinned
                .first()
                .ok_or(Refusal::UnknownSigner)?
                .clinic_id
                .clone(),
            manifest: Some(manifest),
        });
    };
    let clinic: Vec<&&PinnedLink> = pinned
        .iter()
        .filter(|link| link.clinic_id == claimed_clinic)
        .collect();
    if clinic.is_empty() {
        return Err(Refusal::ClinicMismatch);
    }
    let for_this_patient = manifest
        .recipient_id
        .as_deref()
        .is_some_and(|recipient| clinic.iter().any(|link| link.recipient_id == recipient));
    Ok(if for_this_patient {
        Verdict::Verified { kid, manifest }
    } else {
        Verdict::SignedNotMatched {
            kid,
            clinic_id: claimed_clinic,
            manifest: Some(manifest),
        }
    })
}

struct SignedBy {
    kid: String,
    manifest_digest: Option<Vec<u8>>,
}

/// Step 1: the signature, on the file's own bytes.
fn check_signature(pdf: &[u8], layout: &SignatureLayout) -> Result<SignedBy, Refusal> {
    let [a, b, c, d] = match layout.byte_ranges.as_slice() {
        [] => return Err(Refusal::Unsigned),
        [range] => *range,
        _ => return Err(Refusal::TwoSignatures),
    };
    let end = c.checked_add(d).ok_or(Refusal::BadRange)?;
    if a != 0 || b.checked_add(2).is_none_or(|gap| gap > c) || end > pdf.len() {
        return Err(Refusal::BadRange);
    }
    if end < pdf.len() {
        return Err(if layout.update_after_signature {
            Refusal::ExtraUpdate
        } else {
            Refusal::IncompleteRange
        });
    }
    // The gap is exactly `<hex>`, so nothing unsigned hides around it.
    if pdf[b] != b'<' || pdf[c - 1] != b'>' {
        return Err(Refusal::BadContents);
    }
    let hex = &pdf[b + 1..c - 1];
    if hex.len() / 2 > MAX_CONTENTS_BYTES {
        return Err(Refusal::BadContents);
    }
    let contents = decode_hex(hex).ok_or(Refusal::BadContents)?;
    let mut hash = Sha256::new();
    hash.update(&pdf[..b]);
    hash.update(&pdf[c..end]);
    verify_cms(&contents, &hash.finalize())
}

fn decode_hex(hex: &[u8]) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let nibble = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let (pairs, _) = hex.as_chunks::<2>();
    pairs
        .iter()
        .map(|[high, low]| Some(nibble(*high)? << 4 | nibble(*low)?))
        .collect()
}

/// One CMS SignedData, detached, with a single P-256 signer whose signed
/// attributes carry `digest`; returns the signer's kid.
fn verify_cms(contents: &[u8], digest: &[u8]) -> Result<SignedBy, Refusal> {
    use Refusal::BadSignature as Bad;
    let mut reader = SliceReader::new(contents).map_err(|_| Refusal::BadContents)?;
    let info = ContentInfo::decode(&mut reader).map_err(|_| Refusal::BadContents)?;
    let used = usize::try_from(reader.position()).map_err(|_| Refusal::BadContents)?;
    // After the DER, only the zeros CARLOS reserved: nothing else rides in
    // the unsigned gap.
    if contents[used..].iter().any(|&byte| byte != 0) {
        return Err(Refusal::BadContents);
    }
    if info.content_type != ID_SIGNED_DATA {
        return Err(Bad);
    }
    // Decode the CMS envelope with the reviewed DER types. Signed attributes
    // stay as Any values because const-oid cannot represent the UUID-sized arc.
    // No OID is substituted, and no attribute is removed or re-ordered.
    let fields: Vec<Any> = info.content.decode_as().map_err(|_| Bad)?;
    let [version, algorithms, encapsulated, certificates, signer_infos] = fields.as_slice() else {
        return Err(Bad);
    };
    version.decode_as::<CmsVersion>().map_err(|_| Bad)?;
    let original_algorithms = algorithms;
    let algorithms: SetOfVec<AlgorithmIdentifierOwned> = algorithms.decode_as().map_err(|_| Bad)?;
    if algorithms.to_der().map_err(|_| Bad)? != original_algorithms.to_der().map_err(|_| Bad)? {
        return Err(Bad);
    }
    if algorithms.len() != 1
        || algorithms
            .iter()
            .any(|algorithm| algorithm.oid != ID_SHA256)
    {
        return Err(Bad);
    }
    let encapsulated: EncapsulatedContentInfo = encapsulated.decode_as().map_err(|_| Bad)?;
    if encapsulated.econtent.is_some() || encapsulated.econtent_type != ID_DATA {
        return Err(Bad);
    }
    let original_certificates = implicit_set(certificates, TagNumber::N0)?;
    let certificates: CertificateSet = original_certificates.decode_as().map_err(|_| Bad)?;
    if certificates.to_der().map_err(|_| Bad)? != original_certificates.to_der().map_err(|_| Bad)? {
        return Err(Bad);
    }
    let signers: SetOfVec<Any> = signer_infos.decode_as().map_err(|_| Bad)?;
    if signers.to_der().map_err(|_| Bad)? != signer_infos.to_der().map_err(|_| Bad)? {
        return Err(Bad);
    }
    if signers.len() != 1 {
        return Err(Bad);
    }
    let signer_fields: Vec<Any> = signers
        .iter()
        .next()
        .ok_or(Bad)?
        .decode_as()
        .map_err(|_| Bad)?;
    let [version, sid, digest_algorithm, attributes, signature_algorithm, signature] =
        signer_fields.as_slice()
    else {
        return Err(Bad);
    };
    if version.decode_as::<CmsVersion>().map_err(|_| Bad)? != CmsVersion::V1 {
        return Err(Bad);
    }
    let digest_algorithm: AlgorithmIdentifierOwned =
        digest_algorithm.decode_as().map_err(|_| Bad)?;
    if digest_algorithm.oid != ID_SHA256 {
        return Err(Bad);
    }
    // CARLOS names its signer by issuer and serial number.
    let original_sid = sid.to_der().map_err(|_| Bad)?;
    let parsed_sid = SignerIdentifier::from_der(&original_sid).map_err(|_| Bad)?;
    if parsed_sid.to_der().map_err(|_| Bad)? != original_sid {
        return Err(Bad);
    }
    let SignerIdentifier::IssuerAndSerialNumber(id) = parsed_sid else {
        return Err(Bad);
    };
    let cert: &Certificate = certificates
        .0
        .iter()
        .find_map(|choice| match choice {
            CertificateChoices::Certificate(cert)
                if cert.tbs_certificate.issuer == id.issuer
                    && cert.tbs_certificate.serial_number == id.serial_number =>
            {
                Some(cert)
            }
            _ => None,
        })
        .ok_or(Bad)?;
    let spki = &cert.tbs_certificate.subject_public_key_info;
    let curve = spki
        .algorithm
        .parameters
        .as_ref()
        .and_then(|parameters| parameters.decode_as::<ObjectIdentifier>().ok());
    if spki.algorithm.oid != ID_EC_PUBLIC_KEY || curve != Some(ID_P256) {
        return Err(Refusal::NotP256);
    }
    let signature_algorithm: AlgorithmIdentifierOwned =
        signature_algorithm.decode_as().map_err(|_| Bad)?;
    if signature_algorithm.oid != ID_ECDSA_SHA256 {
        return Err(Bad);
    }
    let spki_der = spki.to_der().map_err(|_| Bad)?;
    let cert_hash = Sha256::digest(cert.to_der().map_err(|_| Bad)?);

    let attributes = implicit_set(attributes, TagNumber::N0)?;
    let parsed_attributes = canonical_attributes(&attributes)?;
    let mut seen: Vec<Vec<u8>> = Vec::new();
    let (mut content_type, mut message_digest, mut signing_cert) = (false, false, false);
    let mut manifest_digest = None;
    for attribute in parsed_attributes.iter() {
        let parts: Vec<Any> = attribute.decode_as().map_err(|_| Bad)?;
        let [oid, values] = parts.as_slice() else {
            return Err(Bad);
        };
        if oid.tag() != Tag::ObjectIdentifier || !canonical_oid(oid.value()) {
            return Err(Bad);
        }
        if seen
            .iter()
            .any(|previous| previous.as_slice() == oid.value())
        {
            return Err(Bad);
        }
        seen.push(oid.value().to_vec());
        let values: SetOfVec<Any> = values.decode_as().map_err(|_| Bad)?;
        if values.len() != 1 {
            return Err(Bad);
        }
        let value = values.iter().next().ok_or(Bad)?;
        if oid.value() == ID_CONTENT_TYPE.as_bytes() {
            content_type = value.decode_as::<ObjectIdentifier>().ok() == Some(ID_DATA);
        } else if oid.value() == ID_MESSAGE_DIGEST.as_bytes() {
            message_digest = value
                .decode_as::<OctetString>()
                .is_ok_and(|octets| octets.as_bytes() == digest);
        } else if oid.value() == ID_SIGNING_CERT_V2.as_bytes() {
            signing_cert = first_cert_hash(value).as_deref() == Some(&cert_hash[..]);
        } else if oid.value() == ID_MANIFEST_DIGEST {
            let octets: OctetString = value.decode_as().map_err(|_| Bad)?;
            if octets.as_bytes().len() != 32 {
                return Err(Bad);
            }
            manifest_digest = Some(octets.as_bytes().to_vec());
        }
    }
    if !(content_type && message_digest && signing_cert) {
        return Err(Bad);
    }
    let key = VerifyingKey::from_public_key_der(&spki_der).map_err(|_| Refusal::NotP256)?;
    let signature: OctetString = signature.decode_as().map_err(|_| Bad)?;
    let signature = Signature::from_der(signature.as_bytes()).map_err(|_| Bad)?;
    // The signature covers the attributes' DER under the SET OF tag (RFC 5652
    // 5.4). `der` decodes DER only, so re-encoding them gives back exactly the
    // bytes that were signed.
    let signed_attributes = attributes.to_der().map_err(|_| Bad)?;
    key.verify(&signed_attributes, &signature)
        .map_err(|_| Bad)?;
    Ok(SignedBy {
        kid: URL_SAFE_NO_PAD.encode(Sha256::digest(&spki_der)),
        manifest_digest,
    })
}

/// Retag an IMPLICIT SET while preserving every encoded value byte.
fn implicit_set(value: &Any, number: TagNumber) -> Result<Any, Refusal> {
    if value.tag()
        != (Tag::ContextSpecific {
            constructed: true,
            number,
        })
    {
        return Err(Refusal::BadSignature);
    }
    Any::new(Tag::Set, value.value()).map_err(|_| Refusal::BadSignature)
}

/// der 0.7 sorts SET OF on decode. Reject a noncanonical original rather than
/// accidentally accepting a signature over an unsorted signed-attribute SET.
fn canonical_attributes(value: &Any) -> Result<SetOfVec<Any>, Refusal> {
    let parsed: SetOfVec<Any> = value.decode_as().map_err(|_| Refusal::BadSignature)?;
    if parsed.to_der().map_err(|_| Refusal::BadSignature)?
        != value.to_der().map_err(|_| Refusal::BadSignature)?
    {
        return Err(Refusal::BadSignature);
    }
    Ok(parsed)
}

/// DER base-128 subidentifiers may have arbitrarily large arcs, but must be
/// minimally encoded and terminated. In particular 0x80 cannot start an arc.
fn canonical_oid(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.last().is_none_or(|byte| byte & 0x80 != 0) {
        return false;
    }
    let mut first = true;
    for &byte in bytes {
        if first && byte == 0x80 {
            return false;
        }
        first = byte & 0x80 == 0;
    }
    true
}

/// SigningCertificateV2 { certs SEQUENCE OF ESSCertIDv2, ... }: the first
/// ESSCertIDv2's certHash, when its hash algorithm is SHA-256 (the default,
/// which DER leaves out).
fn first_cert_hash(value: &Any) -> Option<Vec<u8>> {
    let outer: Vec<Any> = value.decode_as().ok()?;
    let certs: Vec<Any> = outer.first()?.decode_as().ok()?;
    let fields: Vec<Any> = certs.first()?.decode_as().ok()?;
    let mut fields = fields.iter();
    let mut next = fields.next()?;
    if next.tag() == Tag::Sequence {
        let algorithm: AlgorithmIdentifierOwned = next.decode_as().ok()?;
        if algorithm.oid != ID_SHA256 {
            return None;
        }
        next = fields.next()?;
    }
    Some(next.decode_as::<OctetString>().ok()?.as_bytes().to_vec())
}

/// Steps 2: exactly the agreed members, once each, in RFC 8785 form.
fn parse_manifest(bytes: &[u8]) -> Result<Manifest, Refusal> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(Refusal::BadManifest);
    }
    // The derived structs refuse unknown and repeated members.
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| Refusal::BadManifest)?;
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| Refusal::BadManifest)?;
    let mut canonical = Vec::with_capacity(bytes.len());
    write_canonical(&value, &mut canonical).ok_or(Refusal::BadManifest)?;
    if canonical != bytes || manifest.v != 1 || manifest.typ != "carlos-document-manifest" {
        return Err(Refusal::BadManifest);
    }
    Ok(manifest)
}

/// RFC 8785 for what a manifest holds: members sorted by their UTF-16 code
/// units, no whitespace, integers only. Sorted here rather than by the map
/// type, whose order a dependency's serde_json feature can change.
fn write_canonical(value: &serde_json::Value, out: &mut Vec<u8>) -> Option<()> {
    use serde_json::Value;
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => {
            out.extend(serde_json::to_vec(value).ok()?);
        }
        Value::Number(number) => {
            if !(number.is_i64() || number.is_u64()) {
                return None;
            }
            out.extend(number.to_string().as_bytes());
        }
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_canonical(item, out)?;
            }
            out.push(b']');
        }
        Value::Object(members) => {
            let mut keys: Vec<&String> = members.keys().collect();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            out.push(b'{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.extend(serde_json::to_vec(key).ok()?);
                out.push(b':');
                write_canonical(&members[key], out)?;
            }
            out.push(b'}');
        }
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;

    /// Current fixture from CARLOS #5135 (1f30d9bef7), byte for byte: change it
    /// there first, then here with its new hash.
    const FIXTURE: &[u8] = include_bytes!("../tests/fixtures/mycarlos-signed-pdf-fixtures.json");
    const FIXTURE_SHA256: &str = "f26a292a7ba9ca52e5251b65fb46345c959d784fc3190435ca6b67a024b47169";

    #[derive(Deserialize)]
    struct Fixture {
        link: FixtureLink,
        documents: Vec<FixtureDocument>,
    }

    #[derive(Deserialize)]
    struct FixtureLink {
        recipient_id: String,
        signer_kid: String,
        clinic_id: String,
    }

    #[derive(Deserialize)]
    struct FixtureDocument {
        name: String,
        expect: String,
        byte_ranges: Vec<[usize; 4]>,
        manifest_bytes_b64: Option<String>,
        pdf_b64: String,
    }

    struct Document {
        expect: String,
        pdf: Vec<u8>,
        layout: SignatureLayout,
        manifest: Option<Vec<u8>>,
    }

    fn fixture() -> (PinnedLink, Vec<(String, Document)>) {
        let hash: String = Sha256::digest(FIXTURE)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(
            hash, FIXTURE_SHA256,
            "the fixture changed: take it from CARLOS"
        );
        let fixture: Fixture = serde_json::from_slice(FIXTURE).unwrap();
        let link = PinnedLink {
            clinic_id: fixture.link.clinic_id,
            recipient_id: fixture.link.recipient_id,
            signer_kids: vec![fixture.link.signer_kid],
        };
        let documents = fixture
            .documents
            .into_iter()
            .map(|document| {
                let pdf = STANDARD.decode(document.pdf_b64).unwrap();
                let layout = helper_layout(&pdf, document.byte_ranges);
                let manifest = document
                    .manifest_bytes_b64
                    .map(|manifest| STANDARD.decode(manifest).unwrap());
                (
                    document.name,
                    Document {
                        expect: document.expect,
                        pdf,
                        layout,
                        manifest,
                    },
                )
            })
            .collect();
        (link, documents)
    }

    /// What the PDF helper reports, from the fixture's ranges: a later
    /// revision ends with its own %%EOF, and an encrypted PDF has /Encrypt.
    fn helper_layout(pdf: &[u8], byte_ranges: Vec<[usize; 4]>) -> SignatureLayout {
        let update_after_signature = byte_ranges.first().is_some_and(|[_, _, c, d]| {
            pdf.get(c + d..)
                .is_some_and(|tail| tail.windows(5).any(|window| window == b"%%EOF"))
        });
        SignatureLayout {
            byte_ranges,
            update_after_signature,
            encrypted: pdf.windows(8).any(|window| window == b"/Encrypt"),
        }
    }

    fn code(result: &Result<Verdict, Refusal>) -> String {
        match result {
            Ok(Verdict::Verified { .. }) => "verified".into(),
            Ok(Verdict::SignedNotMatched { .. }) => "signed_not_matched".into(),
            Err(refusal) => serde_json::to_value(refusal)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        }
    }

    fn document<'a>(documents: &'a [(String, Document)], name: &str) -> &'a Document {
        &documents.iter().find(|(found, _)| found == name).unwrap().1
    }

    #[test]
    fn every_fixture_document_gets_its_expected_verdict() {
        let (link, documents) = fixture();
        assert_eq!(documents.len(), 12);
        for (name, document) in &documents {
            let result = check(
                &document.pdf,
                &document.layout,
                document.manifest.as_deref(),
                std::slice::from_ref(&link),
            );
            let expect = document.expect.as_str();
            assert_eq!(code(&result), expect, "{name}");
        }
    }

    #[test]
    fn verified_carries_the_manifest_the_clinic_signed() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let Ok(Verdict::Verified { kid, manifest }) = check(
            &sent.pdf,
            &sent.layout,
            sent.manifest.as_deref(),
            std::slice::from_ref(&link),
        ) else {
            panic!("not verified");
        };
        assert_eq!(kid, link.signer_kids[0]);
        assert_eq!(manifest.clinic_id.as_deref(), Some("clinic-a"));
        assert_eq!(
            manifest.recipient_id.as_deref(),
            Some(link.recipient_id.as_str())
        );
        assert_eq!(manifest.document.media_type, "application/pdf");
    }

    #[test]
    fn a_key_pinned_for_no_link_is_an_unknown_signer() {
        let (mut link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        link.signer_kids = vec!["MKZM9qtcs9ApKsIMo23woDPeM3eiD8Ndqg6CGRJChgw".into()];
        let result = check(&sent.pdf, &sent.layout, sent.manifest.as_deref(), &[link]);
        assert_eq!(result, Err(Refusal::UnknownSigner));
        assert_eq!(
            check(&sent.pdf, &sent.layout, sent.manifest.as_deref(), &[]),
            Err(Refusal::UnknownSigner)
        );
    }

    #[test]
    fn another_patients_link_or_clinic_is_never_verified() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let other_patient = PinnedLink {
            recipient_id: "rcp-FAKE0002bbbbbbbbbbbb".into(),
            ..link.clone()
        };
        assert_eq!(
            code(&check(
                &sent.pdf,
                &sent.layout,
                sent.manifest.as_deref(),
                std::slice::from_ref(&other_patient)
            )),
            "signed_not_matched"
        );
        // The same key pinned for another clinic's link.
        let other_clinic = PinnedLink {
            clinic_id: "clinic-b".into(),
            ..link.clone()
        };
        assert_eq!(
            check(
                &sent.pdf,
                &sent.layout,
                sent.manifest.as_deref(),
                &[other_clinic]
            ),
            Err(Refusal::ClinicMismatch)
        );
        // Several links: the patient's own one decides.
        assert_eq!(
            code(&check(
                &sent.pdf,
                &sent.layout,
                sent.manifest.as_deref(),
                &[other_patient, link]
            )),
            "verified"
        );
    }

    #[test]
    fn reported_ranges_and_manifest_bytes_are_checked_against_the_file() {
        let (link, documents) = fixture();
        let links = std::slice::from_ref(&link);
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let [a, b, c, d] = sent.layout.byte_ranges[0];
        let shifted = |range: [usize; 4]| SignatureLayout {
            byte_ranges: vec![range],
            ..SignatureLayout::default()
        };
        // A gap that does not frame the /Contents.
        for range in [[a, b + 1, c, d], [a, b, c - 1, d + 1], [1, b - 1, c, d]] {
            let result = check(&sent.pdf, &shifted(range), sent.manifest.as_deref(), links);
            assert!(result.is_err(), "{range:?}: {result:?}");
        }
        // Ranges past the end, or overflowing.
        for range in [[a, b, c, d + 1], [a, b, usize::MAX, 2]] {
            assert_eq!(
                check(&sent.pdf, &shifted(range), None, links),
                Err(Refusal::BadRange)
            );
        }
        // No signature reported.
        assert_eq!(
            check(&sent.pdf, &SignatureLayout::default(), None, links),
            Err(Refusal::Unsigned)
        );
        // Another document's manifest cannot match this authenticated CMS digest.
        for other in ["signed-no-recipient.pdf", "refuse-kid-mismatch.pdf"] {
            let other = document(&documents, other).manifest.as_deref();
            assert_eq!(
                check(&sent.pdf, &sent.layout, other, links),
                Err(Refusal::ManifestNotSigned)
            );
        }
        // The same, said to be encrypted.
        let encrypted = SignatureLayout {
            encrypted: true,
            ..sent.layout.clone()
        };
        let other = document(&documents, "signed-no-recipient.pdf");
        assert_eq!(
            check(&sent.pdf, &encrypted, other.manifest.as_deref(), links),
            Err(Refusal::ManifestNotSigned)
        );
    }

    #[test]
    fn a_manifest_for_another_patient_cannot_ride_on_a_clinic_signature() {
        // The clinic signed this PDF with no recipient. A helper that reports
        // the manifest of a copy made for this patient must not turn it into
        // Verified.
        let (link, documents) = fixture();
        let unmatched = document(&documents, "signed-no-recipient.pdf");
        let forged = document(&documents, "signed-send-to-mycarlos.pdf")
            .manifest
            .as_deref();
        assert_eq!(
            check(
                &unmatched.pdf,
                &unmatched.layout,
                forged,
                std::slice::from_ref(&link)
            ),
            Err(Refusal::ManifestNotSigned)
        );
    }

    #[test]
    fn a_manifest_added_in_an_unsigned_update_is_not_verified() {
        let (link, documents) = fixture();
        let unmatched = document(&documents, "signed-no-recipient.pdf");
        let forged = document(&documents, "signed-send-to-mycarlos.pdf")
            .manifest
            .clone()
            .unwrap();
        let mut pdf = unmatched.pdf.clone();
        pdf.extend_from_slice(b"\n99 0 obj\n<< /Type /EmbeddedFile >>\nstream\n");
        pdf.extend_from_slice(&forged);
        pdf.extend_from_slice(b"\nendstream\nendobj\ntrailer\n<<>>\nstartxref\n0\n%%EOF\n");
        let layout = helper_layout(&pdf, unmatched.layout.byte_ranges.clone());
        assert_eq!(
            check(&pdf, &layout, Some(&forged), std::slice::from_ref(&link)),
            Err(Refusal::ExtraUpdate)
        );
    }

    #[test]
    fn oid_arcs_must_be_canonical_even_when_uuid_sized() {
        assert!(canonical_oid(ID_MANIFEST_DIGEST));
        for malformed in [
            b"".as_slice(),
            &[0x80, 0x69],
            &[0x69, 0x80, 0x01],
            &[0x69, 0x81],
        ] {
            assert!(!canonical_oid(malformed));
        }
    }

    #[test]
    fn unsorted_signed_attribute_sets_are_refused_without_rewriting_their_bytes() {
        // Valid Attribute sequences containing different OIDs and one OCTET
        // STRING value; only their outer SET ordering differs.
        let first = [0x30, 0x08, 0x06, 0x01, 0x2a, 0x31, 0x03, 0x04, 0x01, 0x01];
        let second = [0x30, 0x08, 0x06, 0x01, 0x2b, 0x31, 0x03, 0x04, 0x01, 0x02];
        let sorted = Any::new(Tag::Set, [first.as_slice(), second.as_slice()].concat()).unwrap();
        let unsorted = Any::new(Tag::Set, [second.as_slice(), first.as_slice()].concat()).unwrap();
        assert!(canonical_attributes(&sorted).is_ok());
        assert!(matches!(
            canonical_attributes(&unsorted),
            Err(Refusal::BadSignature)
        ));
    }

    #[test]
    fn any_changed_signed_byte_is_a_bad_signature() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let [_, b, c, d] = sent.layout.byte_ranges[0];
        let signed: Vec<usize> = (0..b).chain(c..c + d).collect();
        for &offset in signed.iter().step_by(97) {
            let mut pdf = sent.pdf.clone();
            pdf[offset] ^= 0x20;
            let result = check(
                &pdf,
                &sent.layout,
                sent.manifest.as_deref(),
                std::slice::from_ref(&link),
            );
            assert_eq!(result, Err(Refusal::BadSignature), "offset {offset}");
        }
    }

    #[test]
    fn anything_after_the_signed_bytes_is_refused() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let links = std::slice::from_ref(&link);
        let mut pdf = sent.pdf.clone();
        pdf.push(b'\n');
        assert_eq!(
            check(
                &pdf,
                &helper_layout(&pdf, sent.layout.byte_ranges.clone()),
                None,
                links
            ),
            Err(Refusal::IncompleteRange)
        );
        pdf.extend_from_slice(b"trailer\n<<>>\nstartxref\n0\n%%EOF\n");
        assert_eq!(
            check(
                &pdf,
                &helper_layout(&pdf, sent.layout.byte_ranges.clone()),
                None,
                links
            ),
            Err(Refusal::ExtraUpdate)
        );
    }

    #[test]
    fn the_contents_must_be_one_signature_and_zeros() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let links = std::slice::from_ref(&link);
        let [_, _, c, _] = sent.layout.byte_ranges[0];
        // A non-zero byte in the padding: unsigned data riding in the gap.
        let mut padded = sent.pdf.clone();
        padded[c - 3] = b'7';
        assert_eq!(
            check(&padded, &sent.layout, sent.manifest.as_deref(), links),
            Err(Refusal::BadContents)
        );
        // Not hex.
        let mut garbled = sent.pdf.clone();
        garbled[c - 3] = b'g';
        assert_eq!(
            check(&garbled, &sent.layout, sent.manifest.as_deref(), links),
            Err(Refusal::BadContents)
        );
    }

    #[test]
    fn the_manifest_must_be_canonical_and_complete() {
        let base = document(&fixture().1, "signed-send-to-mycarlos.pdf")
            .manifest
            .clone()
            .unwrap();
        assert!(parse_manifest(&base).is_ok());
        let text = String::from_utf8(base.clone()).unwrap();
        let refused = [
            // Whitespace, or members out of order.
            text.replacen(",", ", ", 1),
            text.replacen(
                r#"{"clinic_id":"clinic-a","clinic_name":"FAKE Demo Clinic""#,
                r#"{"clinic_name":"FAKE Demo Clinic","clinic_id":"clinic-a""#,
                1,
            ),
            // recipient_id left out rather than null.
            text.replacen(r#""recipient_id":"rcp-FAKE0001aaaaaaaaaaaa","#, "", 1),
            // Another version or type.
            text.replacen(r#""v":1"#, r#""v":2"#, 1),
            text.replacen(r#""typ":"carlos-document-manifest""#, r#""typ":"other""#, 1),
            // A fraction where an integer belongs.
            text.replacen(r#""version":1"#, r#""version":1.5"#, 1),
        ];
        for manifest in refused {
            assert_ne!(manifest, text, "the test's edit did not apply");
            assert_eq!(
                parse_manifest(manifest.as_bytes()),
                Err(Refusal::BadManifest),
                "{manifest}"
            );
        }
        assert_eq!(
            parse_manifest(&vec![b' '; MAX_MANIFEST_BYTES + 1]),
            Err(Refusal::BadManifest)
        );
    }

    const NULLABLE_MEMBERS: &[&str] = &[
        "/clinic_id",
        "/clinic_name",
        "/provider_name",
        "/recipient_id",
        "/patient/name",
        "/patient/birth_date",
        "/document/title",
        "/document/type",
        "/document/service_date",
    ];

    fn canonical_test_manifest(value: &serde_json::Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_canonical(value, &mut bytes).unwrap();
        bytes
    }

    #[test]
    fn optional_v1_values_accept_explicit_null_but_keep_every_member_required() {
        let (_, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let mut value: serde_json::Value =
            serde_json::from_slice(sent.manifest.as_deref().unwrap()).unwrap();
        for pointer in NULLABLE_MEMBERS {
            *value.pointer_mut(pointer).unwrap() = serde_json::Value::Null;
        }
        let parsed = parse_manifest(&canonical_test_manifest(&value)).unwrap();
        assert!(parsed.clinic_id.is_none() && parsed.recipient_id.is_none());
        assert!(parsed.patient.name.is_none() && parsed.patient.birth_date.is_none());
        assert!(
            parsed.document.title.is_none()
                && parsed.document.kind.is_none()
                && parsed.document.service_date.is_none()
        );
        for pointer in NULLABLE_MEMBERS {
            let mut missing = value.clone();
            let (parent, member) = pointer.rsplit_once('/').unwrap();
            assert!(missing
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(member)
                .is_some());
            assert_eq!(
                parse_manifest(&canonical_test_manifest(&missing)),
                Err(Refusal::BadManifest),
                "missing {pointer}"
            );
            let mut wrong_type = value.clone();
            *wrong_type.pointer_mut(pointer).unwrap() = serde_json::json!(17);
            assert_eq!(
                parse_manifest(&canonical_test_manifest(&wrong_type)),
                Err(Refusal::BadManifest),
                "wrong type {pointer}"
            );
        }
        for parent in ["/patient", "/document"] {
            let mut wrong_shape = value.clone();
            *wrong_shape.pointer_mut(parent).unwrap() = serde_json::Value::Null;
            assert_eq!(
                parse_manifest(&canonical_test_manifest(&wrong_shape)),
                Err(Refusal::BadManifest)
            );
        }
    }

    #[test]
    fn clinic_and_recipient_bindings_are_both_required_after_authentication() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let base = parse_manifest(sent.manifest.as_deref().unwrap()).unwrap();
        assert!(matches!(
            bind_manifest(link.signer_kids[0].clone(), base.clone(), &[&link]),
            Ok(Verdict::Verified { .. })
        ));
        for (no_clinic, no_recipient) in [(true, false), (false, true), (true, true)] {
            let mut manifest = base.clone();
            if no_clinic {
                manifest.clinic_id = None;
            }
            if no_recipient {
                manifest.recipient_id = None;
            }
            assert!(matches!(
                bind_manifest(link.signer_kids[0].clone(), manifest, &[&link]),
                Ok(Verdict::SignedNotMatched { .. })
            ));
        }
        let mut wrong_clinic = base.clone();
        wrong_clinic.clinic_id = Some("FAKE another clinic".to_owned());
        assert_eq!(
            bind_manifest(link.signer_kids[0].clone(), wrong_clinic, &[&link]),
            Err(Refusal::ClinicMismatch)
        );
        let mut wrong_recipient = base;
        wrong_recipient.recipient_id = Some("FAKE another recipient".to_owned());
        assert!(matches!(
            bind_manifest(link.signer_kids[0].clone(), wrong_recipient, &[&link]),
            Ok(Verdict::SignedNotMatched { .. })
        ));
    }

    #[test]
    fn allowing_null_claims_does_not_weaken_the_exact_signed_digest_or_size_limit() {
        let (link, documents) = fixture();
        let sent = document(&documents, "signed-send-to-mycarlos.pdf");
        let mut value: serde_json::Value =
            serde_json::from_slice(sent.manifest.as_deref().unwrap()).unwrap();
        for pointer in NULLABLE_MEMBERS {
            *value.pointer_mut(pointer).unwrap() = serde_json::Value::Null;
        }
        let nullable = canonical_test_manifest(&value);
        assert!(parse_manifest(&nullable).is_ok());
        assert_eq!(
            check(&sent.pdf, &sent.layout, Some(&nullable), &[link]),
            Err(Refusal::ManifestNotSigned)
        );
        value["document"]["title"] = serde_json::json!("x".repeat(MAX_MANIFEST_BYTES));
        assert_eq!(
            parse_manifest(&canonical_test_manifest(&value)),
            Err(Refusal::BadManifest)
        );
    }

    #[test]
    fn the_canonical_form_sorts_by_utf16_code_units() {
        // By bytes (UTF-8) U+FB01 comes first; by UTF-16 code units U+10000
        // does, as its surrogate pair starts at 0xD800.
        let value: serde_json::Value =
            serde_json::from_str("{\"\u{fb01}\":2,\"\u{10000}\":1}").unwrap();
        let mut out = Vec::new();
        write_canonical(&value, &mut out).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "{\"\u{10000}\":1,\"\u{fb01}\":2}"
        );
    }
}
