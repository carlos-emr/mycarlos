//! The de-identification re-check's matching rules that `text_recheck`'s own tests do not reach
//! (coverage batch 1).
//!
//! The re-check runs on the text a page claims to have cleaned and refuses to save or copy while a
//! vault name or a birth date is still in it. It must not be beaten by writing the same name with
//! look-alike letters (Cyrillic or Greek), with a format character slipped inside it, in
//! full-width letters, or a date in a form that differs only by a dash look-alike. FAKE names and
//! dates only.

use super::*;

/// The original text a hit covers, in UTF-16 units.
fn covered(text: &str, hit: &Hit) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[hit.start as usize..hit.end as usize]).unwrap()
}

fn one_hit(text: &str, names: &[&str], dates: &[&str]) -> Option<String> {
    let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    let dates: Vec<String> = dates.iter().map(|date| (*date).to_owned()).collect();
    let hits = identifier_hits(text, &names, &dates);
    assert!(hits.len() <= 1, "{hits:?}");
    hits.first().map(|hit| covered(text, hit))
}

#[test]
fn every_look_alike_letter_folds_to_the_latin_letter_it_imitates() {
    // Each arm of the direct fold, as the page code's own `matchingCopy` folds it.
    let table: &[(&str, &str)] = &[
        ("\u{2010}\u{2011}\u{2012}\u{2013}\u{2212}", "-----"),
        ("\u{142}\u{141}", "ll"),
        ("\u{f8}\u{d8}", "oo"),
        ("\u{111}\u{110}", "dd"),
        ("\u{df}\u{1e9e}", "ssss"),
        ("\u{e6}\u{c6}", "aeae"),
        ("\u{153}\u{152}", "oeoe"),
        ("\u{131}", "i"),
        ("\u{127}\u{126}", "hh"),
        ("\u{167}\u{166}", "tt"),
        ("\u{430}\u{410}\u{3b1}\u{391}", "aaaa"),
        ("\u{435}\u{415}\u{4bd}\u{395}", "eeee"),
        ("\u{43e}\u{41e}\u{3bf}\u{39f}", "oooo"),
        ("\u{440}\u{420}\u{3c1}\u{3a1}", "pppp"),
        ("\u{441}\u{421}", "cc"),
        ("\u{445}\u{425}\u{3a7}", "xxx"),
        ("\u{443}\u{3a5}", "yy"),
        ("\u{456}\u{406}\u{3b9}\u{399}", "iiii"),
        ("\u{455}\u{405}", "ss"),
        ("\u{458}\u{408}", "jj"),
        ("\u{4bb}\u{41d}\u{397}", "hhh"),
        ("\u{501}", "d"),
        ("\u{51b}", "q"),
        ("\u{461}", "w"),
        ("\u{412}\u{392}", "bb"),
        ("\u{41a}\u{3ba}\u{39a}", "kkk"),
        ("\u{41c}\u{39c}", "mm"),
        ("\u{422}\u{3c4}\u{3a4}", "ttt"),
        ("\u{3bd}", "v"),
        ("\u{3c5}", "u"),
        ("\u{396}", "z"),
        ("\u{39d}", "n"),
    ];
    for (look_alikes, latin) in table {
        assert_eq!(fold_to_string(look_alikes), *latin, "{look_alikes}");
    }
    // A letter that is not one of them is not folded onto a Latin one.
    assert_eq!(fold_to_string("\u{431}"), "\u{431}");
    assert_eq!(fold_to_string("\u{416}"), "\u{436}");
}

#[test]
fn a_name_written_in_look_alike_letters_is_still_found_whole() {
    // "Beatrice Paxton" with Cyrillic Ve, ie, a, i, es, Er and o.
    let text =
        "Seen by \u{412}\u{435}\u{430}tr\u{456}\u{441}\u{435} \u{420}\u{430}xt\u{43e}n today.";
    assert_eq!(
        one_hit(text, &["Beatrice Paxton"], &[]).as_deref(),
        Some("\u{412}\u{435}\u{430}tr\u{456}\u{441}\u{435} \u{420}\u{430}xt\u{43e}n")
    );
    // The same with Greek capitals and omicron.
    let greek = "Ref: \u{391}\u{39d}\u{39d}\u{391} \u{39a}\u{3bf}vacs.";
    assert_eq!(
        one_hit(greek, &["Anna Kovacs"], &[]).as_deref(),
        Some("\u{391}\u{39d}\u{39d}\u{391} \u{39a}\u{3bf}vacs")
    );
}

