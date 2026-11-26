//! The signed-PDF check's refusals that `signed_pdf`'s own tests do not reach (coverage batch 1).
//!
//! A document CARLOS signed is only "Verified" if one CMS SignedData in the signature gap has
//! exactly the agreed shape. These tests take the pinned CARLOS fixture's good document and change
//! **one** field of its CMS at a time, in a place the signature does not cover (the signature
//! covers the signed attributes, not the algorithm identifiers, versions or the certificate's own
//! fields), so that the only thing that can refuse the file is the check each test names. The CMS
//! bytes are replaced with a same-length value, so no length changes and the zero padding after the
//! DER stays as it was. FAKE keys and documents only (the fixture's).

use super::*;
use base64::engine::general_purpose::STANDARD;

const FIXTURE: &[u8] = include_bytes!("../../tests/fixtures/mycarlos-signed-pdf-fixtures.json");

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
    byte_ranges: Vec<[usize; 4]>,
    manifest_bytes_b64: Option<String>,
    pdf_b64: String,
}

struct Good {
    link: PinnedLink,
    pdf: Vec<u8>,
    layout: SignatureLayout,
    manifest: Option<Vec<u8>>,
    /// Where the hex of the CMS sits in the file: after the `<` and before the `>`.
    hex: std::ops::Range<usize>,
}

fn good() -> Good {
    let fixture: Fixture = serde_json::from_slice(FIXTURE).unwrap();
    let document = fixture
        .documents
        .into_iter()
        .find(|document| document.name == "signed-send-to-mycarlos.pdf")
        .unwrap();
    let pdf = STANDARD.decode(&document.pdf_b64).unwrap();
    let [_, b, c, _] = document.byte_ranges[0];
    Good {
        link: PinnedLink {
            clinic_id: fixture.link.clinic_id,
            recipient_id: fixture.link.recipient_id,
            signer_kids: vec![fixture.link.signer_kid],
        },
        layout: SignatureLayout {
            byte_ranges: document.byte_ranges,
            update_after_signature: false,
            encrypted: false,
        },
        manifest: document
            .manifest_bytes_b64
            .map(|manifest| STANDARD.decode(manifest).unwrap()),
        hex: b + 1..c - 1,
        pdf,
    }
}

impl Good {
    fn verdict(&self, pdf: &[u8]) -> Result<Verdict, Refusal> {
        check(
            pdf,
            &self.layout,
            self.manifest.as_deref(),
            std::slice::from_ref(&self.link),
        )
    }

    /// The CMS bytes in the gap (DER, then the zero padding).
    fn cms(&self) -> Vec<u8> {
        let text = std::str::from_utf8(&self.pdf[self.hex.clone()]).unwrap();
        decode_hex(text.as_bytes()).unwrap()
    }

    /// The file with the CMS replaced (the same length, so every byte range still holds).
    fn with_cms(&self, cms: &[u8]) -> Vec<u8> {
        assert_eq!(cms.len() * 2, self.hex.len());
        let mut pdf = self.pdf.clone();
        let hex: String = cms.iter().map(|byte| format!("{byte:02X}")).collect();
        pdf[self.hex.clone()].copy_from_slice(hex.as_bytes());
        pdf
    }

    /// The file with the `nth` (counting from 0) occurrence of `find` in the CMS replaced by
    /// `with`, of the same length.
    fn with_replaced(&self, find: &[u8], nth: usize, with: &[u8]) -> Vec<u8> {
        assert_eq!(find.len(), with.len());
        let mut cms = self.cms();
        let mut seen = 0;
        let mut at = 0;
        loop {
            let found = cms[at..]
                .windows(find.len())
                .position(|window| window == find)
                .map(|offset| at + offset)
                .unwrap_or_else(|| panic!("occurrence {nth} of {find:02x?} not found"));
            if seen == nth {
                cms[found..found + find.len()].copy_from_slice(with);
                return self.with_cms(&cms);
            }
            seen += 1;
            at = found + 1;
        }
    }
}

