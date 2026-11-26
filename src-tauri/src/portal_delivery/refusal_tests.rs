//! How a delivery's framed package and its signed manifest are read, and what is refused. FAKE data
//! only; nothing here is a real clinic's.

use super::*;

fn framed(parts: &[&[u8]]) -> Vec<u8> {
    frame(parts)
}

#[test]
fn a_package_is_one_to_four_parts_each_as_long_as_it_says() {
    let one = framed(&[b"mycarlos-delivery/1"]);
    let parts = unframe(&one).unwrap();
    assert_eq!(parts, vec![&b"mycarlos-delivery/1"[..]]);
    let four = framed(&[b"a", b"", b"ccc", b"dddd"]);
    let parts = unframe(&four).unwrap();
    assert_eq!(parts, vec![&b"a"[..], &b""[..], &b"ccc"[..], &b"dddd"[..]]);
    // Nothing at all is not a package.
    assert!(matches!(unframe(&[]), Err(Refusal::BadPackage)));
    // A fifth part is more than a package holds.
    let five = framed(&[b"a", b"b", b"c", b"d", b"e"]);
    assert!(matches!(unframe(&five), Err(Refusal::BadPackage)));
    // A length that is cut short (fewer than the eight bytes it takes), and one that claims
    // more than there is.
    assert!(matches!(unframe(&[0, 0, 0]), Err(Refusal::BadPackage)));
    let mut claims_more = framed(&[b"abc"]);
    claims_more.truncate(claims_more.len() - 1);
    assert!(matches!(unframe(&claims_more), Err(Refusal::BadPackage)));
    let mut huge = vec![0xFF; 8];
    huge.extend_from_slice(b"x");
    assert!(matches!(unframe(&huge), Err(Refusal::BadPackage)));
    // A good part followed by too few bytes for the next one's length.
    let mut trailing = framed(&[b"abc"]);
    trailing.extend_from_slice(&[0, 0, 1]);
    assert!(matches!(unframe(&trailing), Err(Refusal::BadPackage)));
}

#[test]
fn a_compact_signed_object_is_a_payload_a_dot_and_a_signature_within_its_limit() {
    // Too long is refused before anything is read; so is one with no dot at all.
    assert!(matches!(
        split_compact(&"a".repeat(11), 10),
        Err(Refusal::BadManifest)
    ));
    assert!(matches!(
        split_compact("nodothere", 100),
        Err(Refusal::BadManifest)
    ));
    // Not base64url on either side, not the one canonical way of writing the bytes, and a
    // signature that is not 64 bytes long.
    let signature = B64.encode([7_u8; 64]);
    assert!(matches!(
        split_compact(&format!("not base64!.{signature}"), 1000),
        Err(Refusal::BadManifest)
    ));
    assert!(matches!(
        split_compact("AAAA.not base64!", 1000),
        Err(Refusal::BadManifest)
    ));
    assert!(matches!(
        split_compact(&format!("AB.{signature}"), 1000),
        Err(Refusal::BadManifest)
    ));
    assert!(matches!(
        split_compact(&format!("AAAA.{}", B64.encode([7_u8; 63])), 1000),
        Err(Refusal::BadManifest)
    ));
    // And exactly the limit is accepted.
    let compact = format!("AAAA.{signature}");
    let (payload, found) = split_compact(&compact, compact.len()).unwrap();
    assert_eq!(payload.len(), 3);
    assert_eq!(found, vec![7_u8; 64]);
    assert!(matches!(
        split_compact(&compact, compact.len() - 1),
        Err(Refusal::BadManifest)
    ));
}

#[test]
fn a_service_date_is_a_real_calendar_day_written_as_four_two_two_digits() {
    for good in [
        "2026-11-26",
        "2024-02-29",
        "2000-02-29",
        "0001-01-01",
        "2026-12-31",
    ] {
        assert!(date(good), "{good}");
    }
    for bad in [
        "",
        "2026-1-26",      // not two digits
        "2026/11/26",     // not dashes
        "2026-11-26 ",    // a trailing space
        "26-11-2026",     // the wrong order
        "2026-02-29",     // not a leap year
        "1900-02-29",     // a century that is not a leap year
        "2026-04-31",     // a 30-day month
        "2026-00-10",     // no month zero
        "2026-13-10",     // no month thirteen
        "2026-11-00",     // no day zero
        "2026-11-32",     // no day thirty-two
        "0000-01-01",     // no year zero
        "+026-11-26",     // a sign is not a digit
        "２０２６-11-26", // full-width digits are not ASCII digits
    ] {
        assert!(!date(bad), "{bad:?}");
    }
}
