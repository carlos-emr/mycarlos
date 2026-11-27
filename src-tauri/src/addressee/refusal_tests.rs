//! The rules of the addressee rewrite (K17) that `addressee`'s case file does not reach (coverage
//! batch 2). The rewrite must never change a phone number, a dose or an emergency sentence, so the
//! helpers that decide what a number is, whose line a sentence offers and where a sentence ends are
//! pinned one by one. FAKE letters and numbers only.

use super::*;

// ---- who the letter says calls --------------------------------------------------------------

#[test]
fn the_letter_names_the_patient_as_the_one_who_calls_only_for_the_patient_or_a_named_person() {
    for yes in [
        "She can call my office.",
        "Sam may call the clinic.",
        "The patient knows to call my line.",
        "She can also call my office.",
        "He is welcome to phone.",
        "Ask Ms Lind to call.",
        "Please ask her to call me.",
        "Tell him to phone the desk.",
        "They should contact my office.",
    ] {
        assert!(the_patient_calls(yes), "{yes}");
    }
    for no in [
        // The receiving doctor, another doctor, the writer and the staff are not the patient.
        "You can call my office.",
        "Dr. Lind can call my office.",
        "I can call you.",
        "We will call you.",
        "The nurse can call.",
        "Staff may phone.",
        "My office will contact you.",
        // The relayed call goes to the writer or the doctor, not the patient.
        "I will tell you to call.",
        // No call at all.
        "The results are normal.",
        "",
    ] {
        assert!(!the_patient_calls(no), "{no}");
    }
}

#[test]
fn a_summary_sentence_worded_as_the_patients_own_call_is_found() {
    for yes in [
        "Call the office.",
        "Please book a visit.",
        "Phone the clinic.",
        "Contact the desk.",
        "Ring the nurse.",
        "You can call 604-555-0123.",
        "Your results are ready, call back.",
        "I will call.",
        "The patient should call.",
        "She is to ring.",
        "They need to reach us.",
        "He must call.",
    ] {
        assert!(worded_as_patients_call(yes), "{yes}");
    }
    for no in [
        "The office will phone the lab.",
        "The clinic opens at nine.",
        "The results are normal.",
        "Doctors may call.",
        "",
    ] {
        assert!(!worded_as_patients_call(no), "{no}");
    }
}

#[test]
fn a_condition_for_calling_is_a_condition_but_a_courtesy_offer_is_not() {
    for yes in [
        "Call if the pain gets worse.",
        "Call when the fever returns.",
        "Phone unless the symptoms settle.",
        // A courtesy offer and a real condition in one sentence: the condition counts.
        "If you need help or if the pain worsens, call.",
    ] {
        assert!(tells_when_to_call(yes), "{yes}");
    }
    for no in [
        "Call if you need anything else.",
        "Phone when you have any questions.",
        "Call if you would like to discuss.",
        "Please call my office.",
        "Whenever you wish.",
        "",
    ] {
        assert!(!tells_when_to_call(no), "{no}");
    }
}

#[test]
fn an_emergency_number_or_word_is_found_whole_and_words_ignore_case_and_curly_apostrophes() {
    for yes in [
        "Call 911 now.",
        "Dial 112.",
        "999",
        "811 is the health line.",
        "Go to the Emergency room.",
        "Appelez les urgences.",
        "An ambulance came.",
    ] {
        assert!(has_emergency(yes), "{yes}");
    }
    for no in ["Room 9112 is closed.", "Call 604-555-0911.", "Normal.", ""] {
        assert!(!has_emergency(no), "{no}");
    }
    assert_eq!(
        words("Don\u{2019}t CALL (604), please!"),
        ["don't", "call", "604", "please"]
    );
}

// ---- the letter ---------------------------------------------------------------------------------