// DER: the object identifiers (tag 06, length, value) the tests change.
const SIGNED_DATA: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
];
const DATA: &[u8] = &[
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01,
];
const SHA256: &[u8] = &[
    0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
];
const SHA384: &[u8] = &[
    0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
];
const ECDSA_SHA256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
const ECDSA_SHA384: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x03];
const P256: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];
const P192: &[u8] = &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x01];
const EC_PUBLIC_KEY: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const NOT_EC_KEY: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x02];
const VERSION_1: &[u8] = &[0x02, 0x01, 0x01];
const VERSION_3: &[u8] = &[0x02, 0x01, 0x03];

#[test]
fn the_baseline_document_is_verified_and_the_replacement_helper_changes_nothing_else() {
    let good = good();
    assert!(matches!(
        good.verdict(&good.pdf),
        Ok(Verdict::Verified { .. })
    ));
    // Writing the same CMS back is the identity (the hex is upper case, the padding zeros).
    assert_eq!(good.with_cms(&good.cms()), good.pdf);
}

#[test]
fn a_cms_that_is_not_signed_data_is_a_bad_signature() {
    let good = good();
    let data = good.with_replaced(SIGNED_DATA, 0, DATA);
    assert_eq!(good.verdict(&data), Err(Refusal::BadSignature));
}

#[test]
fn only_sha_256_is_a_digest_algorithm_of_the_set_or_of_the_signer() {
    let good = good();
    // The algorithms the SignedData lists, then the one the signer names.
    for nth in [0, 1] {
        let other = good.with_replaced(SHA256, nth, SHA384);
        assert_eq!(good.verdict(&other), Err(Refusal::BadSignature), "{nth}");
    }
}

#[test]
fn only_ecdsa_with_sha_256_is_the_signature_algorithm() {
    let good = good();
    // The occurrence in the signer info (the third; the first two are the certificate's own).
    let other = good.with_replaced(ECDSA_SHA256, 2, ECDSA_SHA384);
    assert_eq!(good.verdict(&other), Err(Refusal::BadSignature));
}

#[test]
fn the_signer_info_must_be_version_1_and_the_signed_content_plain_data() {
    let good = good();
    // The signer's version is the version integer that follows the certificates (the 3rd).
    let version = good.with_replaced(VERSION_1, 2, VERSION_3);
    assert_eq!(good.verdict(&version), Err(Refusal::BadSignature));
    // The encapsulated content type is `data` (the first of the two), not signed data.
    let encapsulated = good.with_replaced(DATA, 0, SIGNED_DATA);
    assert_eq!(good.verdict(&encapsulated), Err(Refusal::BadSignature));
}

#[test]
fn a_signer_key_that_is_not_an_ec_p256_key_is_not_p256() {
    let good = good();
    // A curve that is not P-256, and a key algorithm that is not EC public key.
    let curve = good.with_replaced(P256, 0, P192);
    assert_eq!(good.verdict(&curve), Err(Refusal::NotP256));
    let algorithm = good.with_replaced(EC_PUBLIC_KEY, 0, NOT_EC_KEY);
    assert_eq!(good.verdict(&algorithm), Err(Refusal::NotP256));
}

#[test]
fn a_signature_value_or_a_message_digest_that_is_changed_is_a_bad_signature() {
    let good = good();
    let mut cms = good.cms();
    let used = {
        let der_length = usize::from(cms[1] & 0x7f);
        2 + der_length
            + cms[2..2 + der_length]
                .iter()
                .fold(0_usize, |n, byte| (n << 8) | usize::from(*byte))
    };
    // The last byte of the DER is inside the signature value: it no longer verifies.
    let mut signature = cms.clone();
    signature[used - 1] ^= 0x01;
    assert_eq!(
        good.verdict(&good.with_cms(&signature)),
        Err(Refusal::BadSignature)
    );
    // The message digest attribute (OID 1.2.840.113549.1.9.4) names a digest of other bytes: the
    // signature is over the attributes, so it is the attribute check that refuses, first.
    let marker = [
        0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04,
    ];
    let at = cms
        .windows(marker.len())
        .position(|window| window == marker)
        .unwrap();
    // OID, SET header (2), OCTET STRING header (2), then the digest's first byte.
    cms[at + marker.len() + 2 + 2] ^= 0x01;
    assert_eq!(
        good.verdict(&good.with_cms(&cms)),
        Err(Refusal::BadSignature)
    );
}

