//! Evaluation candidate (16 Nov 2026), v2: the document trim. Before the helper fits the pages,
//! whole administrative lines leave the letter, so the model reads fewer tokens of a faxed or
//! printed copy. v2 works by line CLASS, each checked word by word: a line goes only if every
//! word in it is a date, a time, a number or identifier, a page counter, a word of the class's
//! small administrative vocabulary, or (fax headers, print footers and "From:" fields only) part
//! of an organization name that the letter's body also names (Ben's safeguard, 16 Nov). Classes:
//! - a fax transmission header (a date, a time, a page counter and a fax signal: "FAX", "From",
//!   "To", "Received", an arrow or a fax number);
//! - a page counter in any of the letters' languages ("Page 2 of 5", "Pg 02/04", "P. 2/3",
//!   "@001/003", "Page 2 de 5", "Strona 1 z 2", "— 2 —");
//! - a print or copy footer ("printed <date> … by <user> … Page 1 of 7"; a bare "Printed:
//!   <date>" stays, as it may be the document's only date);
//! - a misdirected-fax notice: a paragraph (at most 8 lines) that opens like a notice and says
//!   who it is meant for, that it reached someone in error, and what to do;
//! - a dictation, transcription or signature stamp (D:/T:, "Dicté le … Transcrit le", job numbers,
//!   typist initials, "not proofread") with no clinician named;
//! - an end marker ("--- END OF REPORT ---"), a fax cover title, a page-count or fax-number field,
//!   a "From:" field naming no clinician, and a cc to a chart or records.
//!
//! Never removed: a line with a patient label ("Re:", "Patient:", "DOB", "Health card", …) or a
//! word of the letter's own patient name; letterheads, test banners, closings, names, dates in
//! cover fields, clinical lines. **Name safeguard:** an organization named in a fax header, print
//! footer or "From:" field must appear as the same phrase ("NORTHGATE EX HOSP" ~ "Northgate
//! Example Hospital") in a kept line of a page's body, not within the first or last two kept
//! lines of a page, where letterheads, running headers, signatures and footers sit. Otherwise the
//! line stays. A trimmed page keeps its other lines, in order.
//!
//! Pure std, so its tests run on their own: `rustc --edition 2021 --test src/document_trim.rs`.
//! The cases are shared with the evaluation's Python port (`document_trim_cases.txt`).

/// The trim's name in a measurement.
#[allow(dead_code)]
pub(crate) const NAME: &str = "document-trim-2";

/// Kept lines this close to a page's top or bottom are letterhead, running header, signature or
/// footer, not body: a name found only there does not count for the safeguard.
const MARGIN: usize = 2;

const MONTHS: &[&str] = &[
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
    "janv",
    "fevr",
    "fev",
    "mars",
    "avr",
    "mai",
    "juin",
    "juil",
    "aout",
    "déc",
    "january",
    "february",
    "march",
    "april",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "janvier",
    "fevrier",
    "avril",
    "juillet",
    "septembre",
    "octobre",
    "novembre",
    "decembre",
];
const AMPM_TZ: &[&str] = &[
    "am", "pm", "a.m.", "p.m.", "est", "edt", "cst", "cdt", "mst", "mdt", "pst", "pdt", "ast",
    "adt", "nst", "ndt", "utc", "gmt", "hne", "hae",
];
const FAX_WORDS: &[&str] = &[
    "fax",
    "faxcom",
    "telefax",
    "facsimile",
    "from",
    "to",
    "de",
    "a",
    "received",
    "recu",
    "sent",
    "envoye",
    "id",
    "page",
    "pages",
    "pg",
    "p",
    "of",
    "sur",
    "faks",
    "str",
    "telec",
    "telecopie",
    "telecopieur",
    "tx",
    "rx",
    "station",
    "tel",
];
const FAX_SIGNALS: &[&str] = &[
    "fax", "faxcom", "telefax", "from", "to", "received", "sent", "faks", "telec", "de", "a", "tx",
    "rx",
];
const FOOTER_WORDS: &[&str] = &[
    "printed",
    "imprime",
    "print",
    "le",
    "on",
    "by",
    "par",
    "user",
    "utilisateur",
    "copy",
    "copie",
    "chart",
    "original",
    "not",
    "for",
    "redistribution",
    "verify",
    "against",
    "electronic",
    "electronique",
    "record",
    "records",
    "health",
    "information",
    "confidential",
    "confidentiel",
    "confidentielle",
    "document",
    "ce",
    "est",
    "page",
    "pages",
    "pg",
    "of",
    "de",
    "sur",
    "continued",
    "next",
    "suite",
    "archives",
    "this",
    "dossier",
    "medical",
    "medicale",
    "medicales",
];
const STAMP_WORDS: &[&str] = &[
    "dictated",
    "dicte",
    "dictee",
    "transcribed",
    "transcrit",
    "transcrite",
    "typed",
    "le",
    "on",
    "by",
    "par",
    "d",
    "t",
    "job",
    "doc",
    "id",
    "no",
    "n",
    "numero",
    "signed",
    "electronically",
    "electroniquement",
    "e",
    "esigned",
    "signe",
    "signee",
    "document",
    "non",
    "valide",
    "sans",
    "signature",
    "to",
    "expedite",
    "delivery",
    "not",
    "proofread",
    "avoid",
    "delay",
    "read",
    "but",
    "mais",
    "relu",
    "revu",
    "dokument",
    "dyktowany",
    "nieprzeczytany",
    "przez",
    "lekarza",
    "and",
    "et",
    "date",
    "time",
    "heure",
    "transcription",
    "dictation",
    "reviewed",
    "verified",
    "unverified",
];
const STAMP_KEYS: &[&str] = &[
    "dictated",
    "dicte",
    "dictee",
    "transcribed",
    "transcrit",
    "transcrite",
    "signed",
    "esigned",
    "signe",
    "signee",
    "proofread",
    "relu",
    "dyktowany",
    "job",
    "d",
    "t",
];
const END_WORDS: &[&str] = &[
    "end",
    "of",
    "report",
    "transmission",
    "chart",
    "copy",
    "document",
    "fin",
    "du",
    "de",
    "la",
    "le",
    "rapport",
    "telecopie",
    "continued",
    "on",
    "next",
    "page",
    "suite",
    "a",
    "suivante",
    "final",
    "fax",
];
const END_KEYS: &[&str] = &["end", "fin", "continued", "suite", "final"];
const CC_TARGETS: &[&str] = &[
    "chart", "patient", "health", "records", "record", "file", "dossier", "medical", "archives",
    "the", "le", "au", "of",
];
const CC_KINDS: &[&str] = &["chart", "records", "record", "dossier", "file", "archives"];
const DOCTOR_WORDS: &[&str] = &[
    "dr",
    "dre",
    "doctor",
    "docteur",
    "md",
    "lek",
    "prof",
    "rn",
    "np",
    "inf",
    "infirmiere",
];
const MISDIRECT: &[&str] = &[
    "in error",
    "par erreur",
    "not the intended",
    "pas le destinataire",
    "intended recipient",
    "intended only",
    "destine uniquement",
    "destinee uniquement",
    "destine exclusivement",
    "destinee exclusivement",
    "strictly prohibited",
    "strictement interdit",
    "misdirected",
    "wrong number",
    "by mistake",
];
const RECIPIENT: &[&str] = &[
    "recipient",
    "addressee",
    "destinataire",
    "intended for",
    "individual or entity",
    "person named",
    "personne nommee",
    "named above",
    "named recipient",
];
const ACTION: &[&str] = &[
    "destroy", "detrui", "delete", "supprim", "return", "retourn", "notify", "aviser", "avisez",
    "call", "telephon", "contact", "prevenir", "informer", "fax back",
];

