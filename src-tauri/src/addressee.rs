//! K17 (evaluation only): a summary sentence that words a line a letter writes to another doctor
//! as the patient's own is rewritten so it says who the line is for. Ben (12 Nov): "if the
//! patient has the file it was meant to be shared with them; just make sure the wording doesn't
//! imply they should call if meant for the doctor."
//!
//! Two rewrites, both only in a letter written to a doctor (it has a doctor's greeting: "Dear
//! Dr. …", "Dear colleague,", "Chère collègue,", …) and only for a quote found after that
//! greeting:
//! - **The writer's own line.** The quote's sentence in the letter offers the writer's phone
//!   ("please call me …", "me joindre …") and the summary sentence gives that number as one for
//!   the patient to call: it becomes "The letter gives the writing doctor's phone line for the
//!   receiving doctor." ("Dr. <name>'s phone line" when the sentence names the doctor who signed
//!   the letter). The number is left out: **Ben's decision (12 Nov) overrides the rule below for
//!   this one case only**, the writer's own line rewritten as a clinician's line, so the
//!   sentence can never read as a number for the patient to call.
//! - **The letter's "you".** The quote's sentence speaks to the doctor it is written to ("would
//!   you …", "pourriez-vous …") and the summary sentence keeps that "you" as the one asked ("asks
//!   if you would …", "asks you to …"): only that "you" becomes "the receiving doctor".
//!
//! Never (but for the writer's own phone line above): a sentence dropped, a number, dose, phone
//! number or medicine name changed or left out, a sentence with an emergency number or word
//! touched, or any other sentence changed. A writer's-line sentence with any other number in it
//! (a dose, a date) is left as it is, so only the writer's phone number is ever left out. A summary
//! in another language than English is left as it is (the wording is English).
//!
//! Pure std, so its tests run on their own: `rustc --edition 2021 --test src/addressee.rs`.
//! The cases are shared with the evaluation's Python port (`addressee_cases.txt`).

/// The post-step's name in a measurement (read by the evaluation measurement only).
#[allow(dead_code)]
pub(crate) const NAME: &str = "addressee-1";

/// Which rewrite was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    /// The writer's phone line, given as the patient's to call.
    WriterContact,
    /// The letter's "you" (the doctor it is written to) kept as the one asked.
    AddresseeYou,
}

impl Kind {
    /// The kind's name in a measurement (read by the evaluation measurement only).
    #[allow(dead_code)]
    pub(crate) fn name(self) -> &'static str {
        match self {
            Kind::WriterContact => "writer-contact",
            Kind::AddresseeYou => "addressee-you",
        }
    }
}

/// One rewritten sentence, for measuring: never shown, and never logged with its words.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rewrite {
    pub(crate) index: usize,
    pub(crate) kind: Kind,
    pub(crate) before: String,
    pub(crate) after: String,
}

/// The rewrite of one English summary sentence whose quote was found in `pages` (the pages read,
/// joined), or `None` when it stays as it is.
pub(crate) fn rewrite(pages: &str, sentence: &str, quote: &str) -> Option<(Kind, String)> {
    if quote.trim().is_empty() || has_emergency(sentence) {
        return None;
    }
    let body = body_start(pages)?;
    let (start, end) = find_folded(pages, quote)?;
    if start < body {
        return None;
    }
    let source = source_sentence(pages, start, end);
    if let Some(after) = contact_rewrite(pages, source, sentence) {
        return Some((Kind::WriterContact, after));
    }
    you_rewrite(source, sentence).map(|after| (Kind::AddresseeYou, after))
}

// --- The letter --------------------------------------------------------------------------------

const GREETINGS: &[&str] = &[
    "dear", "hello", "hi", "cher", "chère", "chers", "chères", "prezado", "prezada", "prezados",
    "prezadas", "caro", "cara", "estimado", "estimada", "querido", "querida", "szanowny",
    "szanowna", "szanowni",
];
const TITLES: &[&str] = &[
    "dr",
    "dre",
    "dra",
    "doctor",
    "doctors",
    "docteur",
    "docteure",
    "doutor",
    "doutora",
    "doctora",
    "doktor",
    "doktorze",
    "colleague",
    "colleagues",
    "collègue",
    "collègues",
    "confrère",
    "consœur",
    "consoeur",
    "colega",
    "colegas",
];
const BARE_TITLES: &[&str] = &["dr", "dre", "dra", "docteur", "docteure", "doctor"];