#[test]
fn a_signer_that_names_no_certificate_in_the_set_is_a_bad_signature() {
    let good = good();
    let cms = good.cms();
    // The signer's identifier (issuer and serial number) follows the signer's version; change one
    // character of its issuer name so that no certificate in the set matches.
    let signer_version = cms
        .windows(VERSION_1.len())
        .enumerate()
        .filter(|(_, window)| *window == VERSION_1)
        .map(|(at, _)| at)
        .nth(2)
        .unwrap();
    let run_start = (signer_version + 3..signer_version + 80)
        .find(|&at| cms[at..at + 6].iter().all(|b| b.is_ascii_alphanumeric()))
        .expect("an issuer name with letters in it");
    let mut other = cms.clone();
    other[run_start + 2] = if other[run_start + 2] == b'Z' {
        b'Y'
    } else {
        b'Z'
    };
    assert_eq!(
        good.verdict(&good.with_cms(&other)),
        Err(Refusal::BadSignature)
    );
}

#[test]
fn an_oversized_or_odd_signature_gap_is_refused_before_it_is_read() {
    // A file whose signature range is one `<...>` gap and nothing else: the contents are judged
    // on their size and their hex before any CMS is parsed.
    let build = |hex: &str| {
        let mut pdf = b"%PDF-1.7\n".to_vec();
        let b = pdf.len();
        pdf.push(b'<');
        pdf.extend_from_slice(hex.as_bytes());
        pdf.push(b'>');
        let c = pdf.len();
        pdf.extend_from_slice(b"\n%%EOF\n");
        let layout = SignatureLayout {
            byte_ranges: vec![[0, b, c, pdf.len() - c]],
            update_after_signature: false,
            encrypted: false,
        };
        (pdf, layout)
    };
    let check_it = |hex: &str| {
        let (pdf, layout) = build(hex);
        check_signature(&pdf, &layout).map(|_| ())
    };
    // More bytes than a CARLOS signature may hold (one past the limit), and an odd number of digits.
    assert_eq!(
        check_it(&"0".repeat((MAX_CONTENTS_BYTES + 1) * 2)),
        Err(Refusal::BadContents)
    );
    assert_eq!(check_it("ABC"), Err(Refusal::BadContents));
    // Exactly the limit passes the size check and fails later, on what it holds.
    assert_eq!(
        check_it(&"0".repeat(MAX_CONTENTS_BYTES * 2)),
        Err(Refusal::BadContents)
    );
    // Not an `<...>` pair: the unsigned bytes around the gap are never hex.
    let (mut pdf, layout) = build("00");
    let [_, b, c, _] = layout.byte_ranges[0];
    pdf[b] = b'[';
    assert_eq!(
        check_signature(&pdf, &layout).map(|_| ()),
        Err(Refusal::BadContents)
    );
    pdf[b] = b'<';
    pdf[c - 1] = b')';
    assert_eq!(
        check_signature(&pdf, &layout).map(|_| ()),
        Err(Refusal::BadContents)
    );
}

#[test]
fn a_manifest_over_the_size_limit_is_refused_after_the_signature_not_before() {
    let good = good();
    let links = std::slice::from_ref(&good.link);
    let big = vec![b' '; MAX_MANIFEST_BYTES + 1];
    assert_eq!(
        check(&good.pdf, &good.layout, Some(&big), links),
        Err(Refusal::BadManifest)
    );
    // A signature that fails is the first refusal, whatever the manifest is.
    let mut broken = good.pdf.clone();
    broken[10] ^= 0x20;
    assert_eq!(
        check(&broken, &good.layout, Some(&big), links),
        Err(Refusal::BadSignature)
    );
}
