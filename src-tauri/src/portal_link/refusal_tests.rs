//! What a saved link, a clinic's key, a portal address and a sealed package must be. FAKE data only.

use super::*;
use crate::portal_approval::first_fixture;

const PORTAL: &str = "https://portal.example.test/patient";

fn link() -> StoredLink {
    StoredLink::pending(PORTAL, "FAKE device", None, 1).unwrap()
}

#[test]
fn a_portal_address_is_a_plain_https_address_within_the_limit_before_and_after_it_is_cleaned() {
    assert_eq!(normalize_portal(PORTAL).unwrap(), PORTAL);
    // A trailing slash is dropped.
    assert_eq!(
        normalize_portal("https://portal.example.test/patient/").unwrap(),
        PORTAL
    );
    for bad in [
        " https://portal.example.test/patient", // space before
        "https://portal.example.test/patient ", // space after
        "https:\\\\portal.example.test",        // a backslash
        "http://portal.example.test/patient",   // not https
        "ftp://portal.example.test/patient",
        "https://user@portal.example.test/", // credentials
        "https://user:pw@portal.example.test/",
        "https://portal.example.test/?q=1",  // a query
        "https://portal.example.test/#frag", // a fragment
        "not a url",
        "",
    ] {
        assert!(
            matches!(normalize_portal(bad), Err(LinkError::InvalidPortal)),
            "{bad:?}"
        );
    }
    // Real behaviour, pinned so that a later refusal changes this test on purpose: the WHATWG URL
    // parser skips the extra slashes, so "https:///patient" is the host "patient". It is harmless:
    // a single-label host has no public certificate to match, and what is stored is the canonical
    // address, not the text as typed.
    assert_eq!(
        normalize_portal("https:///patient").unwrap(),
        "https://patient"
    );
    // Too long as given.
    let long = format!(
        "https://portal.example.test/{}",
        "a".repeat(MAX_PORTAL_UTF8_BYTES)
    );
    assert!(matches!(
        normalize_portal(&long),
        Err(LinkError::InvalidPortal)
    ));
    // Short enough as given, but longer once written the way a URL is written (each é takes two
    // bytes here and six once percent-encoded).
    let grows = format!("https://portal.example.test/{}", "é".repeat(300));
    assert!(grows.len() <= MAX_PORTAL_UTF8_BYTES);
    assert!(matches!(
        normalize_portal(&grows),
        Err(LinkError::InvalidPortal)
    ));
}

#[test]
fn a_pending_link_needs_a_good_portal_and_a_plain_short_device_name() {
    assert!(StoredLink::pending(PORTAL, "FAKE device", None, 1).is_ok());
    assert!(matches!(
        StoredLink::pending("http://portal.example.test", "FAKE device", None, 1),
        Err(LinkError::InvalidPortal)
    ));
    for name in ["", " FAKE", "FAKE ", "FAKE\ndevice", &"d".repeat(65)] {
        assert!(
            matches!(
                StoredLink::pending(PORTAL, name, None, 1),
                Err(LinkError::InvalidDeviceName)
            ),
            "{name:?}"
        );
    }
    // The name may be 64 characters, counted as characters and not bytes.
    assert!(StoredLink::pending(PORTAL, &"é".repeat(64), None, 1).is_ok());
}

#[test]
fn a_saved_link_that_is_not_what_was_made_is_not_trusted() {
    let good = link();
    assert!(good.validate().is_ok());
    let with = |change: &dyn Fn(&mut StoredLink)| {
        let mut changed = good.clone();
        change(&mut changed);
        changed.validate()
    };
    // No id; an address written another way than it is kept; a device name that is not plain.
    assert!(with(&|l| l.id = Uuid::nil()).is_err());
    assert!(with(&|l| l.portal_base = format!("{PORTAL}/")).is_err());
    assert!(with(&|l| l.portal_base = "http://portal.example.test".into()).is_err());
    assert!(with(&|l| l.device_name = String::new()).is_err());
    assert!(with(&|l| l.device_name = "d".repeat(65)).is_err());
    // A request this device did not sign (the shared fixture's), as the current request, in the
    // history, with a history and no current request, and too many of them.
    let (_, _, attempt) = first_fixture();
    assert!(with(&|l| l.approval = Some(attempt.clone())).is_err());
    assert!(with(&|l| l.approval_history = vec![attempt.clone()]).is_err());
    assert!(with(&|l| {
        l.approval = Some(attempt.clone());
        l.approval_history = vec![attempt.clone(); crate::portal_approval::MAX_APPROVAL_REQUESTS];
    })
    .is_err());
}

#[test]
fn a_clinic_key_is_one_canonical_p256_key_that_names_itself() {
    let (_, fixture, _) = first_fixture();
    let key = fixture.clinic.as_ref().unwrap().clinic_keys[0].clone();
    assert!(key.validate().is_ok());
    let with = |change: &dyn Fn(&mut ClinicKey)| {
        let mut changed = key.clone();
        change(&mut changed);
        changed.validate()
    };
    // The name is not the hash of the key.
    assert!(matches!(
        with(&|k| k.kid = "A".repeat(43)),
        Err(LinkError::InvalidResponse)
    ));
    // The key is not base64url, or not written in its one canonical way.
    assert!(with(&|k| k.spki = format!("{}=", k.spki)).is_err());
    assert!(with(&|k| k.spki = "not base64!".into()).is_err());
    // It names itself correctly but is not a key: bytes that are not DER, and a DER key with
    // something after it.
    let name = |der: &[u8], k: &mut ClinicKey| {
        k.spki = B64.encode(der);
        k.kid = B64.encode(Sha256::digest(der));
    };
    assert!(matches!(
        with(&|k| name(b"FAKE not a key at all", k)),
        Err(LinkError::InvalidResponse)
    ));
    let mut padded = B64.decode(&key.spki).unwrap();
    padded.push(0);
    assert!(matches!(
        with(&|k| name(&padded, k)),
        Err(LinkError::InvalidResponse)
    ));
}

#[test]
fn a_sealed_package_too_short_or_not_for_this_key_is_not_opened() {
    let keys = PrivateKeys::generate();
    let aad = b"FAKE aad";
    // Shorter than a key's worth of bytes and a tag.
    for length in [0, 1, 32, 48] {
        assert!(
            keys.open_seal(&vec![1_u8; length], aad).is_err(),
            "{length}"
        );
    }
    // Long enough, but sealed to nobody: it cannot be opened.
    assert!(keys.open_seal(&[1_u8; 49], aad).is_err());
    assert!(keys.open_seal(&[0x5A_u8; 200], aad).is_err());
}