#[test]
fn a_greeting_to_a_doctor_is_a_greeting_word_then_a_title_or_a_bare_title_with_a_comma() {
    let long = format!("Dear Dr. Smith, {}", "x".repeat(80));
    for yes in [
        "Dear Dr. Smith,",
        "Dear colleague,",
        "Chère collègue,",
        "Hello doctor",
        "Dear Doctor Lind:",
        "Dr. Smith,",
        "Docteur Martin,",
    ] {
        assert!(is_doctor_greeting(yes), "{yes}");
    }
    for no in [
        "Dr. Smith",
        "Dear Sam,",
        "Dear patient",
        "Thank you for your letter.",
        "",
        // A line longer than 80 characters is text, not a greeting.
        long.as_str(),
    ] {
        assert!(!is_doctor_greeting(no), "{no}");
    }
}

#[test]
fn the_signer_is_the_first_name_after_a_closing_without_its_title_or_what_follows() {
    let signed = |tail: &str| signer(&format!("Thank you for seeing her.\n{tail}"));
    assert_eq!(
        signed("Sincerely,\nDr. Iris Oakfield, MD\n").as_deref(),
        Some("Iris Oakfield")
    );
    assert_eq!(
        signed("Yours truly\n\nDr Sam Reed (cardiology)").as_deref(),
        Some("Sam Reed")
    );
    assert_eq!(
        signed("SINCERELY.\nDocteure Anne Roy").as_deref(),
        Some("Anne Roy")
    );
    // A name that merely begins with letters of a title keeps them.
    assert_eq!(
        signed("Regards,\nDrake Lane").as_deref(),
        Some("Drake Lane")
    );
    // No closing, a closing with no name within three lines, or with no letters in the line.
    assert_eq!(signed("Please call.\nDr. Iris Oakfield"), None);
    assert_eq!(signed("Sincerely,\n\n\n\nDr. Iris Oakfield"), None);
    assert_eq!(signed("Sincerely,\n-----"), None);
    assert_eq!(signer(""), None);
}

#[test]
fn a_line_wraps_at_fifty_characters_without_a_sentence_end_counted_in_characters() {
    let line = |chars: usize, end: &str| format!("{}{end}", "a".repeat(chars));
    assert!(wraps(&line(50, "")));
    assert!(wraps(&line(50, "   ")));
    assert!(!wraps(&line(49, "")));
    for end in [".", "!", "?", ":"] {
        assert!(!wraps(&line(60, end)), "{end}");
    }
    assert!(wraps(&"\u{e9}".repeat(50)));
    assert!(!wraps(&"\u{e9}".repeat(49)));
}

#[test]
fn a_dot_ends_a_sentence_unless_an_abbreviation_or_a_decimal_comes_before_it() {
    let pages = "See Dr. Lind. Call me. Room No. 5 at 3.5 mg e.g. daily! Done.";
    let dots: Vec<(usize, bool)> = pages
        .char_indices()
        .filter(|(_, c)| matches!(c, '.' | '!' | '?'))
        .map(|(at, _)| (at, ends_sentence(pages, at)))
        .collect();
    // "Dr." no, "Lind." yes, "me." yes, "No." no, "3.5" no, "e.g." (its two dots) no, "daily!" yes,
    // "Done." (the end of the text) yes.
    let flags: Vec<bool> = dots.iter().map(|(_, ends)| *ends).collect();
    assert_eq!(
        flags,
        [false, true, true, false, false, false, false, true, true]
    );
    // Something that is not a sentence mark is never an end.
    assert!(!ends_sentence(pages, 0));
}

#[test]
fn a_quotes_sentence_runs_between_sentence_ends_or_the_lines_that_do_not_wrap() {
    let sentence = |pages: &str, quote: &str| {
        let (start, end) = find_folded(pages, quote).unwrap();
        source_sentence(pages, start, end).to_owned()
    };
    assert_eq!(
        sentence("First one. Second sentence here. Third.", "sentence"),
        "Second sentence here."
    );
    // A short heading line ends the sentence before it.
    assert_eq!(
        sentence("Dear Dr. Lind,\nPlease call me tomorrow.", "call me"),
        "Please call me tomorrow."
    );
    // A long line without an end goes on to the next line, and the sentence joins them.
    let long = "This is a long first line that keeps going and going";
    assert_eq!(
        sentence(
            &format!("{long}\nuntil the quote appears here."),
            "quote appears"
        ),
        format!("{long}\nuntil the quote appears here.")
    );
    // The abbreviation's dot before the quote does not end the sentence.
    assert_eq!(
        sentence("She saw Dr. Lind about the cough.", "cough"),
        "She saw Dr. Lind about the cough."
    );
}

