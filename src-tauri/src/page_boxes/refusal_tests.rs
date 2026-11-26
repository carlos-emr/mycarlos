//! The reasons a quote's place on the page picture can be absent (coverage batch 2): their numbers
//! cross the helper's pipe and their names reach the app's answer, so both are a contract.

use super::*;

const ALL: [(Absent, u8, &str); 8] = [
    (Absent::NoText, 1, "noText"),
    (Absent::TextDiffers, 2, "textDiffers"),
    (Absent::Unaligned, 3, "unaligned"),
    (Absent::Skewed, 4, "skewed"),
    (Absent::OutsidePage, 5, "outsidePage"),
    (Absent::NoWidth, 6, "noWidth"),
    (Absent::TooManyLines, 7, "tooManyLines"),
    (Absent::Empty, 8, "empty"),
];

#[test]
fn each_reason_has_its_number_and_its_name_and_the_number_reads_back() {
    for (reason, number, name) in ALL {
        assert_eq!(reason.code(), number, "{name}");
        assert_eq!(reason.name(), name);
        assert_eq!(Absent::from_code(number), Some(reason), "{name}");
    }
    // Numbers and names are all different.
    let mut numbers: Vec<u8> = ALL.iter().map(|(_, number, _)| *number).collect();
    numbers.sort_unstable();
    numbers.dedup();
    assert_eq!(numbers.len(), ALL.len());
    let mut names: Vec<&str> = ALL.iter().map(|(_, _, name)| *name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), ALL.len());
}

#[test]
fn a_number_that_is_not_a_reason_reads_as_none() {
    for number in [0, 9, 10, 127, 128, 255] {
        assert_eq!(Absent::from_code(number), None, "{number}");
    }
}