/// The letter's pages with the administrative lines taken out (same number of pages).
pub(crate) fn trim(pages: &[&str]) -> Vec<String> {
    let flat: Vec<(usize, &str)> = pages
        .iter()
        .enumerate()
        .flat_map(|(page, text)| text.split('\n').map(move |line| (page, line)))
        .collect();
    let texts: Vec<&str> = flat.iter().map(|(_, line)| *line).collect();
    let found = candidates(&texts);
    let is_candidate = |index: usize| found.iter().any(|(at, _)| *at == index);
    // Kept body lines: not among the first or last MARGIN kept non-blank lines of their page.
    let mut body: Vec<Vec<String>> = Vec::new();
    for page in 0..pages.len() {
        let kept: Vec<usize> = (0..flat.len())
            .filter(|&k| flat[k].0 == page && !is_candidate(k) && !flat[k].1.trim().is_empty())
            .collect();
        if kept.len() > 2 * MARGIN {
            body.extend(
                kept[MARGIN..kept.len() - MARGIN]
                    .iter()
                    .map(|&k| words(flat[k].1)),
            );
        }
    }
    let mut out = vec![Vec::new(); pages.len()];
    for (index, (page, line)) in flat.iter().enumerate() {
        let drop = found.iter().any(|(at, rest)| {
            *at == index && rest.as_ref().is_none_or(|rest| names_ok(rest, &body))
        });
        if !drop {
            out[*page].push(*line);
        }
    }
    out.into_iter().map(|kept| kept.join("\n")).collect()
}

/// Lines of a class, before the safeguard: (line, the residual organization words to find in the
/// body, or `None` when the line goes as it is).
fn candidates(lines: &[&str]) -> Vec<(usize, Option<Vec<String>>)> {
    let mut out = Vec::new();
    let patient = patient_words(lines);
    let about_patient =
        |text: &str| has_patient_label(text) || words(text).iter().any(|w| patient.contains(w));
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if let Some(end) = notice_end(lines, i) {
            if !about_patient(&lines[i..end].join(" ")) {
                out.extend((i..end).map(|k| (k, None)));
                i = end;
                continue;
            }
        }
        if about_patient(line) {
            i += 1;
            continue;
        }
        if fax_header(line) {
            out.push((i, Some(residual(line, &[FAX_WORDS], &[]))));
        } else if page_or_footer(line) {
            let fax_words: Vec<&str> = FAX_WORDS
                .iter()
                .copied()
                .filter(|w| *w != "to" && *w != "from")
                .collect();
            let rest = residual(line, &[FOOTER_WORDS, END_WORDS, &fax_words], &[]);
            if print_stamp(line) {
                if footer_evidence(line) {
                    out.push((i, Some(rest)));
                }
            } else if rest.is_empty() {
                out.push((i, None));
            }
        } else if cover_title(line)
            || pages_field(line)
            || fax_number_field(line)
            || cc_records(line)
            || end_marker(line)
        {
            out.push((i, None));
        } else if let Some(who) = from_field(line) {
            if !names_a_clinician(&who) {
                let office: &[&str] = &["department", "service", "office", "bureau"];
                out.push((
                    i,
                    Some(residual(&who, &[FOOTER_WORDS, FAX_WORDS, office], &[])),
                ));
            }
        } else if !names_a_clinician(line) && stamp(line) {
            out.push((i, None));
        }
        i += 1;
    }
    out
}

// --- Words ----------------------------------------------------------------------------------