// ---- phone numbers: what is one, and what is never taken for one --------------------------------

fn found(text: &str) -> Vec<&str> {
    phones(text)
        .iter()
        .map(|&(start, end, _)| &text[start..end])
        .collect()
}

#[test]
fn a_number_in_groups_of_7_to_15_digits_is_a_phone_number_as_it_is_written() {
    assert_eq!(found("Call 604-555-0123 today."), ["604-555-0123"]);
    assert_eq!(found("(604) 555-0123"), ["(604) 555-0123"]);
    assert_eq!(found("+1 604 555 0123."), ["+1 604 555 0123"]);
    assert_eq!(found("Office 555-0123."), ["555-0123"]);
    assert_eq!(
        found("604-555-0123 or 778-555-0456"),
        ["604-555-0123", "778-555-0456"]
    );
    // Two spaces are a table gap, not a separator: two numbers.
    assert_eq!(
        found("604-555-0123  778-555-0456"),
        ["604-555-0123", "778-555-0456"]
    );
    // 7 digits is the least and 15 the most.
    assert_eq!(found("555-012"), Vec::<&str>::new());
    assert_eq!(found("123456789012345").len(), 1);
    assert_eq!(found("1234567890123456").len(), 0);
}

#[test]
fn dates_and_numbers_joined_to_letters_or_marks_are_never_phone_numbers() {
    for text in [
        "On 2026-10-05 she came.",
        "On 05.10.2026 she came.",
        "On 2026 10 05 she came.",
        // Joined to what comes before: an id, a time, a path, a decimal.
        "ID6045550123",
        "ref:6045550123",
        "a/6045550123",
        "tel.6045550123",
        // And to what comes after.
        "6045550123abc",
        "6045550123/7",
    ] {
        assert!(found(text).is_empty(), "{text}");
    }
}

#[test]
fn an_extension_after_a_number_is_part_of_the_number_when_it_is_one_to_five_digits() {
    let text = "604-555-0123 ext. 21";
    assert_eq!(phones(text), [(0, 12, text.len())]);
    let x = "604-555-0123 x 4";
    assert_eq!(phones(x), [(0, 12, x.len())]);
    let poste = "604-555-0123, poste 21 merci";
    let (start, main_end, end) = phones(poste)[0];
    assert_eq!(
        (start, main_end, &poste[main_end..end]),
        (0, 12, ", poste 21")
    );
    // The extension function on its own: what it takes, in characters after the number.
    for (rest, length) in [
        ("", 0),
        (" ext. 21", 8),
        (", ext. 21", 9),
        (" ext 7", 6),
        (" poste 21", 9),
        (" x4", 3),
        (" x 12345", 8),
        // Not an extension: six digits, or letters after the digits, or another word.
        (" x 123456", 0),
        (" x4b", 0),
        (" extra 4", 0),
        (" and so on", 0),
    ] {
        assert_eq!(extension(rest), length, "{rest:?}");
    }
}

#[test]
fn a_date_is_three_groups_with_a_year_at_one_end_and_nothing_else_is() {
    for date in [
        "2026-10-05",
        "05.10.2026",
        "2026 10 05",
        "1999-1-1",
        "10/05/2026",
    ] {
        assert!(is_date(date), "{date}");
    }
    for other in [
        "604-555-0123",
        "10/05/26",
        "2026-10",
        "2126-10-05",
        "2026-100-05",
        "2026-10-05-01",
        "",
    ] {
        assert!(!is_date(other), "{other}");
    }
    assert_eq!(digits_of("(604) 555-0123"), "6045550123");
    assert_eq!(digits_of("no digits"), "");
}