/// Where the body of a letter written to a doctor starts: just after its greeting line.
fn body_start(pages: &str) -> Option<usize> {
    let mut at = 0;
    for line in pages.split_inclusive('\n') {
        if is_doctor_greeting(line) {
            return Some(at + line.len());
        }
        at += line.len();
    }
    None
}

/// "Dear Dr. Marlow,", "Dear colleague,", "Chère collègue,", "Prezada Dra. Lima,", or a bare
/// "Docteure Lima," (with its comma: an address line has none).
fn is_doctor_greeting(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() || line.chars().count() > 80 {
        return false;
    }
    let lower = line.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || c == ',' || c == ':')
        .filter(|w| !w.is_empty())
        .map(|w| w.trim_end_matches('.'))
        .collect();
    let Some(first) = words.first() else {
        return false;
    };
    if GREETINGS.contains(first) {
        return words.iter().skip(1).take(3).any(|w| TITLES.contains(w));
    }
    BARE_TITLES.contains(first) && line.ends_with(',')
}

/// The byte range of `quote` in `pages`, matched as the runner matches quotes (`quote_in`):
/// whitespace runs as one, case ignored, quote marks and `.,;:` trimmed at the quote's ends.
pub(crate) fn find_folded(pages: &str, quote: &str) -> Option<(usize, usize)> {
    const QUOTE_ENDS: &[char] = &[
        '"', '\'', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '.', ',', ';', ':',
    ];
    let wanted = quote
        .trim_matches(|c: char| c.is_whitespace() || QUOTE_ENDS.contains(&c))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let mut folded = String::new();
    let mut from: Vec<(usize, usize)> = Vec::new(); // per folded byte: (start, end) in `pages`
    let mut in_space = false;
    for (at, c) in pages.char_indices() {
        if c.is_whitespace() {
            if !in_space && !folded.is_empty() {
                folded.push(' ');
                from.push((at, at + c.len_utf8()));
            }
            in_space = true;
            continue;
        }
        in_space = false;
        for lower in c.to_lowercase() {
            for _ in 0..lower.len_utf8() {
                from.push((at, at + c.len_utf8()));
            }
            folded.push(lower);
        }
    }
    let found = folded.find(&wanted)?;
    let last = found + wanted.len() - 1;
    Some((from[found].0, from[last].1))
}

const ABBREVIATIONS: &[&str] = &[
    "dr", "dre", "dra", "mr", "mrs", "ms", "mme", "mlle", "st", "no", "vs", "ext", "tel", "tél",
    "p", "e.g", "i.e", "sr", "sra",
];

/// Whether the `.`, `!` or `?` at `at` ends a sentence: whitespace (or the end) follows, and it
/// is not an abbreviation's dot.
pub(crate) fn ends_sentence(pages: &str, at: usize) -> bool {
    let c = pages[at..].chars().next();
    if !matches!(c, Some('.' | '!' | '?')) {
        return false;
    }
    let after = pages[at + 1..].chars().next();
    if !after.is_none_or(char::is_whitespace) {
        return false;
    }
    if c == Some('.') {
        let word: String = pages[..at]
            .chars()
            .rev()
            .take_while(|c| c.is_alphabetic() || *c == '.')
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        if ABBREVIATIONS.contains(&word.to_lowercase().as_str()) {
            return false;
        }
    }
    true
}

/// Whether a line of running text goes on to the next line: long, and not ended by a sentence
/// end or a colon (a letterhead, an address or a heading line does not).
pub(crate) fn wraps(line: &str) -> bool {
    let line = line.trim_end();
    line.chars().count() >= 50 && !line.ends_with(['.', '!', '?', ':'])
}