/// Lower case, accents dropped (letters that decompose to a base letter and marks), and the OCR
/// swaps 0→o and 1→l inside a word that has letters ("C0MMUNITY", "Hospita1").
fn fold(text: &str) -> String {
    const FROM: &str = "àáâãäåçèéêëìíîïñòóôõöùúûüýÿąćęńśźż";
    const TO: &str = "aaaaaaceeeeiiiinooooouuuuyyacenszz";
    let mapped: String = text
        .to_lowercase()
        .chars()
        .map(|c| {
            FROM.chars()
                .position(|f| f == c)
                .map_or(c, |at| TO.chars().nth(at).unwrap())
        })
        .collect();
    mapped
        .split_inclusive(|c: char| !c.is_alphanumeric())
        .map(|piece| {
            let has_letter = piece.chars().any(|c| c.is_ascii_lowercase());
            let has_digit = piece.chars().any(|c| c.is_ascii_digit());
            if has_letter && has_digit {
                piece.replace('0', "o").replace('1', "l")
            } else {
                piece.to_owned()
            }
        })
        .collect()
}

/// The folded words (letters and digits) of a text.
fn words(text: &str) -> Vec<String> {
    fold(text)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_digit())
}

fn ascii_letters(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_lowercase())
}

fn trim_chars<'a>(text: &'a str, chars: &str) -> &'a str {
    text.trim_matches(|c| chars.contains(c))
}

// --- Dates, times, numbers, counters ---------------------------------------------------------

fn is_date_token(token: &str) -> bool {
    let folded = fold(token);
    let t = trim_chars(&folded, ",.;()[]");
    let parts: Vec<&str> = t.split(['-', '/', '.']).collect();
    if parts.len() == 3 {
        let (a, b, c) = (parts[0], parts[1], parts[2]);
        let n = |s: &str, lo: usize, hi: usize| all_digits(s) && (lo..=hi).contains(&s.len());
        let seps: Vec<char> = t.chars().filter(|c| "-/.".contains(*c)).collect();
        // 2026-11-09, 2026/11/09
        if n(a, 4, 4) && n(b, 1, 2) && n(c, 1, 2) && seps[0] == seps[1] && seps[0] != '.' {
            return true;
        }
        // 19/10/2026, 10.11.2026, 02-11-2026
        if n(a, 1, 2) && n(b, 1, 2) && n(c, 2, 4) {
            return true;
        }
        // 13-NOV-2026, 28-Oct-2026, OCT-19-2026
        let month = |s: &str| ascii_letters(s) && (3..=9).contains(&s.len()) && MONTHS.contains(&s);
        if seps.iter().all(|c| *c != '.') {
            if n(a, 1, 2) && month(b) && n(c, 2, 4) {
                return true;
            }
            if month(a) && n(b, 1, 2) && n(c, 2, 4) {
                return true;
            }
        }
    }
    false
}

/// Tokens a date at `at` takes: 1, or 3 ("Nov 14, 2026", "14 Nov 2026", "10 novembre 2026").
fn date_len(tokens: &[&str], at: usize) -> usize {
    if tokens.get(at).is_some_and(|t| is_date_token(t)) {
        return 1;
    }
    if at + 2 < tokens.len() {
        let f: Vec<String> = tokens[at..at + 3]
            .iter()
            .map(|t| trim_chars(&fold(t), ",.").to_owned())
            .collect();
        let day = |s: &str| all_digits(s) && s.len() <= 2;
        let year = |s: &str| all_digits(s) && s.len() == 4;
        let month = |s: &str| MONTHS.contains(&s);
        if (month(&f[0]) && day(&f[1]) && year(&f[2]))
            || (day(&f[0]) && month(&f[1]) && year(&f[2]))
        {
            return 3;
        }
    }
    0
}

fn is_time_token(token: &str) -> bool {
    let folded = fold(token);
    let t = trim_chars(&folded, ",.;()");
    let t = t
        .strip_suffix("am")
        .or_else(|| t.strip_suffix("pm"))
        .unwrap_or(t);
    if let Some((h, m)) = t.split_once('h') {
        return all_digits(h) && h.len() <= 2 && all_digits(m) && m.len() == 2;
    }
    let parts: Vec<&str> = t.split(':').collect();
    (parts.len() == 2 || parts.len() == 3)
        && all_digits(parts[0])
        && parts[0].len() <= 2
        && parts[1..].iter().all(|p| all_digits(p) && p.len() == 2)
}

fn is_tz(token: &str) -> bool {
    let folded = fold(token);
    let t = trim_chars(&folded, ",.;()");
    AMPM_TZ.contains(&t)
        || (t.len() == 5 && (t.starts_with('+') || t.starts_with('-')) && all_digits(&t[1..]))
}

fn is_phone(token: &str) -> bool {
    let body = token.strip_prefix('+').unwrap_or(token);
    let digits = token.chars().filter(|c| c.is_ascii_digit()).count();
    body.chars().count() >= 7
        && body
            .chars()
            .all(|c| c.is_ascii_digit() || "().-".contains(c))
        && (7..=15).contains(&digits)
        && !is_date_token(token)
}

fn is_number_or_id(token: &str) -> bool {
    let t = trim_chars(token, ",.;:()[]#");
    if t.is_empty() || !t.chars().any(|c| c.is_ascii_digit()) {
        return false;
    }
    // No run of 4+ letters once "fake" is taken out (an id, not a word with a number).
    let folded = fold(t).replace("fake", "");
    let mut run = 0;
    for c in folded.chars() {
        run = if c.is_ascii_lowercase() { run + 1 } else { 0 };
        if run >= 4 {
            return false;
        }
    }
    true
}

/// "n/m" with 1–4 digits each side.
fn fraction(text: &str) -> Option<(&str, &str)> {
    let (a, b) = text.split_once('/')?;
    (all_digits(a) && a.len() <= 4 && all_digits(b) && b.len() <= 4).then_some((a, b))
}

