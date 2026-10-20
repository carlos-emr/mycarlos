/**
 * The name remover (#72): takes identifying details out of a document's text
 * on this device, before any of it could be sent to a cloud model. Nothing
 * here touches the network; it is plain text in, plain text out.
 *
 * It removes names (the patient's profile names; names after a title or a
 * label such as "Patient:", in any case and surname first too, "OKAFOR,
 * MARGARET A."; clinicians with initials, in a "signed by" line, before
 * credentials such as "MD", or after a title such as "Nurse Practitioner"),
 * health card and record numbers, dates of birth, addresses, postal codes,
 * phone numbers, email addresses, and clinic and doctor names, in English and
 * French. Every other date is shifted by the same number of days, so the gaps
 * between them stay. Each removed detail becomes a placeholder, such as
 * "[NAME 1]", the same one each time the same detail appears.
 *
 * It is rules, not understanding: a rare condition, an unusual job or a small
 * town in free text can still point to a person, and a name that never has a
 * title or a label, and is not a profile name, is not found. One found once is
 * removed everywhere else: whole in any case, a single word only written as a
 * name. A single word in lower case ("the ward", with a Dr. Ward) is left in
 * and flagged as a possible name for the preview. A word of a name that is
 * also an ordinary word ("Major", "Iris", "Rose") is removed only as part of
 * the whole name. A date with a two-digit year ("1/2/24") is read as one only
 * after a date label. The patient's preview, where more can be removed by
 * hand (`removeMore`), is the last check.
 */

export type RemovedKind =
  | "name"
  | "doctor"
  | "clinic"
  | "healthCard"
  | "recordNumber"
  | "dateOfBirth"
  | "address"
  | "postalCode"
  | "phone"
  | "email"
  | "manual";

/** One detail taken out, or one date shifted. */
export interface Removed {
  kind: RemovedKind | "date";
  /** The text as it was in the document. */
  original: string;
  /** What stands in its place: a placeholder, or the shifted date. */
  replacement: string;
  /** Where it was in the document. */
  start: number;
  end: number;
  /** Where its replacement is in the text to send. */
  sentStart: number;
  sentEnd: number;
}

/** A word left in the text that may be a name: a name found elsewhere,
 * written here in lower case ("the ward", with a Dr. Ward). The preview
 * shows it, and one tap removes it (`removeMore`). */
export interface PossibleName {
  original: string;
  start: number;
  end: number;
  /** Where it is in the text to send. */
  sentStart: number;
  sentEnd: number;
}

/** What stays on the device: everything needed to show the preview, remove
 * more and put the details back. Never sent. */
export interface OnDevice {
  /** Everything taken out or shifted, in the order it appears. */
  removed: Removed[];
  /** Words left in that may be names, in the order they appear. */
  possibleNames: PossibleName[];
  /** How many days every date was moved. */
  dateShiftDays: number;
  /** The document as it was. */
  source: string;
}

export interface Deidentified {
  /** The text that may be sent, with placeholders and shifted dates. */
  readonly toSend: string;
  /** Kept on the device. Not enumerable: serializing the result, by mistake,
   * gives only `toSend`. */
  readonly onDevice: OnDevice;
}

export interface DeidentifyOptions {
  /** Names known to be the patient's or a family member's: every profile
   * name. The whole name is removed wherever it stands, and each word of
   * three or more letters wherever it stands alone, written as a name
   * (capitalized, or in capitals), unless it is also an ordinary word. */
  knownNames: string[];
  /** Days to move every other date by. Chosen at random (30 to 365 days,
   * earlier or later) when not given; tests give one. */
  dateShiftDays?: number;
  /** How to read a date such as 03/04/2026 when either part could be the
   * month: day first (Canadian and most of the world) unless told. */
  dayFirst?: boolean;
}

const LABELS: Record<Exclude<RemovedKind, "manual">, string> = {
  name: "NAME",
  doctor: "DOCTOR",
  clinic: "CLINIC",
  healthCard: "HEALTH CARD",
  recordNumber: "RECORD NUMBER",
  dateOfBirth: "DATE OF BIRTH",
  address: "ADDRESS",
  postalCode: "POSTAL CODE",
  phone: "PHONE",
  email: "EMAIL",
};

/** Lower wins when two findings overlap; then the longer. */
const PRIORITY: Record<RemovedKind | "date" | "possibleName", number> = {
  manual: 0,
  email: 1,
  healthCard: 2,
  recordNumber: 3,
  dateOfBirth: 4,
  phone: 5,
  postalCode: 6,
  address: 7,
  doctor: 8,
  clinic: 8,
  name: 9,
  date: 10,
  possibleName: 11,
};

interface Finding {
  /** "possibleName": left in the text, and flagged for the preview. */
  kind: RemovedKind | "date" | "possibleName";
  start: number;
  end: number;
  /** For names: the person they belong to, so that every part of one
   * person's name shares a placeholder. */
  person?: string;
  /** For a name a rule found, and every other place it stands: what makes
   * them one placeholder. */
  group?: string;
  /** For those other places: the whole name they came from. */
  whole?: string;
  /** Found as another place a name stands: loses to anything a rule found
   * there. */
  swept?: true;
  /** Already decided (when more is removed later): kept as it was. */
  replacement?: string;
}

// ---------------------------------------------------------------- dates