/// The letter's sentence around a quote at `start..end`: back to the last sentence end, blank
/// line or line that does not wrap; on to the next sentence end or line that does not wrap.
pub(crate) fn source_sentence(pages: &str, start: usize, end: usize) -> &str {
    let mut from = 0;
    for (at, c) in pages[..start].char_indices().rev() {
        if matches!(c, '.' | '!' | '?') && ends_sentence(pages, at) {
            from = at + 1;
            break;
        }
        if c == '\n' {
            let line_start = pages[..at].rfind('\n').map_or(0, |i| i + 1);
            if !wraps(&pages[line_start..at]) {
                from = at + 1;
                break;
            }
        }
    }
    let mut to = pages.len();
    for (offset, c) in pages[end..].char_indices() {
        let at = end + offset;
        if matches!(c, '.' | '!' | '?') && ends_sentence(pages, at) {
            to = at + 1;
            break;
        }
        if c == '\n' {
            let line_start = pages[..at].rfind('\n').map_or(0, |i| i + 1);
            if !wraps(&pages[line_start..at]) {
                to = at;
                break;
            }
        }
    }
    pages[from..to].trim()
}

// --- The summary sentence ------------------------------------------------------------------------

/// Words of a text in lower case, split at anything that is not a letter, digit or apostrophe.
fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace('\u{2019}', "'")
        .split(|c: char| !(c.is_alphanumeric() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A sentence with an emergency number or word is never touched.
fn has_emergency(sentence: &str) -> bool {
    words(sentence).iter().any(|w| {
        [
            "911",
            "112",
            "999",
            "811",
            "emergency",
            "urgence",
            "urgences",
            "ambulance",
        ]
        .contains(&w.as_str())
    })
}

/// Phone-shaped numbers in a text, as written: (start, end of the number, end with its
/// extension). 7 to 15 digits in groups: digits and brackets, a leading +, and between groups at
/// most 3 of space, dot or dash (never two spaces: a table gap is no separator). An extension
/// counts when one follows ("ext. 21", "x 4", "poste 21"). Dates are not phone-shaped.
fn phones(text: &str) -> Vec<(usize, usize, usize)> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let mut found = Vec::new();
    let mut i = 0;
    while i < n {
        let c = chars[i].1;
        let starts = c.is_ascii_digit()
            || (matches!(c, '+' | '(') && i + 1 < n && chars[i + 1].1.is_ascii_digit());
        let joined = i > 0
            && (chars[i - 1].1.is_alphanumeric()
                || matches!(chars[i - 1].1, '/' | ':' | '.' | ','));
        if !starts || joined {
            i += 1;
            continue;
        }
        let mut j = i;
        let mut last_digit = i;
        while j < n {
            let c = chars[j].1;
            if c.is_ascii_digit() {
                last_digit = j;
                j += 1;
                continue;
            }
            if c == '(' || c == ')' || (c == '+' && j == i) {
                j += 1;
                continue;
            }
            let mut k = j;
            while k < n && k - j < 3 && matches!(chars[k].1, ' ' | '-' | '.') {
                k += 1;
            }
            let run: String = chars[j..k].iter().map(|x| x.1).collect();
            if k > j
                && !run.contains("  ")
                && k < n
                && (chars[k].1.is_ascii_digit() || chars[k].1 == '(')
            {
                j = k;
                continue;
            }
            break;
        }
        let start = chars[i].0;
        let mut main_end = chars.get(last_digit + 1).map_or(text.len(), |x| x.0);
        let opened = text[start..main_end].matches('(').count();
        if opened > text[start..main_end].matches(')').count() && text[main_end..].starts_with(')')
        {
            main_end += 1;
        }
        let body = &text[start..main_end];
        let digits = body.chars().filter(char::is_ascii_digit).count();
        let next_joins = text[main_end..]
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '/');
        if (7..=15).contains(&digits) && !is_date(body) && !next_joins {
            let end = main_end + extension(&text[main_end..]);
            found.push((start, main_end, end));
            i = chars.iter().position(|(o, _)| *o >= end).unwrap_or(n);
        } else {
            i = last_digit.max(i) + 1;
        }
    }
    found
}

/// The length of an extension right after a number (", ext. 21", " x 4", " poste 21"), or 0.
fn extension(rest: &str) -> usize {
    let trimmed = rest.trim_start_matches([' ', ',']);
    let skipped = rest.len() - trimmed.len();
    let lower = trimmed.to_lowercase();
    for mark in ["ext.", "ext", "poste", "x"] {
        if let Some(after) = lower.strip_prefix(mark) {
            let spaces = after.len() - after.trim_start().len();
            let digits = after[spaces..]
                .chars()
                .take_while(char::is_ascii_digit)
                .count();
            let next = after[spaces + digits..].chars().next();
            if (1..=5).contains(&digits) && !next.is_some_and(char::is_alphanumeric) {
                return skipped + mark.len() + spaces + digits;
            }
        }
    }
    0
}