/// One token that is a counter: "P.002/003", "Pg02/04", "@001/003", "P01", "002/003" (not a
/// 1–2 digit fraction such as "1/2").
fn counter_token(token: &str) -> bool {
    if let Some(rest) = token.strip_prefix('p') {
        if all_digits(rest) && rest.len() <= 3 {
            return true;
        }
    }
    let mut t = token;
    for prefix in ["page", "pg", "str", "p", "s"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest;
            break;
        }
    }
    let t = t.strip_prefix('.').unwrap_or(t);
    let t = t.strip_prefix('@').unwrap_or(t);
    match fraction(t) {
        Some((a, b)) => !(t.len() == token.len() && a.len() <= 2 && b.len() <= 2),
        None => false,
    }
}

/// Indexes of the tokens that form page counters.
fn counter_spans(tokens: &[&str]) -> Vec<usize> {
    let f: Vec<String> = tokens
        .iter()
        .map(|t| trim_chars(&fold(t), ",;:").to_owned())
        .collect();
    let n = tokens.len();
    let num = |s: &str| all_digits(s) && s.len() <= 4;
    let dash = |s: &str| ["—", "–", "-", "--"].contains(&s);
    let mut out = Vec::new();
    for i in 0..n {
        let word = f[i].as_str();
        if [
            "page", "pg", "p", "p.", "pages", "strona", "pagina", "s.", "str.", "str",
        ]
        .contains(&word)
        {
            if i + 3 < n
                && num(&f[i + 1])
                && ["of", "de", "sur", "z", "/"].contains(&f[i + 2].as_str())
                && num(&f[i + 3])
            {
                out.extend(i..i + 4);
            } else if i + 1 < n && fraction(&f[i + 1]).is_some() {
                out.extend([i, i + 1]);
            } else if i + 1 < n && (word == "pg" || word == "page") && num(&f[i + 1]) {
                out.extend([i, i + 1]);
            }
        }
        if counter_token(word) {
            out.push(i);
        }
        if num(word) && i > 0 && i + 1 < n && dash(tokens[i - 1]) && dash(tokens[i + 1]) {
            out.extend([i - 1, i, i + 1]);
        }
    }
    out
}

/// The token after "by", "user:", "par", "utilisateur:" is a user id.
fn user_ids(tokens: &[&str]) -> Vec<usize> {
    let mut out = Vec::new();
    for i in 0..tokens.len().saturating_sub(1) {
        let w = fold(tokens[i]);
        if ["by", "user", "par", "utilisateur", "operator", "op"].contains(&trim_chars(&w, ":,")) {
            out.push(i + 1);
        }
    }
    out
}

/// Typist initials in a stamp: "SL/am", "/kp", "FH/dt", a lone "ld".
fn initials(tokens: &[&str]) -> Vec<usize> {
    let letters = |s: &str, lo: usize, hi: usize| {
        (lo..=hi).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphabetic())
    };
    tokens
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            t.split_once('/')
                .is_some_and(|(a, b)| letters(a, 0, 4) && letters(b, 1, 4))
                || (t.len() == 2 && t.chars().all(|c| c.is_ascii_lowercase()))
        })
        .map(|(i, _)| i)
        .collect()
}

/// The line's words that are not dates, times, time zones, numbers or ids, counters, user ids,
/// phones, decorations or words of the vocabularies.
fn residual(line: &str, vocabularies: &[&[&str]], skip_tokens: &[usize]) -> Vec<String> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let mut skip: Vec<usize> = skip_tokens.to_vec();
    skip.extend(counter_spans(&tokens));
    skip.extend(user_ids(&tokens));
    let mut i = 0;
    while i < tokens.len() {
        let n = date_len(&tokens, i);
        if n > 0 {
            skip.extend(i..i + n);
            i += n;
            continue;
        }
        let t = tokens[i];
        if is_time_token(t) || is_tz(t) || is_phone(t) || is_number_or_id(t) {
            skip.push(i);
        }
        i += 1;
    }
    let mut rest = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        if skip.contains(&i) {
            continue;
        }
        for w in words(token) {
            if w.chars().all(char::is_numeric)
                || vocabularies.iter().any(|v| v.contains(&w.as_str()))
            {
                continue;
            }
            rest.push(w);
        }
    }
    rest
}

/// Ben's safeguard: the organization words, in order, each start the next word of ONE kept body
/// line ("NORTHGATE EX HOSP" ~ "Northgate Example Hospital").
fn names_ok(rest: &[String], body: &[Vec<String>]) -> bool {
    let name: Vec<&String> = rest
        .iter()
        .filter(|w| !w.chars().all(char::is_numeric))
        .collect();
    if !name.iter().any(|w| w.chars().count() >= 4) {
        return true;
    }
    body.iter().any(|line| {
        line.len() >= name.len()
            && (0..=line.len() - name.len()).any(|start| {
                name.iter()
                    .enumerate()
                    .all(|(j, w)| line[start + j].starts_with(w.as_str()))
            })
    })
}

// --- Patients and clinicians -----------------------------------------------------------------

/// Starts of whole words in a folded text: (byte index, the word).
fn word_starts(folded: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in folded.char_indices() {
        if c.is_alphanumeric() {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            out.push((s, &folded[s..i]));
        }
    }
    if let Some(s) = start {
        out.push((s, &folded[s..]));
    }
    out
}

/// After `at`: optional spaces then ':' or '#', or two or more whitespace characters. The index
/// after it.
fn label_end(folded: &str, at: usize) -> Option<usize> {
    let rest = &folded[at..];
    let spaces = rest.len() - rest.trim_start().len();
    let after = &rest[spaces..];
    if after.starts_with(':') || after.starts_with('#') {
        return Some(at + spaces + 1);
    }
    let ws = rest.chars().take_while(|c| c.is_whitespace()).count();
    (ws >= 2).then(|| at + rest.char_indices().nth(ws).map_or(rest.len(), |(i, _)| i))
}