#[test]
fn a_name_with_a_format_character_inside_it_is_still_found_and_the_range_is_in_utf16_units() {
    // Characters the folding drops: format characters outside the cleaning's own table. One in
    // the BMP, and one in a supplementary plane (two UTF-16 units).
    for inserted in [
        '\u{0600}',
        '\u{06dd}',
        '\u{070f}',
        '\u{08e2}',
        '\u{fff9}',
        '\u{110bd}',
        '\u{13430}',
    ] {
        let text = format!("a Pax{inserted}ton b");
        let hit = one_hit(&text, &["Paxton Grey"], &[]).unwrap_or_default();
        // "Paxton" alone is a part of the name: found, with the inserted character covered.
        assert_eq!(
            hit,
            format!("Pax{inserted}ton"),
            "U+{:04X}",
            inserted as u32
        );
    }
}

#[test]
fn width_and_compatibility_forms_are_the_same_letters_and_hits_count_astral_text_before_them() {
    // Full-width letters, and a ligature.
    assert_eq!(
        one_hit("see Ｐａｘｔｏｎ now", &["Paxton Grey"], &[]).as_deref(),
        Some("Ｐａｘｔｏｎ")
    );
    assert_eq!(
        one_hit("ﬁnch", &["Finch Moore"], &[]).as_deref(),
        Some("ﬁnch")
    );
    // A supplementary character before the name moves the range by two UTF-16 units.
    let text = "😀 Paxton";
    let names = vec!["Paxton Grey".to_owned()];
    let hits = identifier_hits(text, &names, &[]);
    assert_eq!(hits, vec![Hit { start: 3, end: 9 }]);
}

#[test]
fn a_birth_date_with_a_dash_look_alike_is_still_found() {
    for dash in ['\u{2010}', '\u{2011}', '\u{2012}', '\u{2013}', '\u{2212}'] {
        let text = format!("born 1961{dash}04{dash}17.");
        let hit = one_hit(&text, &[], &["1961-04-17"]);
        assert_eq!(
            hit,
            Some(format!("1961{dash}04{dash}17")),
            "U+{:04X}",
            dash as u32
        );
    }
}

#[test]
fn a_stored_birth_date_that_is_not_a_date_gives_no_forms_and_hides_nothing() {
    for bad in [
        "",
        "1961",
        "1961-04",
        "1961-04-17-01",
        "abcd-04-17",
        "1961-xx-17",
        "1961-04-yy",
        "1961-00-17",
        "1961-13-17",
        "1961-04-00",
        "1961-04-32",
    ] {
        assert!(date_forms(bad).is_empty(), "{bad:?}");
        assert!(
            identifier_hits(
                "1961-04-17, 17 avril 1961 and April 17, 1961",
                &[],
                &[bad.to_owned()]
            )
            .is_empty(),
            "{bad:?}"
        );
    }
    // The boundaries that are dates.
    assert!(!date_forms("1961-01-01").is_empty());
    assert!(!date_forms("1961-12-31").is_empty());
}

#[test]
fn the_first_of_a_month_is_also_written_1er_in_french_and_other_days_are_not() {
    assert_eq!(
        one_hit("Né le 1er janvier 1961.", &[], &["1961-01-01"]).as_deref(),
        Some("1er janvier 1961")
    );
    assert_eq!(
        one_hit("Né le 1er juil. 1961.", &[], &["1961-07-01"]).as_deref(),
        Some("1er juil. 1961")
    );
    assert_eq!(
        one_hit("Né le 2er janvier 1961.", &[], &["1961-01-02"]),
        None
    );
}

#[test]
fn month_words_are_read_in_english_and_french_in_full_and_short() {
    for (word, number) in [
        ("january", 1),
        ("jan", 1),
        ("may", 5),
        ("sep", 9),
        ("sept", 9),
        ("september", 9),
        ("decembre", 12),
        ("janv", 1),
        ("fevr", 2),
        ("avr", 4),
        ("juil", 7),
        ("aout", 8),
        ("dec", 12),
    ] {
        assert_eq!(month_number(word), Some(number), "{word}");
    }
    for word in ["", "xyz", "ja", "janvier2", "mai.", "sept.."] {
        assert_eq!(month_number(word), None, "{word:?}");
    }
}