/// "2026-10-05", "05.10.2026", "2026 10 05": a date, not a phone.
fn is_date(body: &str) -> bool {
    let groups: Vec<&str> = body
        .split(|c: char| !c.is_ascii_digit())
        .filter(|g| !g.is_empty())
        .collect();
    let year = |g: &str| g.len() == 4 && (g.starts_with("19") || g.starts_with("20"));
    groups.len() == 3
        && ((year(groups[0]) && groups[1].len() <= 2 && groups[2].len() <= 2)
            || (groups[0].len() <= 2 && groups[1].len() <= 2 && year(groups[2])))
}

fn digits_of(text: &str) -> String {
    text.chars().filter(char::is_ascii_digit).collect()
}

/// The writer offering their own line: "call me", "me joindre", "my direct line", …
pub(crate) const CONTACT_OFFERS: &[&str] = &[
    "call me",
    "phone me",
    "contact me",
    "reach me",
    "page me",
    "text me",
    "email me",
    "e-mail me",
    "ring me",
    "my direct line",
    "my line",
    "my office",
    "my cell",
    "my number",
    "my pager",
    "m'appeler",
    "me joindre",
    "me contacter",
    "me téléphoner",
    "communiquer avec moi",
    "ma ligne",
    "mon numéro",
    "mon poste",
    "me ligar",
    "ligar para mim",
    "me contatar",
    "entrar em contato comigo",
    "meu telefone",
    "meu número",
    "llamarme",
    "contactarme",
    "comunicarse conmigo",
    "mi teléfono",
    "mi número",
];

/// The summary gives the number as one for the patient to call: "you", "your", "me", "my" or
/// "I", or it starts with "Call" or "Please", or the patient must or may call.
fn worded_as_patients_call(sentence: &str) -> bool {
    let w = words(sentence);
    if w.iter()
        .any(|x| ["you", "your", "me", "my", "i"].contains(&x.as_str()))
    {
        return true;
    }
    if w.first()
        .is_some_and(|x| ["call", "please", "phone", "contact", "ring"].contains(&x.as_str()))
    {
        return true;
    }
    w.windows(3).any(|t| {
        ["patient", "he", "she", "they"].contains(&t[0].as_str())
            && ["must", "should", "can", "may", "needs", "need", "is"].contains(&t[1].as_str())
            && ["call", "phone", "contact", "ring", "reach", "to"].contains(&t[2].as_str())
    })
}

const CLOSINGS: &[&str] = &[
    "sincerely",
    "yours sincerely",
    "sincerely yours",
    "yours",
    "yours truly",
    "yours faithfully",
    "regards",
    "best regards",
    "kind regards",
    "warm regards",
    "best wishes",
    "with thanks",
    "many thanks",
    "cordialement",
    "bien cordialement",
    "bien à vous",
    "salutations distinguées",
    "atenciosamente",
    "cordialmente",
    "saludos",
    "saludos cordiales",
    "z poważaniem",
];
const SIGNER_TITLES: &[&str] = &[
    "Dr.", "Dre.", "Dra.", "Dr", "Dre", "Dra", "Docteure", "Docteur", "Doctor",
];

/// The name the letter is signed with, as written: the first line with words after a closing
/// ("Sincerely,"), without its title and anything after a comma or bracket ("Dr. Iris Oakfield,
/// MD" → "Iris Oakfield").
fn signer(pages: &str) -> Option<String> {
    let lines: Vec<&str> = pages.lines().collect();
    for (at, line) in lines.iter().enumerate() {
        let closing = line.trim().trim_end_matches([',', '.']).to_lowercase();
        if !CLOSINGS.contains(&closing.as_str()) {
            continue;
        }
        let Some(next) = lines[at + 1..]
            .iter()
            .take(3)
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
        else {
            continue;
        };
        let mut name = next;
        for title in SIGNER_TITLES {
            if let Some(rest) = name.strip_prefix(title) {
                if rest.starts_with(' ') {
                    name = rest.trim_start();
                    break;
                }
            }
        }
        let name = name.split([',', '(']).next().unwrap_or("").trim();
        if name.chars().any(char::is_alphabetic) {
            return Some(name.to_owned());
        }
    }
    None
}