interface MonthWord {
  month: number;
  language: "en" | "fr";
  full: boolean;
}
const MONTH_WORDS = new Map<string, MonthWord>();
const ENGLISH = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const FRENCH = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
];
const FRENCH_SHORT = [
  "janv.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];
ENGLISH.forEach((word, index) => {
  MONTH_WORDS.set(word, { month: index + 1, language: "en", full: true });
  if (word.length > 3)
    MONTH_WORDS.set(word.slice(0, 3), {
      month: index + 1,
      language: "en",
      full: false,
    });
});
MONTH_WORDS.set("sept", { month: 9, language: "en", full: false });
FRENCH.forEach((word, index) =>
  MONTH_WORDS.set(word, { month: index + 1, language: "fr", full: true }),
);
FRENCH_SHORT.forEach((word, index) => {
  const bare = word.replace(".", "");
  if (!MONTH_WORDS.has(bare))
    MONTH_WORDS.set(bare, { month: index + 1, language: "fr", full: false });
});
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so that "mars" is not read as "mar" and "sept" as "sep".
const MONTH = `(?:${[...MONTH_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|")})\\.?`;

/** A date form: how to find it, and how to read it back as numbers. */
interface DateForm {
  pattern: string;
  /** Read only after a date label (see RULES). */
  labelOnly?: true;
  read: (
    match: RegExpExecArray,
    dayFirst: boolean,
  ) => { year: number; month: number; day: number } | null;
}
const monthOf = (word: string) =>
  MONTH_WORDS.get(word.toLowerCase().replace(/\.$/, ""))?.month ?? 0;
const twoDigitYear = (year: number) => {
  // Within the last 100 years, up to next year.
  const now = new Date().getUTCFullYear();
  const century = Math.floor(now / 100) * 100;
  return century + year > now + 1 ? century - 100 + year : century + year;
};
const DATE_FORMS: DateForm[] = [
  {
    // 2026-10-08
    pattern: "\\b(\\d{4})-(\\d{2})-(\\d{2})\\b",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 2026/10/08
    pattern: "\\b(\\d{4})/(\\d{1,2})/(\\d{1,2})\\b",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 2026-Oct-08
    pattern: `\\b(\\d{4})-(${MONTH})-(\\d{1,2})\\b`,
    read: (m) => ({ year: +m[1], month: monthOf(m[2]), day: +m[3] }),
  },
  {
    // 8 October 2026, 17-Apr-1961, 2 mars 1958, 1er mars 1958
    pattern: `\\b(\\d{1,2})(?:er)?([ -])(${MONTH})[ ,-]*(\\d{4})\\b`,
    read: (m) => ({ year: +m[4], month: monthOf(m[3]), day: +m[1] }),
  },
  {
    // October 8, 2026 and Oct. 8 2026
    pattern: `(?<![\\p{L}])(${MONTH}) (\\d{1,2}),? (\\d{4})\\b`,
    read: (m) => ({ year: +m[3], month: monthOf(m[1]), day: +m[2] }),
  },
  {
    // 08/10/2026 or 10/08/2026, and with full stops
    // No backreference: the forms are joined into one pattern for dates of
    // birth, where group numbers move.
    pattern: "\\b(\\d{1,2})([/.])(\\d{1,2})[/.](\\d{4})\\b",
    read: (m, dayFirst) => dayMonth(+m[1], +m[3], +m[4], dayFirst),
  },
  {
    // 08/10/26: slashes only, so that a range such as 12.5-15.0 is not one.
    // Bare, "1/2/24" is as likely a ratio or a dose as a date: read only
    // after a date label, or as a date of birth.
    pattern: "\\b(\\d{1,2})/(\\d{1,2})/(\\d{2})\\b",
    labelOnly: true,
    read: (m, dayFirst) =>
      dayMonth(+m[1], +m[2], twoDigitYear(+m[3]), dayFirst),
  },
];
function dayMonth(
  first: number,
  second: number,
  year: number,
  dayFirst: boolean,
) {
  // One of them over 12 settles it; otherwise the option does.
  const firstIsDay = first > 12 || (second <= 12 && dayFirst);
  return firstIsDay
    ? { year, month: second, day: first }
    : { year, month: first, day: second };
}
const DATE = `(?:${DATE_FORMS.map((form) => form.pattern).join("|")})`;

const pad = (value: number) => String(value).padStart(2, "0");

/** A month word written as the original one was: its language, full or
 * short, its full stop and its capitals. */
function monthLike(original: string, month: number): string {
  const bare = original.replace(/\.$/, "");
  const known = MONTH_WORDS.get(bare.toLowerCase());
  const language = known?.language ?? "en";
  let word: string;
  if (language === "fr")
    word = (known?.full ? FRENCH : FRENCH_SHORT)[month - 1];
  else if (known?.full) word = ENGLISH[month - 1];
  else
    word = ENGLISH[month - 1].slice(0, 3) + (original.endsWith(".") ? "." : "");
  if (bare === bare.toUpperCase()) return word.toUpperCase();
  if (bare[0] === bare[0].toUpperCase())
    return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** The date in `text`, shifted by `days` and written as it was; null if it
 * is no date. */
function shiftDate(
  text: string,
  days: number,
  dayFirst: boolean,
): string | null {
  for (const form of DATE_FORMS) {
    const match = new RegExp(`^${form.pattern}$`, "iu").exec(text);
    if (!match) continue;
    const parts = form.read(match, dayFirst);
    if (!parts) return null;
    const { year, month, day } = parts;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1) return null;
    const shifted = new Date(date.getTime() + days * 86_400_000);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth() + 1;
    const d = shifted.getUTCDate();
    // Each part replaced in place, so that the separators and the order stay.
    return rewrite(text, match, form, { y, m, d }, dayFirst);
  }
  return null;
}

function rewrite(
  text: string,
  match: RegExpExecArray,
  form: DateForm,
  { y, m, d }: { y: number; m: number; d: number },
  dayFirst: boolean,
): string {
  const index = DATE_FORMS.indexOf(form);
  switch (index) {
    case 0:
      return `${y}-${pad(m)}-${pad(d)}`;
    case 1:
      return `${y}/${pad(m)}/${pad(d)}`;
    case 2:
      return `${y}-${monthLike(match[2], m)}-${pad(d)}`;
    case 3: {
      const separator = match[2];
      const ordinal = /^\d{1,2}er/.test(text) && d === 1 ? "er" : "";
      const between = text.slice(
        text.indexOf(match[3]) + match[3].length,
        text.lastIndexOf(match[4]),
      );
      return `${d}${ordinal}${separator}${monthLike(match[3], m)}${between}${y}`;
    }
    case 4:
      return `${monthLike(match[1], m)} ${d}${text.includes(",") ? "," : ""} ${y}`;
    case 5: {
      const separator = match[2];
      const firstIsDay = +match[1] > 12 || (+match[3] <= 12 && dayFirst);
      return firstIsDay
        ? `${pad(d)}${separator}${pad(m)}${separator}${y}`
        : `${pad(m)}${separator}${pad(d)}${separator}${y}`;
    }
    default: {
      const firstIsDay = +match[1] > 12 || (+match[2] <= 12 && dayFirst);
      const yy = pad(y % 100);
      return firstIsDay
        ? `${pad(d)}/${pad(m)}/${yy}`
        : `${pad(m)}/${pad(d)}/${yy}`;
    }
  }
}

// ---------------------------------------------------------------- names, places

const UPPER = "\\p{Lu}";
// A word of a name: a capital, then letters, apostrophes or hyphens.
const NAME_WORD = `${UPPER}[\\p{L}'’-]+`;
// "de la Cruz", "van der Berg", "d'Amours", "bin Saleh", "St-Pierre".
const PARTICLE =
  "(?:de|du|des|la|le|les|van|von|der|den|ter|ten|bin|ibn|al|el|da|dos|das|di|del|della|degli)";
const NAME_PART = `(?:[dD]['’])?${NAME_WORD}`;
const PARTICLES = new Set(PARTICLE.slice(3, -1).split("|"));
const CAPITALIZED_NAME = `${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){0,3}`;
// The particles in any case: "de la Cruz", "De La Cruz", "DE LA CRUZ".
const PARTICLE_ANY_CASE = `(?:${[...PARTICLES]
  .flatMap((particle) => [
    particle,
    particle[0].toUpperCase() + particle.slice(1),
    particle.toUpperCase(),
  ])
  .join("|")})`;
// After a label, a word followed by a colon is the next label ("DOB:",
// "Tel:"), not more of the name.
const LABEL_PART = `${NAME_PART}(?![\\p{L}'’-]|[ \\t]*[:#])`;
// Surname first, as lab, imaging and hospital headers have it (#80 review):
// "Okafor, Margaret A.", "OKAFOR, MARGARET", "de la Cruz, Maria".
const SURNAME_FIRST = `(?:${PARTICLE_ANY_CASE}[ \\t]+)*${LABEL_PART},[ \\t]+${LABEL_PART}(?:[ \\t]+${LABEL_PART})?(?:[ \\t]+${UPPER}\\.?(?![\\p{L}]))?`;
// After a label: surname first, or the name as written, in any case
// ("Avery EXAMPLE", "MARGARET OKAFOR").
const LABELLED_NAME = `(?:${SURNAME_FIRST}|${LABEL_PART}(?:[ \\t]+(?:${PARTICLE_ANY_CASE}[ \\t]+)*${LABEL_PART}){0,3})`;
// Initials before a name: "Dr. J. Smith", "cc: Dr. A. Patel" (#80 review).
const INITIALS = `(?:${UPPER}\\.[ \\t]*)*`;
// A clinician after a title or a label: initials and a name, or surname
// first ("Okafor, Margaret").
const CLINICIAN_NAME = `(?:${SURNAME_FIRST}|${INITIALS}${CAPITALIZED_NAME})`;
// Credentials after a name: "Jane Doe, MD", "OKAFOR, MARGARET, NP".
const CREDENTIAL =
  "(?:MD|M\\.D\\.|NP|RN|RPN|FRCPC|FRCSC|CCFP|PhD|Ph\\.D\\.|PharmD|RPh|MSW|RSW)";
// Who wrote, signed or sent a document.
const BY =
  "(?:(?:[Rr]eferred|[Ss]igned|[Rr]eported|[Dd]ictated|[Tt]ranscribed) by|(?:[Rr]éféré|[Ss]igné|[Dd]icté) par)";
/** Labels as written, With Capitals and IN CAPITALS, longest first. */
const anyCase = (labels: string[]) =>
  `(?:${[
    ...new Set(
      labels.flatMap((label) => [
        label,
        label.replace(
          /(^|\s)(\p{L})/gu,
          (_, space, letter) => space + letter.toUpperCase(),
        ),
        label.toUpperCase(),
      ]),
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})`;
// The labels a person's name follows. A dash needs a space before it, so
// "Patient-centred" is no label.
const NAME_LABEL = `${anyCase([
  "Patient name",
  "Patient",
  "Patiente",
  "Pt",
  "Name",
  "Nom",
  "Re",
  "Next of kin",
  "Emergency contact",
  "Contact",
  "Spouse",
  "Parent",
  "Guardian",
  "Conjoint",
  "Conjointe",
  "Personne à contacter",
])}(?:[ \\t]*:|[ \\t]+[-–—])`;

const PROVINCES =
  "(?:ON|BC|QC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU|Ontario|British Columbia|Colombie-Britannique|Qu[eé]bec|Alberta|Manitoba|Saskatchewan|Nova Scotia|Nouvelle-[ÉE]cosse|New Brunswick|Nouveau-Brunswick|Newfoundland and Labrador|Terre-Neuve-et-Labrador|Prince Edward Island|[ÎI]le-du-Prince-[ÉE]douard|Yukon|Northwest Territories|Territoires du Nord-Ouest|Nunavut)";
const STREET_TYPE =
  "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Crescent|Cres|Place|Pl|Terrace|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Trail|Square|Sq|Gate|Row)";
// French street types come first, in lower case or capitalized.
const either = (word: string) =>
  `[${word[0].toUpperCase()}${word[0]}]${escapeRegExp(word.slice(1))}`;
const FRENCH_STREET_TYPE = `(?:${[
  "rue",
  "boulevard",
  "boul.",
  "boul",
  "bd",
  "avenue",
  "av.",
  "chemin",
  "ch.",
  "route",
  "rang",
  "montée",
  "côte",
  "place",
  "allée",
  "impasse",
  "promenade",
  "croissant",
  "terrasse",
  "carré",
]
  .map(either)
  .join("|")})`;
const UNIT = `(?:,?[ \\t]*(?:Unit|Apt\\.?|Apartment|Suite|app\\.?|apt\\.?|appartement|bureau|unité|local|#)[ \\t]*[\\w-]+)?`;
// In any case: a hospital's header is often in capitals (#80 review).
const CLINIC_WORDS = anyCase([
  "Family Health Team",
  "Family Practice",
  "Medical Clinic",
  "Medical Centre",
  "Medical Center",
  "Health Centre",
  "Health Center",
  "Health Sciences Centre",
  "Clinic",
  "Hospital",
  "Laboratories",
  "Laboratory",
  "Imaging",
  "Diagnostics",
  "Pharmacy",
]);
// Words that, alone before a clinic word, make a heading, not a name.
const GENERIC_BEFORE_CLINIC = new Set([
  "diagnostic",
  "medical",
  "clinical",
  "general",
  "family",
  "community",
  "regional",
  "department",
  "the",
  "ct",
  "mri",
  "mr",
  "pet",
  "us",
  "x-ray",
  "nuclear",
  "breast",
  "cardiac",
  "vascular",
]);
// Profile-name words that are also ordinary words: removed only as part of
// the whole name.
const ORDINARY_WORDS = new Set([
  "major",
  "iris",
  "mark",
  "may",
  "grace",
  "brown",
  "rose",
  "will",
  "hope",
  "faith",
  "joy",
  "june",
  "april",
  "august",
  "bill",
  "pat",
  "dawn",
  "summer",
  "river",
  "white",
  "black",
  "green",
  "young",
  "king",
  "page",
  "rich",
  "guy",
  "ray",
  "lane",
  "dale",
  "glen",
  "art",
  "frank",
  "sunny",
  "claire",
  "blanc",
  "petit",
  "grand",
  "roy",
  "pierre",
]);
// Words that follow a label or a family word but start no name: "Re:
// Follow-up visit", "Patient: Seen today", "Contact: Mother …".
const NOT_NAMES = new Set([
  "follow-up",
  "followup",
  "seen",
  "see",
  "visit",
  "review",
  "results",
  "result",
  "referral",
  "consultation",
  "consult",
  "new",
  "unknown",
  "none",
  "nil",
  "not",
  "self",
  "same",
  "above",
  "below",
  "annual",
  "assessment",
  "request",
  "report",
  "notes",
  "note",
  // A subject line, often in capitals after "RE:": "RE: CT CHEST".
  "ct",
  "mri",
  "pet",
  "x-ray",
  "xray",
  "ultrasound",
  "echo",
  "ecg",
  "ekg",
  "eeg",
  "emg",
  "mammogram",
  "mammography",
  "left",
  "right",
  "bilateral",
  "chest",
  "abdomen",
  "abdominal",
  "pelvis",
  "pelvic",
  "head",
  "neck",
  "knee",
  "hip",
  "shoulder",
  "spine",
  "lumbar",
  "cervical",
  "update",
  "appointment",
  "discharge",
  "admission",
  "test",
  "tests",
  "exam",
  "lab",
  "labs",
  "please",
  "thank",
  "thanks",
  "today",
  "the",
  "this",
  "her",
  "his",
  "their",
  "she",
  "he",
  "they",
  "mother",
  "father",
  "husband",
  "wife",
  "son",
  "daughter",
  "brother",
  "sister",
  "spouse",
  "partner",
  "parent",
  "guardian",
  "patient",
  "urgent",
  "routine",
  "history",
  "plan",
  "suivi",
  "voir",
  "vu",
  "vue",
  "rendez-vous",
  "demande",
  "résultats",
  "rapport",
  "aucun",
  "aucune",
  "inconnu",
  "patiente",
  "mère",
  "père",
  "fils",
  "fille",
  "conjoint",
  "conjointe",
  "elle",
  "il",
  "merci",
]);

/** The words of a name worth finding alone: three letters or more, and
 * neither a surname particle nor an ordinary word; a hyphenated surname's
 * parts too, and a surname without its d'. */
function nameWords(name: string): string[] {
  const words = new Set<string>();
  for (const word of name.split(/[^\p{L}'’-]+/u))
    for (const part of [
      word,
      ...word.split("-"),
      word.replace(/^[dD]['’]/, ""),
    ]) {
      const bare = part.replace(/^['’-]+|['’-]+$/gu, "");
      const lower = bare.toLowerCase();
      if (
        bare.length >= 3 &&
        !PARTICLES.has(lower) &&
        !ORDINARY_WORDS.has(lower)
      )
        words.add(bare);
    }
  return [...words];
}

/** A rule: what it finds, and which part of a match is the detail. */
interface Rule {
  kind: RemovedKind | "date";
  pattern: RegExp;
  /** The capture group holding the detail; the whole match when absent. */
  group?: number;
}

const HEALTH_CARD_LABEL =
  "(?:[Hh]ealth [Cc]ard(?: [Nn]umber| [Nn]o\\.?| #)?|[Hh]ealth (?:[Ii]nsurance )?[Nn]umber|HCN|PHN|OHIP|RAMQ|MSP|AHCIP|NAM|[Hh]ealth #|[Cc]arte d'assurance maladie|[Nn]uméro d'assurance maladie)";
// Digit groups with an optional two-letter version code, or Quebec's form:
// nothing after them on the line is taken.
const HEALTH_CARD_VALUE =
  "(?:[A-Z]{4}[ -]?\\d{4}[ -]?\\d{4}|(?:\\d{4,5}[ -]?\\d{3,4}[ -]?\\d{3,4}|\\d{8,12})(?:[ -]?[A-Z]{2}(?![\\p{L}]))?)";

const RULES: Rule[] = [
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    kind: "healthCard",
    pattern: new RegExp(
      `\\b${HEALTH_CARD_LABEL}[ \\t]*[:#]?[ \\t]*(${HEALTH_CARD_VALUE})`,
      "gu",
    ),
    group: 1,
  },
  // Ontario and BC (ten digits in 4-3-3 groups, maybe a version code), and
  // Quebec (four letters, eight digits), unlabelled.
  {
    kind: "healthCard",
    pattern:
      /\b\d{4}[- ]\d{3}[- ]\d{3}(?:[- ]?[A-Z]{2})?\b|\b\d{10}[- ]?[A-Z]{2}\b|\b[A-Z]{4}[ -]?\d{4}[ -]?\d{4}\b/g,
  },
  {
    kind: "recordNumber",
    pattern:
      /\b(?:MRN|Medical record(?: number| no\.?| #)?|Chart(?: number| no\.?| #)?|Record(?: number| no\.?| #)|Hospital(?: number| no\.?| #)|Patient ID|Accession(?: number| no\.?| #)?|Requisition(?: number| no\.?| #)?|Lab(?: number| no\.?| #)|Encounter(?: number| no\.?| #)?|Visit(?: number| no\.?| #)|Case(?: number| no\.?| #)|File(?: number| no\.?| #)|Dossier(?: no\.?| n°| #)?|N[o°] de dossier|Numéro de dossier)[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/giu,
    group: 1,
  },
  {
    kind: "dateOfBirth",
    pattern: new RegExp(
      `(?:\\bDOB|\\bD\\.O\\.B\\.?|\\bDate of birth|\\bBirth ?date|\\bBorn|\\bDate de naissance|\\bDDN|\\bN[ée]e? le)[ \\t]*:?[ \\t]*(${DATE})`,
      "giu",
    ),
    group: 1,
  },
  {
    kind: "phone",
    pattern:
      /(?:\+?1[ .-]?)?(?:\(\d{3}\)[ ]?|\b\d{3}[ .-]?)\d{3}[ .-]?\d{4}\b(?:[ \t]*(?:ext\.?|x|poste)[ \t]*\d{1,5}\b)?/gi,
  },
  {
    kind: "postalCode",
    pattern:
      /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi,
  },
  {
    kind: "postalCode",
    pattern:
      /\b(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+(\d{5}(?:-\d{4})?)\b/g,
    group: 1,
  },
  {
    kind: "address",
    pattern:
      /\b(?:Address|Mailing address|Home address|Adresse)[ \t]*:[ \t]*([^\n]+)/giu,
    group: 1,
  },
  {
    kind: "address",
    pattern: new RegExp(
      `\\b\\d{1,6}(?:-\\d{1,6})?[ \\t]+(?:${NAME_WORD}\\.?[ \\t]+){1,4}${STREET_TYPE}\\b\\.?(?:[ \\t]+(?:East|West|North|South|E|W|N|S)\\b)?${UNIT}`,
      "gu",
    ),
  },
  {
    // 1234, rue Sherbrooke Est; 88, boul. René-Lévesque Ouest, app. 5
    kind: "address",
    pattern: new RegExp(
      `\\b\\d{1,6}(?:-\\d{1,6})?,?[ \\t]+${FRENCH_STREET_TYPE}[ \\t]+(?:(?:de|du|des|la|le|l['’]|d['’])[ \\t]*)*${NAME_WORD}(?:[ \\t-]+${NAME_WORD})*(?:[ \\t]+(?:Est|Ouest|Nord|Sud|E|O|N|S)\\b)?${UNIT}`,
      "gu",
    ),
  },
  {
    kind: "address",
    pattern: /\b(?:P\.?O\.? Box|Box|C\.?P\.?|Case postale) \d+\b/giu,
  },
  {
    kind: "address",
    pattern: new RegExp(
      `(?<![\\p{L}])${NAME_WORD}(?:[ -]${NAME_WORD})*(?:,[ \\t]*${PROVINCES}\\b|[ \\t]*\\(${PROVINCES}\\))`,
      "gu",
    ),
  },
  {
    kind: "clinic",
    pattern: new RegExp(
      `(?:${NAME_WORD}\\.?[ \\t]+){1,5}${CLINIC_WORDS}\\b(?:[ \\t]+(?:of|de)[ \\t]+(?:${NAME_WORD}[ \\t]?){1,3})?`,
      "gu",
    ),
  },
  {
    // Clinique médicale Saint-Laurent; Centre hospitalier de Fictiveville
    kind: "clinic",
    pattern: new RegExp(
      `(?<![\\p{L}])${anyCase(["Hôpital", "Clinique", "Centre hospitalier", "Centre de santé", "CLSC", "CHSLD", "Pharmacie", "Laboratoire"])}(?:[ \\t]+(?:de|du|des|la|le|l['’]|d['’]|médicale|universitaire|régionale?|générale?|familiale|${NAME_WORD})){1,6}`,
      "gu",
    ),
  },
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Dr|Dre|Doctor|Docteur|Docteure)\\.?[ \\t]+(${INITIALS}${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:(?:Mr|Mrs|Ms|Miss|Mx|Prof|Mme|Mlle)\\.?|M\\.)[ \\t]+(${INITIALS}${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])${NAME_LABEL}[ \\t]*(${LABELLED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Rr]eferring physician|[Pp]hysician|[Pp]rovider|[Oo]rdering provider|[Aa]ttending|[Ss]igned|[Ff]amily doctor|cc|CC|[Cc]opy to|[Mm]édecin traitant|${BY})[ \\t]*:[ \\t]*(?:(?:Dr|Dre)\\.?[ \\t]+)?(${CLINICIAN_NAME})`,
      "gu",
    ),
    group: 1,
  },
  // "Electronically signed by Okafor, Margaret, MD" (#80 review). Without a
  // colon, only a name of two words or more, or surname first: "Referred by
  // Emergency" names no one. "By Dr. …" is the title rule's.
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])${BY}[ \\t]+(${SURNAME_FIRST}|${INITIALS}${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
  },
  // A name with credentials after it: "Jane Doe, MD" (#80 review). Two
  // words, so a word before the name ("Signed Jane Doe, MD") stays.
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])(${SURNAME_FIRST}|${NAME_PART}(?:[ \\t]+${UPPER}\\.)?[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}),?[ \\t]+${CREDENTIAL}(?![\\p{L}])`,
      "gu",
    ),
    group: 1,
  },
  // Other clinicians by their title: "Nurse Practitioner Jane Doe".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Nurse [Pp]ractitioner|Nurse|Dietitian|Dietician|Pharmacist|Physiotherapist|Physical [Tt]herapist|Occupational [Tt]herapist|Social [Ww]orker|Midwife|Infirmière|Infirmier|Pharmacienne|Pharmacien|Physiothérapeute|Ergothérapeute|Nutritionniste|Diététiste|Travailleuse sociale|Travailleur social|Sage-femme)[ \\t]+(${INITIALS}${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  // A relative named in passing: "her husband, Jordan", "son conjoint, Jean".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Hh]usband|[Ww]ife|[Ss]pouse|[Pp]artner|[Ss]on|[Dd]aughter|[Mm]other|[Ff]ather|[Bb]rother|[Ss]ister|[Cc]onjointe?|[ÉéEe]poux|[ÉéEe]pouse|[Ff]ils|[Ff]ille|[Mm]ère|[Pp]ère|[Ff]rère|[Ss]œur)[ \\t]*,?[ \\t]+(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  // A closing, then the name on the next non-empty line.
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Sincerely|Yours truly|Regards|Best regards|Kind regards|Cordialement|Salutations distinguées),[ \\t]*\\n(?:[ \\t]*\\n)*[ \\t]*(?:(?:Dr|Dre)\\.?[ \\t]+)?(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  ...DATE_FORMS.filter((form) => !form.labelOnly).map((form) => ({
    kind: "date" as const,
    pattern: new RegExp(form.pattern, "giu"),
  })),
  // "Date: 17/10/26", "Visit date: …", "Date de la visite : …", "dated …".
  ...DATE_FORMS.filter((form) => form.labelOnly).map((form) => ({
    kind: "date" as const,
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Dd]ate(?![\\p{L}])[^\\n:]{0,30}:|[Dd]ated|(?:[Cc]ollected|[Rr]eceived|[Rr]eported|[Aa]dmitted|[Dd]ischarged|[Ss]igned)[ \\t]*:)[ \\t]*(${form.pattern})`,
      "gu",
    ),
    group: 1,
  })),
];

function find(text: string, options: DeidentifyOptions): Finding[] {
  const found: Finding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const detail = rule.group ? match[rule.group] : match[0];
      if (!detail) continue;
      const offset = rule.group ? match[0].indexOf(detail) : 0;
      const start = match.index + offset;
      // A label's value may run past the detail into trailing punctuation,
      // and a French clinic's name into connecting words.
      let trimmed = detail.replace(/[\s,;.]+$/u, "");
      if (rule.kind === "clinic") {
        trimmed = trimmed.replace(
          /(?:[ \t]+(?:de|du|des|la|le|l['’]|d['’]|of))+$/u,
          "",
        );
        // "CT Imaging", "Diagnostic Imaging": a heading, not a name.
        const before = trimmed
          .replace(new RegExp(`${CLINIC_WORDS}.*$`, "u"), "")
          .trim()
          .split(/[ \t]+/)
          .filter(Boolean);
        if (
          before.length &&
          before.every((word) => GENERIC_BEFORE_CLINIC.has(word.toLowerCase()))
        )
          continue;
      }
      if (
        (rule.kind === "name" || rule.kind === "doctor") &&
        NOT_NAMES.has(trimmed.split(/[\s,]+/)[0].toLowerCase())
      )
        continue;
      found.push({ kind: rule.kind, start, end: start + trimmed.length });
    }
  }
  // Each known name: whole wherever it stands (even across a line break),
  // and each word written as a name, unless it is also an ordinary word.
  for (const name of options.knownNames) {
    const person = name.trim().toLowerCase();
    const whole = name.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
    if (whole)
      for (const match of text.matchAll(
        new RegExp(`(?<![\\p{L}])${whole}(?![\\p{L}])`, "giu"),
      ))
        found.push({
          kind: "name",
          start: match.index,
          end: match.index + match[0].length,
          person,
        });
    // Removed written as a name; in lower case, only flagged.
    for (const word of nameWords(name))
      for (const match of text.matchAll(wordPattern(word)))
        found.push({
          kind: writtenAsName(match[0]) ? "name" : "possibleName",
          start: match.index,
          end: match.index + match[0].length,
          person,
        });
  }
  return found;
}

/** A capital first: "Avery", "AVERY", "O'Neil-Smith", "d'Amours". */
const writtenAsName = (word: string) => /^(?:[dD]['’])?\p{Lu}/u.test(word);

const wordPattern = (word: string) =>
  new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "giu");

/**
 * A name a rule found (after a title, a label, a family word or a closing) is
 * that person wherever else it stands, with or without one (#72 review): the
 * whole name in any case, and each word of it alone (or a one-word name)
 * written as a name. A single word in lower case is more often an everyday
 * word ("the ward", "grant the request"), so it is only flagged for the
 * preview. Each place takes the
 * placeholder of the name it came from; a doctor's, the doctor's. Words of a
 * profile name are left to the profile name. Only names that won where they
 * were found count: "Mother Teresa Clinic" after "Contact:" is a clinic.
 */
function otherPlaces(
  text: string,
  found: Finding[],
  options: DeidentifyOptions,
): Finding[] {
  const known = new Set(
    options.knownNames.flatMap((name) =>
      nameWords(name).map((word) => word.toLowerCase()),
    ),
  );
  const named = found
    .filter((f) => (f.kind === "name" || f.kind === "doctor") && !f.person)
    .sort((a, b) => a.start - b.start);
  // Names by the words that make them one: "Mrs. Example" is the "Avery
  // Example" before it.
  const groups: { words: Set<string>; key: string }[] = [];
  const claimed = new Map<string, string>();
  const places: Finding[] = [];
  for (const finding of named) {
    const whole = text.slice(finding.start, finding.end);
    const words = nameWords(whole);
    const lower = words.map((word) => word.toLowerCase());
    let group: string;
    if (finding.kind === "doctor") {
      // A doctor by surname, as the placeholders have it: the last word, or
      // before a comma when the surname comes first.
      const surname = whole.includes(",")
        ? whole.slice(0, whole.indexOf(","))
        : whole;
      const parts = surname.toLowerCase().trim().split(/\s+/);
      group = parts[parts.length - 1];
    } else {
      group =
        groups.find(
          (other) =>
            lower.length > 0 && lower.every((word) => other.words.has(word)),
        )?.key ??
        (lower.length ? [...lower].sort().join(" ") : whole.toLowerCase());
      groups.push({ words: new Set(lower), key: group });
    }
    finding.group = group;
    const place = (match: RegExpExecArray | RegExpMatchArray, as: string) =>
      places.push({
        kind:
          /\s/u.test(match[0]) || writtenAsName(match[0])
            ? finding.kind
            : "possibleName",
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        group: as,
        whole,
        swept: true,
      });
    const pattern = whole.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
    for (const match of text.matchAll(
      new RegExp(`(?<![\\p{L}])${pattern}(?![\\p{L}])`, "giu"),
    ))
      place(match, group);
    for (const word of words) {
      if (known.has(word.toLowerCase())) continue;
      // A word in two names stays with the first.
      const key = `${finding.kind}:${word.toLowerCase()}`;
      if (!claimed.has(key)) claimed.set(key, group);
      for (const match of text.matchAll(wordPattern(word)))
        place(match, claimed.get(key) ?? group);
    }
  }
  return places;
}

/** Keeps the findings that win where they overlap: the higher priority, then
 * the longer. */
function resolve(findings: Finding[]): Finding[] {
  const rank = (finding: Finding) =>
    finding.kind !== "possibleName" && finding.swept
      ? PRIORITY.name + 0.5
      : PRIORITY[finding.kind];
  const ranked = [...findings].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.end - b.start - (a.end - a.start) ||
      a.start - b.start,
  );
  const kept: Finding[] = [];
  for (const finding of ranked) {
    if (finding.end <= finding.start) continue;
    if (
      kept.some(
        (other) => finding.start < other.end && other.start < finding.end,
      )
    )
      continue;
    kept.push(finding);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function randomShift(): number {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  const days = 30 + (values[0] % 336);
  return values[1] % 2 ? days : -days;
}

function result(toSend: string, onDevice: OnDevice): Deidentified {
  const value = { toSend } as Deidentified;
  Object.defineProperty(value, "onDevice", {
    value: onDevice,
    enumerable: false,
  });
  return Object.freeze(value);
}

/** Takes identifying details out of `text` (#72). */
export function deidentify(
  text: string,
  options: DeidentifyOptions,
): Deidentified {
  const dateShiftDays = options.dateShiftDays ?? randomShift();
  const found = resolve(find(text, options));
  return build(
    text,
    resolve([...found, ...otherPlaces(text, found, options)]),
    dateShiftDays,
    options.dayFirst ?? true,
  );
}

function build(
  source: string,
  findings: Finding[],
  dateShiftDays: number,
  dayFirst: boolean,
): Deidentified {
  // One placeholder per distinct detail of a kind (and per person, for
  // names), numbered in the order first seen.
  const numbers = new Map<string, number>();
  const counts = new Map<string, number>();
  const placeholder = (finding: Finding, original: string) => {
    const kind = finding.kind as Exclude<RemovedKind, "manual">;
    // A doctor is one placeholder by surname: "Dr. Blake Sample" and "Dr.
    // Sample" are the same person, as far as the text can tell.
    const words = original.toLowerCase().split(/\s+/);
    const identity = `${kind}:${
      finding.person ??
      finding.group ??
      (kind === "doctor" ? words[words.length - 1] : words.join(" "))
    }`;
    let number = numbers.get(identity);
    if (number === undefined) {
      number = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, number);
      numbers.set(identity, number);
    }
    return `[${LABELS[kind]} ${number}]`;
  };
  // A profile name seen in full (or in part) after a title is still that
  // person: names found by a rule take the placeholder of a known person
  // whose words they contain.
  const people = findings.filter(
    (finding) => finding.person && finding.kind === "name",
  );
  const personOf = (original: string) =>
    people.find((finding) =>
      original
        .toLowerCase()
        .split(/[^\p{L}'’-]+/u)
        .includes(source.slice(finding.start, finding.end).toLowerCase()),
    )?.person;

  let text = "";
  let at = 0;
  const removed: Removed[] = [];
  const possibleNames: PossibleName[] = [];
  for (const finding of findings) {
    const original = source.slice(finding.start, finding.end);
    if (finding.kind === "possibleName") {
      // Left as it is: where it will stand once the text before it is in.
      const sentStart = text.length + finding.start - at;
      possibleNames.push({
        original,
        start: finding.start,
        end: finding.end,
        sentStart,
        sentEnd: sentStart + original.length,
      });
      continue;
    }
    let replacement: string;
    if (finding.replacement !== undefined) {
      replacement = finding.replacement;
    } else if (finding.kind === "date") {
      const shifted = shiftDate(original, dateShiftDays, dayFirst);
      if (shifted === null) continue;
      replacement = shifted;
    } else {
      const person =
        finding.kind === "name" || finding.kind === "doctor"
          ? (finding.person ?? personOf(finding.whole ?? original))
          : undefined;
      replacement = placeholder(
        person ? { ...finding, kind: "name", person } : finding,
        original,
      );
    }
    text += source.slice(at, finding.start);
    const sentStart = text.length;
    text += replacement;
    removed.push({
      kind: finding.kind,
      original,
      replacement,
      start: finding.start,
      end: finding.end,
      sentStart,
      sentEnd: text.length,
    });
    at = finding.end;
  }
  text += source.slice(at);
  return result(text, { removed, possibleNames, dateShiftDays, source });
}

/**
 * The patient removes more from the preview (#72): the part of the text to
 * send from `sentStart` to `sentEnd`, which must lie outside every
 * placeholder and shifted date already there. It becomes "[REMOVED n]".
 */
export function removeMore(
  deidentified: Deidentified,
  sentStart: number,
  sentEnd: number,
): Deidentified {
  const { removed, possibleNames, dateShiftDays, source } =
    deidentified.onDevice;
  // Map the range back to the document, through what came before it.
  let shift = 0;
  for (const part of removed) {
    if (part.sentEnd <= sentStart) {
      shift += part.end - part.start - (part.sentEnd - part.sentStart);
      continue;
    }
    if (part.sentStart < sentEnd)
      throw new RangeError("overlaps a part already removed");
  }
  const start = sentStart + shift;
  const end = sentEnd + shift;
  if (start < 0 || end > source.length || end <= start)
    throw new RangeError("outside the text");
  const manual = removed.filter((part) => part.kind === "manual");
  // Everything already decided stays as it was; only the new part is new.
  // A flagged word stays flagged unless the new part takes it.
  const findings: Finding[] = [
    ...removed.map((part) => ({
      kind: part.kind,
      start: part.start,
      end: part.end,
      replacement: part.replacement,
    })),
    ...possibleNames
      .filter((possible) => possible.end <= start || end <= possible.start)
      .map((possible) => ({
        kind: "possibleName" as const,
        start: possible.start,
        end: possible.end,
      })),
    {
      kind: "manual" as const,
      start,
      end,
      replacement: `[REMOVED ${manual.length + 1}]`,
    },
  ].sort((a, b) => a.start - b.start);
  return build(source, findings, dateShiftDays, true);
}

/**
 * Puts the details back into an answer that came back with the placeholders
 * (#72), on the device: each placeholder becomes what it stood for, and each
 * shifted date the date it was. A date the answer wrote some other way is
 * left shifted.
 */
export function restore(answer: string, deidentified: Deidentified): string {
  const back = new Map<string, string>();
  for (const part of deidentified.onDevice.removed)
    if (!back.has(part.replacement)) back.set(part.replacement, part.original);
  // Longest first, so that "[NAME 1]" never stands inside "[NAME 10]"'s place.
  const keys = [...back.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return answer;
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  return answer.replace(pattern, (found) => back.get(found) ?? found);
}