fn has_patient_label(text: &str) -> bool {
    const LABELS: &[&str] = &[
        "re", "patient", "patiente", "pacjent", "dob", "mrn", "hcn", "phn", "ohip", "ramq", "nas",
        "name", "nom", "objet", "subject", "client",
    ];
    const PHRASES: &[&str] = &[
        "date of birth",
        "date de naissance",
        "health card",
        "carte sante",
        "ne le",
        "nee le",
        "ne(e) le",
        "nee) le",
        "born",
    ];
    let folded = fold(text);
    let starts = word_starts(&folded);
    for (s, w) in &starts {
        if LABELS.contains(w) {
            let rest = &folded[s + w.len()..];
            let after = rest.trim_start_matches([' ', '\t']);
            if after.starts_with(':') || after.starts_with('#') {
                return true;
            }
        }
    }
    PHRASES.iter().any(|phrase| {
        starts.iter().any(|(s, _)| {
            folded[*s..].starts_with(phrase)
                && folded[s + phrase.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_alphanumeric())
        })
    })
}

/// Words of the patient's name segment ("Patient: <name> ·", "Re: <name>  DOB").
fn patient_words(lines: &[&str]) -> Vec<String> {
    const LABELS: &[&str] = &[
        "nom du patient",
        "patient name",
        "re",
        "patient",
        "patiente",
        "pacjent",
        "name",
        "nom",
        "objet",
        "subject",
        "client",
    ];
    const STOPS: &[&str] = &[
        "mrn",
        "dob",
        "hcn",
        "phn",
        "ohip",
        "ramq",
        "pesel",
        "health card",
        "date of birth",
        "date de naissance",
        "data urodzenia",
        "sex",
        "sexe",
        "age",
        "visit",
        "accession",
        "chart",
    ];
    let mut out = Vec::new();
    for line in lines {
        let folded = fold(line);
        let mut from = 0;
        let starts = word_starts(&folded);
        for (s, _) in &starts {
            if *s < from {
                continue;
            }
            let Some((label, end)) = LABELS.iter().find_map(|label| {
                let tail = &folded[*s..];
                let fits = tail.starts_with(label)
                    && tail[label.len()..]
                        .chars()
                        .next()
                        .is_none_or(|c| !c.is_alphanumeric());
                fits.then(|| label_end(&folded, s + label.len()).map(|end| (*label, end)))
                    .flatten()
            }) else {
                continue;
            };
            let _ = label;
            let segment = &folded[end..];
            let mut stop = segment.len();
            for (i, c) in segment.char_indices() {
                let ws2 = c.is_whitespace()
                    && segment[i + c.len_utf8()..]
                        .chars()
                        .next()
                        .is_some_and(char::is_whitespace);
                let word_stop = (i == 0
                    || !segment[..i].chars().next_back().unwrap().is_alphanumeric())
                    && STOPS.iter().any(|w| {
                        segment[i..].starts_with(w)
                            && segment[i + w.len()..]
                                .chars()
                                .next()
                                .is_none_or(|c| !c.is_alphanumeric())
                    });
                if c == '·' || c == '|' || c == ';' || ws2 || word_stop {
                    stop = i;
                    break;
                }
            }
            for w in words(&segment[..stop]) {
                if w.chars().count() >= 4 && !w.chars().all(char::is_numeric) && w != "fake" {
                    out.push(w);
                }
            }
            from = end;
        }
    }
    out
}

fn names_a_clinician(text: &str) -> bool {
    words(text)
        .iter()
        .any(|w| DOCTOR_WORDS.contains(&w.as_str()))
}

// --- Classes ----------------------------------------------------------------------------------

fn fax_header(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let has_date = (0..tokens.len()).any(|i| date_len(&tokens, i) > 0);
    let has_time = tokens.iter().any(|t| is_time_token(t));
    let has_counter = !counter_spans(&tokens).is_empty();
    let signal = tokens.iter().any(|t| {
        words(t).iter().any(|w| FAX_SIGNALS.contains(&w.as_str()))
            || [">>", ">>>", "->", "-->", "=>", "→", ">"].contains(t)
            || is_phone(t)
    });
    has_date && has_time && has_counter && signal
}

/// "printed/imprimé (le|on|date|:) <date>".
fn print_stamp(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (i, t) in tokens.iter().enumerate() {
        let folded = fold(t);
        if ["printed", "imprime", "print"].contains(&trim_chars(&folded, ":,.-—")) {
            let mut j = i + 1;
            while j < tokens.len()
                && ["le", "on", "date", ":", ""].contains(&trim_chars(&fold(tokens[j]), ":,."))
            {
                j += 1;
            }
            if date_len(&tokens, j) > 0 {
                return true;
            }
        }
    }
    false
}

/// A print stamp is a footer only with more than its date: a page counter, a user id, or a
/// copy/chart/confidential word.
fn footer_evidence(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    !counter_spans(&tokens).is_empty()
        || !user_ids(&tokens).is_empty()
        || words(line).iter().any(|w| {
            [
                "copy",
                "copie",
                "chart",
                "confidential",
                "confidentiel",
                "confidentielle",
                "redistribution",
                "verify",
            ]
            .contains(&w.as_str())
        })
}

fn page_or_footer(line: &str) -> bool {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    !counter_spans(&tokens).is_empty() || print_stamp(line)
}