fn contact_rewrite(pages: &str, source: &str, sentence: &str) -> Option<String> {
    let lower = format!(" {}", source.to_lowercase().replace('\u{2019}', "'"));
    let offers = CONTACT_OFFERS.iter().any(|offer| {
        lower.match_indices(offer).any(|(at, _)| {
            !lower[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_alphanumeric)
                && !lower[at + offer.len()..]
                    .chars()
                    .next()
                    .is_some_and(char::is_alphanumeric)
        })
    });
    if !offers {
        return None;
    }
    let spans = phones(sentence);
    let source_digits = digits_of(source);
    // Each number is the writer's: its last 7 digits are in the letter's sentence.
    let from_source = |&(a, m, _): &(usize, usize, usize)| {
        let main = digits_of(&sentence[a..m]);
        source_digits.contains(&main[main.len().saturating_sub(7)..])
    };
    if spans.is_empty() || !spans.iter().all(from_source) || !worded_as_patients_call(sentence) {
        return None;
    }
    // Every number of the sentence must be in one of its phone numbers: only the writer's phone
    // number is left out (Ben, 12 Nov), never anything else.
    let mut outside = sentence.to_owned();
    for &(a, _, b) in spans.iter().rev() {
        outside.replace_range(a..b, " ");
    }
    if outside.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    // The writer by name only when the sentence names the doctor who signed the letter (a
    // summary often names the other doctor instead).
    let sentence_words = words(sentence);
    let named = signer(pages).filter(|name| {
        let surname = name.split_whitespace().last().unwrap_or("");
        let surname_words = words(surname);
        !surname_words.is_empty() && surname_words.iter().all(|w| sentence_words.contains(w))
    });
    Some(match named {
        Some(name) => format!("The letter gives Dr. {name}'s phone line for the receiving doctor."),
        None => {
            "The letter gives the writing doctor's phone line for the receiving doctor.".to_owned()
        }
    })
}

/// The letter speaking to the doctor it is written to.
const SECOND_PERSON: &[&str] = &[
    "you", "your", "yours", "yourself", "vous", "votre", "vos", "você", "vocês", "senhor",
    "senhora", "usted", "ustedes",
];
const ASKING: &[&str] = &[
    "ask",
    "asks",
    "asked",
    "asking",
    "want",
    "wants",
    "wanted",
    "invite",
    "invites",
    "invited",
    "request",
    "requests",
    "requested",
    "wonders",
    "wondered",
];

/// Words between "you" and what it is asked to do.
const LINKING: &[&str] = &[
    "would", "could", "can", "should", "will", "might", "to", "please", "kindly", "also",
];