fn stamp(line: &str) -> bool {
    let w = words(line);
    let keys: Vec<&str> = STAMP_KEYS
        .iter()
        .copied()
        .filter(|k| w.iter().any(|x| x == k))
        .collect();
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let has_dt = tokens
        .iter()
        .any(|t| ["d", "t"].contains(&trim_chars(&fold(t), ",.;:")))
        && (0..tokens.len()).any(|i| date_len(&tokens, i) > 0);
    let strong =
        keys.iter().any(|k| !["d", "t", "job"].contains(k)) || has_dt || keys.contains(&"job");
    strong && residual(line, &[STAMP_WORDS], &initials(&tokens)).is_empty()
}

fn end_marker(line: &str) -> bool {
    let w = words(line);
    let decorated = line
        .chars()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|pair| pair.iter().all(|c| "*=-#_~".contains(*c)));
    w.iter().any(|x| END_KEYS.contains(&x.as_str()))
        && residual(line, &[END_WORDS], &[]).is_empty()
        && decorated
}

fn cover_title(line: &str) -> bool {
    let mut s = line.trim().to_owned();
    let groups: Vec<&str> = split_wide(line.trim());
    let singles: Vec<&str> = groups.iter().flat_map(|g| g.split_whitespace()).collect();
    if singles.len() >= 5 && singles.iter().all(|t| t.chars().count() == 1) {
        s = groups
            .iter()
            .map(|g| g.split_whitespace().collect::<String>())
            .collect::<Vec<_>>()
            .join(" ");
    }
    let folded = fold(&s);
    let f = folded.trim_matches(|c: char| " *-—=:".contains(c));
    const TITLES: &[&str] = &[
        "fax",
        "fax cover",
        "fax cover sheet",
        "facsimile cover sheet",
        "facsimile",
        "fax transmission",
        "fax transmittal",
        "fax transmittal sheet",
        "transmission",
        "bordereau de telecopie",
        "telecopie",
        "bordereau de transmission",
        "page couverture",
        "page de garde",
        "cover sheet",
        "cover page",
        "fax transmission cover sheet",
    ];
    if TITLES.contains(&f) {
        return true;
    }
    // "FAX — ONE REFERRAL ENCLOSED"
    f.strip_prefix("fax")
        .map(str::trim_start)
        .and_then(|rest| rest.strip_prefix(['—', '–', '-']))
        .map(str::trim_start)
        .is_some_and(|rest| {
            rest.ends_with("enclosed")
                && rest.chars().count() - "enclosed".len() <= 40
                && rest[..rest.len() - "enclosed".len()]
                    .chars()
                    .next_back()
                    .is_none_or(|c| !c.is_alphanumeric())
        })
}

/// Splits at runs of two or more whitespace characters.
fn split_wide(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut k = 0;
    while k < chars.len() {
        if chars[k].1.is_whitespace() {
            let mut e = k;
            while e < chars.len() && chars[e].1.is_whitespace() {
                e += 1;
            }
            if e - k >= 2 {
                out.push(&text[start..chars[k].0]);
                start = if e < chars.len() {
                    chars[e].0
                } else {
                    text.len()
                };
            }
            k = e;
        } else {
            k += 1;
        }
    }
    out.push(&text[start..]);
    out
}

fn pages_field(line: &str) -> bool {
    let Some((label, value)) = line.rsplit_once(':') else {
        return false;
    };
    let label = fold(label);
    let label = label.trim();
    let value = fold(value);
    let value = value.trim();
    const ALLOWED: &[&str] = &[
        "total",
        "number",
        "of",
        "nb",
        "nombre",
        "de",
        "pages",
        "page",
        "incl",
        "including",
        "cover",
        "this",
        "la",
        "incluant",
        "celle",
        "ci",
        "couverture",
        "y",
        "compris",
        "sheet",
        "the",
    ];
    let digits_end = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    let (number, tail) = value.split_at(digits_end);
    let tail = tail.trim_start();
    let tail_ok = tail.is_empty()
        || (tail.starts_with('(')
            && tail.ends_with(')')
            && tail[1..tail.len() - 1].matches(')').count() == 0
            && ["including", "incl", "incluant", "y compris"]
                .iter()
                .any(|w| tail[1..].starts_with(w)));
    label.contains("page")
        && label.chars().count() <= 45
        && all_digits(number)
        && number.len() <= 3
        && tail_ok
        && words(label)
            .iter()
            .all(|w| w.chars().count() < 3 || ALLOWED.contains(&w.as_str()))
}

fn fax_number_field(line: &str) -> bool {
    let folded = fold(line);
    let f = folded.trim();
    for label in [
        "no de telecopieur",
        "fax number",
        "telecopieur",
        "fax no.",
        "fax no",
        "telec.",
        "telec",
        "faks",
        "fax",
    ] {
        if let Some(rest) = f.strip_prefix(label) {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
            let digits = rest.chars().filter(|c| c.is_ascii_digit()).count();
            return rest.chars().count() >= 7
                && rest
                    .chars()
                    .all(|c| c.is_ascii_digit() || " ().+-".contains(c))
                && digits >= 7;
        }
    }
    false
}

/// "From: <who>": who (the original text after the first colon), when the line has that shape.
fn from_field(line: &str) -> Option<String> {
    let (label, who) = line.split_once(':')?;
    let label = fold(label);
    (["from", "de", "expediteur", "sender", "od"].contains(&label.trim()) && !who.trim().is_empty())
        .then(|| who.to_owned())
}

fn cc_records(line: &str) -> bool {
    let folded = fold(line);
    let f = folded.trim();
    for prefix in [
        "copie conforme",
        "copie au",
        "copie a",
        "copy to",
        "copie",
        "c.c.",
        "cc",
    ] {
        if let Some(rest) = f.strip_prefix(prefix) {
            let rest = rest.trim_start();
            let rest = rest
                .strip_prefix(':')
                .or_else(|| rest.strip_prefix('.'))
                .unwrap_or(rest)
                .trim();
            let w = words(rest);
            return !w.is_empty()
                && w.iter().all(|x| CC_TARGETS.contains(&x.as_str()))
                && w.iter().any(|x| CC_KINDS.contains(&x.as_str()));
        }
    }
    false
}

fn notice_start(line: &str) -> bool {
    const STARTS: &[&str] = &[
        "confidentiality",
        "confidential",
        "privacy",
        "warning",
        "notice",
        "avis",
        "avertissement",
        "important",
        "this fax",
        "this facsimile",
        "this message",
        "this transmission",
        "this report",
        "this document",
        "this communication",
        "this email",
        "this e-mail",
        "this telecopy",
        "the document accompanying",
        "the documents accompanying",
        "the information accompanying",
        "the information contained",
        "the information in this",
        "the information transmitted",
        "the pages accompanying",
        "the page accompanying",
        "the documents contained",
        "the documents in this",
        "the documents transmitted",
        "the document contained",
        "the document in this",
        "the document transmitted",
        "the pages contained",
        "the pages in this",
        "the pages transmitted",
        "the page contained",
        "the page in this",
        "the page transmitted",
        "ce document",
        "ce message",
        "ce telecopie",
        "cette telecopie",
        "les renseignements",
        "l'information",
    ];
    let folded = fold(line);
    let f = folded
        .trim_start()
        .trim_start_matches(['[', '(', '*'])
        .trim_start();
    STARTS.iter().any(|s| {
        f.starts_with(s)
            && match *s {
                "confidential" | "avis" | "important" => f[s.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_alphanumeric()),
                _ => true,
            }
    })
}