/// The summary's "you" as the one asked: "asks you …", "asks if you …", "wants to know whether
/// you …", "would like you …", when it is the letter's doctor. Only those words change, to "the
/// receiving doctor".
fn you_rewrite(source: &str, sentence: &str) -> Option<String> {
    // The "you" is the letter's doctor when the letter's sentence speaks to its reader, or when
    // the summary sentence names the patient apart ("asks you to see the patient").
    let speaks_to_reader = words(source)
        .iter()
        .any(|w| SECOND_PERSON.contains(&w.as_str()));
    let w = words(sentence);
    let names_patient = w.windows(2).any(|p| p[0] == "the" && p[1] == "patient")
        || w.iter().any(|x| x == "him" || x == "them");
    // A sentence that says "your" speaks to the patient: its "you" is the patient.
    if (!speaks_to_reader && !names_patient) || w.iter().any(|x| x == "your" || x == "yours") {
        return None;
    }
    // In an English letter the one asked does what the letter asks: the word after the summary's
    // "you" ("would you recommend" → "you would recommend") is in the letter's sentence.
    let source_words = words(source);
    let english_you = source_words.iter().any(|x| x == "you");
    // Word spans of the sentence, as written.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut start = None;
    for (at, c) in sentence.char_indices() {
        let in_word = c.is_alphanumeric() || c == '\'' || c == '\u{2019}';
        match (in_word, start) {
            (true, None) => start = Some(at),
            (false, Some(s)) => {
                spans.push((s, at));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        spans.push((s, sentence.len()));
    }
    let lower: Vec<String> = spans
        .iter()
        .map(|&(a, b)| sentence[a..b].to_lowercase())
        .collect();
    let asked = |i: usize| -> bool {
        let at = |k: usize| i.checked_sub(k).map(|j| lower[j].as_str());
        let verb = |w: Option<&str>| w.is_some_and(|w| ASKING.contains(&w));
        verb(at(1))
            || (matches!(at(1), Some("if" | "whether"))
                && (verb(at(2)) || (at(2) == Some("know") && at(3) == Some("to"))))
            || (at(1) == Some("like") && at(2) == Some("would"))
    };
    let does_what_the_letter_asks = |i: usize| -> bool {
        if !english_you {
            return true;
        }
        lower[i + 1..]
            .iter()
            .find(|x| !LINKING.contains(&x.as_str()))
            .is_some_and(|x| source_words.contains(x))
    };
    let mut after = sentence.to_owned();
    let mut changed = false;
    for i in (0..spans.len()).rev() {
        if lower[i] == "you" && asked(i) && does_what_the_letter_asks(i) {
            after.replace_range(spans[i].0..spans[i].1, "the receiving doctor");
            changed = true;
        }
    }
    changed.then_some(after)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shared cases (also run by the evaluation's Python port).
    const CASES: &str = include_str!("addressee_cases.txt");

    struct Case {
        letter: String,
        sentence: String,
        quote: String,
        expect: Option<String>,
        kind: Option<&'static str>,
    }

    fn case(name: &str) -> Case {
        for block in CASES.split("\n===\n").skip(1) {
            let field = |key: &str| {
                block
                    .lines()
                    .find_map(|line| line.strip_prefix(&format!("{key}: ")))
                    .unwrap_or_else(|| panic!("{name}: no {key}"))
                    .to_owned()
            };
            if field("name") != name {
                continue;
            }
            let letter = block
                .split_once("letter:\n")
                .and_then(|(_, rest)| rest.split_once("\nsentence: "))
                .map(|(letter, _)| letter.to_owned())
                .unwrap_or_else(|| panic!("{name}: no letter"));
            let expect = field("expect");
            let kind = match field("kind").as_str() {
                "writer-contact" => Some("writer-contact"),
                "addressee-you" => Some("addressee-you"),
                _ => None,
            };
            return Case {
                letter,
                sentence: field("sentence"),
                quote: field("quote"),
                expect: (expect != "(none)").then_some(expect),
                kind,
            };
        }
        panic!("no case {name}");
    }

    fn check(name: &str) {
        let c = case(name);
        let got = rewrite(&c.letter, &c.sentence, &c.quote);
        assert_eq!(
            got.as_ref().map(|(_, after)| after.clone()),
            c.expect,
            "{name}"
        );
        assert_eq!(got.map(|(kind, _)| kind.name()), c.kind, "{name}");
    }

    #[test]
    fn every_shared_case_has_a_test_below() {
        let names: Vec<&str> = CASES
            .split("\n===\n")
            .skip(1)
            .filter_map(|b| b.lines().find_map(|l| l.strip_prefix("name: ")))
            .collect();
        let me = include_str!("addressee.rs");
        for name in names {
            assert!(me.contains(&format!("check(\"{name}\")")), "{name}");
        }
    }

    #[test]
    fn given_a_letter_to_a_doctor_when_the_summary_copies_the_writers_call_me_line_then_it_says_the_letter_gives_the_writing_doctors_line_for_the_receiving_doctor(
    ) {
        check("a_copied_call_me_line");
    }

    #[test]
    fn given_a_letter_to_a_doctor_when_the_summary_makes_the_writers_line_a_patient_task_then_it_says_the_letter_gives_the_writing_doctors_line_for_the_receiving_doctor(
    ) {
        check("the_writers_line_as_a_patient_task");
    }

    #[test]
    fn given_a_summary_that_names_the_doctor_who_signed_the_letter_when_it_gives_her_line_to_call_then_it_says_the_letter_gives_dr_names_line_for_the_receiving_doctor(
    ) {
        check("the_writer_named_in_the_sentence");
    }

    #[test]
    fn given_the_writers_line_already_said_as_hers_when_post_processed_then_the_sentence_is_unchanged(
    ) {
        check("the_writers_line_said_as_hers");
    }

    #[test]
    fn given_a_question_the_letter_asks_its_doctor_when_the_summary_keeps_its_you_then_only_that_you_becomes_the_receiving_doctor(
    ) {
        check("a_question_to_the_doctor_with_its_you_kept");
    }

    #[test]
    fn given_a_request_the_letter_makes_of_its_doctor_when_the_summary_asks_you_then_only_that_you_becomes_the_receiving_doctor(
    ) {
        check("a_request_to_the_doctor_with_its_you_kept");
    }

    #[test]
    fn given_a_request_with_no_you_in_the_letter_when_the_summary_asks_you_to_see_the_patient_then_only_that_you_becomes_the_receiving_doctor(
    ) {
        check("a_request_naming_the_patient_with_no_you_in_the_letter");
    }

    #[test]
    fn given_a_question_to_the_doctor_when_the_summary_says_your_doctor_wants_to_know_if_you_need_it_then_the_patients_you_is_unchanged(
    ) {
        check("your_doctor_asks_about_the_patient");
    }

    #[test]
    fn given_a_question_to_the_doctor_when_the_summary_asks_if_you_need_it_then_the_patients_you_is_unchanged(
    ) {
        check("the_doctor_asks_if_you_need_it");
    }

    #[test]
    fn given_a_question_about_the_patient_with_no_you_in_the_letter_when_the_summary_says_you_then_the_sentence_is_unchanged(
    ) {
        check("a_question_about_the_patient_with_no_you_in_the_letter");
    }

    #[test]
    fn given_a_letter_written_to_the_patient_when_the_summary_gives_a_number_to_call_then_the_sentence_is_unchanged(
    ) {
        check("a_letter_written_to_the_patient");
    }

    #[test]
    fn given_an_emergency_rule_in_a_letter_to_a_doctor_when_post_processed_then_the_sentence_is_unchanged(
    ) {
        check("an_emergency_rule_in_a_letter_to_a_doctor");
    }

    #[test]
    fn given_a_contact_line_with_a_dose_in_the_sentence_when_post_processed_then_nothing_is_dropped_and_the_sentence_is_unchanged(
    ) {
        check("a_contact_line_with_another_number_in_the_sentence");
    }

    #[test]
    fn given_a_french_letter_to_a_colleague_when_the_summary_keeps_its_vous_as_you_then_only_that_you_becomes_the_receiving_doctor(
    ) {
        check("a_french_letter_to_a_colleague");
    }

    #[test]
    fn given_an_address_line_with_a_doctors_title_and_no_greeting_when_post_processed_then_the_sentence_is_unchanged(
    ) {
        check("an_address_line_is_not_a_greeting");
    }

    #[test]
    fn given_a_quote_from_the_letterhead_above_the_greeting_when_post_processed_then_the_sentence_is_unchanged(
    ) {
        check("a_quote_above_the_greeting");
    }

    #[test]
    fn given_a_quote_that_is_not_in_the_letter_when_post_processed_then_the_sentence_is_unchanged()
    {
        check("a_quote_not_in_the_letter");
    }

    #[test]
    fn given_a_relatives_number_with_no_contact_offer_when_post_processed_then_the_sentence_is_unchanged(
    ) {
        check("the_doctors_number_with_no_contact_offer");
    }

    #[test]
    fn given_numbers_and_dates_when_phones_are_found_then_only_phone_shaped_numbers_with_their_extension_count(
    ) {
        let text =
            "Call 555-0137 ext. 4 or (613) 555-0142; seen 2026-10-05; dose 20 mg; 1-800-555-0100.";
        let found: Vec<&str> = phones(text).iter().map(|&(a, _, b)| &text[a..b]).collect();
        assert_eq!(
            found,
            ["555-0137 ext. 4", "(613) 555-0142", "1-800-555-0100"]
        );
    }
}