/// If a misdirected-fax notice starts at line `i`, the index after it.
fn notice_end(lines: &[&str], i: usize) -> Option<usize> {
    if !notice_start(lines[i]) {
        return None;
    }
    let mut text = String::new();
    for (j, line) in lines
        .iter()
        .enumerate()
        .take((i + 8).min(lines.len()))
        .skip(i)
    {
        if line.trim().is_empty() {
            break;
        }
        text.push(' ');
        text.push_str(&fold(line));
        let done = MISDIRECT.iter().any(|m| text.contains(m))
            && RECIPIENT.iter().any(|r| text.contains(r))
            && ACTION.iter().any(|a| text.contains(a));
        let end = line.trim_end();
        if done
            && [".", "!", "merci", "thank you"]
                .iter()
                .any(|e| end.ends_with(e))
        {
            return Some(j + 1);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("document_trim_cases.txt");

    fn case(name: &str) -> (Vec<String>, Vec<String>) {
        for block in CASES.split("\n===\n").skip(1) {
            let (first, body) = block.split_once('\n').unwrap();
            if first.strip_prefix("name: ") != Some(name) {
                continue;
            }
            let body = body.strip_prefix("input:\n").expect("input:");
            let (input, expect) = body.split_once("\nexpect:\n").expect("expect:");
            let pages = |text: &str| text.split("\n<<page>>\n").map(str::to_owned).collect();
            return (pages(input), pages(expect.trim_end_matches('\n')));
        }
        panic!("no case {name}");
    }

    fn check(name: &str) {
        let (input, expect) = case(name);
        let pages: Vec<&str> = input.iter().map(String::as_str).collect();
        let got = trim(&pages);
        assert_eq!(got, expect, "{name}");
        let again: Vec<&str> = got.iter().map(String::as_str).collect();
        assert_eq!(trim(&again), got, "{name}: not stable on a second run");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let me = include_str!("document_trim.rs");
        for name in CASES
            .split("\n===\n")
            .skip(1)
            .filter_map(|b| b.lines().next()?.strip_prefix("name: "))
        {
            assert!(me.contains(&format!("check(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_a_fax_line_whose_sender_is_named_in_the_body_when_trimmed_then_it_goes() {
        check("a_fax_transmission_line_goes_when_its_sender_is_named_in_the_body");
    }

    #[test]
    fn given_a_fax_line_whose_sender_is_named_only_in_the_letterhead_when_trimmed_then_it_stays() {
        check("a_fax_line_stays_when_its_sender_is_named_only_in_the_letterhead");
    }

    #[test]
    fn given_a_fax_line_whose_name_shares_only_a_word_with_another_organization_then_it_stays() {
        check("a_fax_line_stays_when_another_organization_shares_a_word_of_its_name");
    }

    #[test]
    fn given_a_fax_line_that_is_the_sole_mention_of_its_sender_when_trimmed_then_it_stays() {
        check("a_fax_transmission_line_stays_when_it_is_the_only_mention_of_its_sender");
    }

    #[test]
    fn given_a_fax_line_with_digit_swaps_and_no_from_marker_when_trimmed_then_it_goes() {
        check("a_fax_line_without_a_from_marker_and_with_digit_swaps_still_matches");
    }

    #[test]
    fn given_a_polish_fax_line_when_trimmed_then_it_goes() {
        check("a_polish_fax_line_goes");
    }

    #[test]
    fn given_a_fax_line_naming_a_patient_when_trimmed_then_it_stays() {
        check("a_fax_line_naming_a_patient_stays");
    }

    #[test]
    fn given_page_counters_in_several_languages_when_trimmed_then_they_go() {
        check("page_counters_go_in_any_of_the_languages");
    }

    #[test]
    fn given_a_page_counter_inside_a_sentence_when_trimmed_then_it_stays() {
        check("a_page_counter_inside_a_sentence_stays");
    }

    #[test]
    fn given_print_footers_whose_hospital_is_named_in_the_body_when_trimmed_then_they_go() {
        check("a_print_footer_goes_when_its_organization_is_named_in_the_body");
    }

    #[test]
    fn given_a_print_footer_that_is_the_sole_mention_of_its_hospital_when_trimmed_then_it_stays() {
        check("a_print_footer_stays_when_it_is_the_only_mention_of_its_hospital");
    }

    #[test]
    fn given_a_fax_cover_sheet_when_trimmed_then_only_its_nameless_and_dateless_fields_go() {
        check("fax_cover_fields_without_a_name_go_and_fields_with_a_name_or_a_date_stay");
    }

    #[test]
    fn given_a_from_field_naming_a_doctor_when_trimmed_then_it_stays() {
        check("a_from_field_naming_a_doctor_stays");
    }

    #[test]
    fn given_confidentiality_notices_when_trimmed_then_their_paragraphs_go() {
        check("a_confidentiality_notice_goes_whole_in_english_and_french");
    }

    #[test]
    fn given_a_sentence_about_confidentiality_when_trimmed_then_it_stays() {
        check("a_sentence_about_confidentiality_without_a_misdirected_fax_stays");
    }

    #[test]
    fn given_dictation_stamps_when_trimmed_then_they_go_and_the_signature_stays() {
        check("dictation_stamps_go");
    }

    #[test]
    fn given_report_markers_when_trimmed_then_they_go() {
        check("report_markers_go");
    }

    #[test]
    fn given_a_clean_letter_when_trimmed_then_it_is_unchanged() {
        check("a_clean_letter_is_left_exactly_as_it_is");
    }

    #[test]
    fn given_fax_headers_in_other_machine_styles_when_trimmed_then_they_go() {
        check("v2_fax_headers_in_other_machine_styles_go");
    }

    #[test]
    fn given_print_footers_and_page_lines_when_trimmed_then_they_go() {
        check("v2_print_footers_and_page_lines_go");
    }

    #[test]
    fn given_a_bare_print_date_when_trimmed_then_it_stays() {
        check("v2_a_bare_print_date_stays");
    }

    #[test]
    fn given_stamps_markers_and_cover_fields_when_trimmed_then_they_go() {
        check("v2_stamps_markers_and_cover_fields_go");
    }

    #[test]
    fn given_a_warning_notice_when_trimmed_then_it_goes_whole() {
        check("v2_a_warning_notice_goes_whole");
    }

    #[test]
    fn given_clinical_lines_that_look_like_noise_when_trimmed_then_they_stay() {
        check("v2_clinical_lines_that_look_like_noise_stay");
    }

    #[test]
    fn given_a_fax_header_with_the_patients_name_when_trimmed_then_it_stays() {
        check("v2_a_fax_header_with_the_patients_name_stays");
    }

    #[test]
    fn given_no_pages_or_an_empty_page_when_trimmed_then_the_pages_are_kept() {
        assert!(trim(&[]).is_empty());
        assert_eq!(trim(&[""]), vec![String::new()]);
        assert_eq!(trim(&["a", "", "b"]), vec!["a", "", "b"]);
    }

    /// The evaluation's clean letters (the 30 in the repository's harness, which hold the hard 10)
    /// come out byte for byte the same, so every frozen fact and anchor in them is still there.
    /// Compiled by cargo only: it reads the harness with serde_json (the standalone `rustc --test`
    /// run has no features, so it leaves this module out).
    #[cfg(feature = "default")]
    mod harness_letters {
        use super::super::trim;
        use std::path::Path;

        fn pages(document: &serde_json::Value) -> Vec<String> {
            document["pages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|page| page["text"].as_str().unwrap().to_owned())
                .collect()
        }

        fn letters() -> Vec<(String, Vec<String>, serde_json::Value)> {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/summary-evaluation");
            let mut out = Vec::new();
            let mut paths: Vec<_> = std::fs::read_dir(root.join("harness/documents"))
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.extension().is_some_and(|e| e == "json"))
                .collect();
            paths.sort();
            for path in paths {
                let document: serde_json::Value =
                    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                out.push((
                    document["id"].as_str().unwrap().to_owned(),
                    pages(&document),
                    document["facts"].clone(),
                ));
            }
            let fixtures: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(root.join("fixtures.json")).unwrap())
                    .unwrap();
            for case in fixtures["cases"].as_array().unwrap() {
                out.push((
                    case["case_id"].as_str().unwrap().to_owned(),
                    pages(case),
                    case["facts"].clone(),
                ));
            }
            out
        }

        #[test]
        fn given_the_thirty_clean_harness_letters_when_trimmed_then_each_is_unchanged_and_keeps_its_facts(
        ) {
            let letters = letters();
            assert_eq!(letters.len(), 30);
            for (id, pages, facts) in letters {
                let input: Vec<&str> = pages.iter().map(String::as_str).collect();
                let got = trim(&input);
                assert_eq!(got, pages, "{id}: a clean letter changed");
                let joined = got.join("\n\n");
                let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
                for fact in facts.as_array().unwrap() {
                    if let Some(evidence) = fact["source_evidence"].as_str() {
                        if collapse(&pages.join("\n\n")).contains(&collapse(evidence)) {
                            assert!(
                                collapse(&joined).contains(&collapse(evidence)),
                                "{id}: {evidence}"
                            );
                        }
                    }
                    for anchor in fact["anchors"].as_array().into_iter().flatten() {
                        let anchor = anchor.as_str().unwrap().to_lowercase();
                        if pages.join("\n\n").to_lowercase().contains(&anchor) {
                            assert!(
                                joined.to_lowercase().contains(&anchor),
                                "{id}: anchor {anchor}"
                            );
                        }
                    }
                }
            }
        }
    }
}
