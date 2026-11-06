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
 * French. No date is sent: every date but a date of birth becomes a
 * placeholder numbered in calendar order, "[DATE 2, 14 days after DATE 1]",
 * the same real date always the same one, so the gaps between dates stay
 * without the dates. An age of 90 or over becomes "[AGE 1, 90+]". Each
 * removed detail becomes a placeholder, such as "[NAME 1]", the same one each
 * time the same detail appears, and `restoreChecked` puts them back.
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

import { cleanText, matchingCopy, toSourceRange } from "./textCleaning";
import allowList from "./eponymAllowList.json";
import {
  bracketedMunicipalities,
  facilitySpans,
  municipalitySpans,
} from "./gazetteer";

/** A word or a pattern as it stands in the matching copy: accents and
 * look-alike letters folded, as `matchingCopy` folds the text. Regular
 * expression syntax is ASCII and stays as it is. */
const fold = (value: string) => matchingCopy(value).copy;
const foldAll = (words: string[]) => words.map(fold);

export type RemovedKind =
  | "name"
  | "doctor"
  | "clinic"
  | "healthCard"
  | "recordNumber"
  | "sin"
  | "dateOfBirth"
  | "age"
  | "address"
  | "postalCode"
  | "phone"
  | "email"
  | "web"
  /** A numeric date that could be read two ways (03/04/2025): a plain
   * placeholder, with no gap, since nothing has to be read to put it back. */
  | "unclearDate"
  | "manual";

/** The words inside the placeholders, in the app's language: "[NAME 1]". */
export type PlaceholderLabels = Record<RemovedKind, string>;

/** One detail taken out, or one date replaced by a placeholder. */
export interface Removed {
  kind: RemovedKind | "date";
  /** The text as it was in the document. */
  original: string;
  /** What stands in its place: a placeholder such as "[NAME 1]", or with a
   * note after the number, "[DATE 2, 14 days after DATE 1]". */
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
  /** Everything taken out, in the order it appears. */
  removed: Removed[];
  /** Words left in that may be names, in the order they appear. */
  possibleNames: PossibleName[];
  /** How an ambiguous numeric date was read, kept for `removeMore`. */
  dayFirst: boolean;
  /** The placeholder words used, kept for `removeMore`. */
  labels: PlaceholderLabels;
  /** The notes written after a placeholder's number, kept for `removeMore`. */
  notes: PlaceholderNotes;
  /** The other languages' placeholder words and notes (#215), kept for
   * `removeMore` and `restoreChecked`. None in a result from before #215. */
  otherLanguages?: PlaceholderVocabulary[];
  /** The document as the file will hold it before any removal: the text
   * given, cleaned (`cleanText`). */
  source: string;
  /** What the cleaning changed, for the preview's warning. */
  cleaning: { replacedRuns: number; droppedCodePoints: number };
}

export interface Deidentified {
  /** The text that may be sent: placeholders only, no real date but the
   * ones the vault never sees (none). */
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
  /** Birth dates the vault knows (every profile's), as "1961-04-17": the
   * date is removed as a date of birth wherever it stands, in any form the
   * date reader knows. */
  knownBirthDates?: string[];
  /** Clinic names the vault knows (verified senders, linked portals). */
  knownClinics?: string[];
  /** Doctor names the vault knows (a delivery's provider). */
  knownDoctors?: string[];
  /** How to read a date such as 03/04/2026 when either part could be the
   * month: day first (Canadian and most of the world) unless told. Such a
   * date becomes a plain placeholder with no gap; this only decides which
   * day it is when it is a known birth date. */
  dayFirst?: boolean;
  /** The placeholder words, in the document's language (#215); English when
   * not given. */
  labels?: Partial<PlaceholderLabels>;
  /** The notes after a placeholder's number, in the document's language. */
  notes?: Partial<PlaceholderNotes>;
  /** The same words and notes in the app's other languages (#215). They are
   * never written, but a new placeholder skips a number that one of them
   * already shows in the document, and an answer that writes one of this
   * export's placeholders in one of them still puts its detail back. */
  otherLanguages?: PlaceholderVocabulary[];
}

/** One language's placeholder words and notes (#215). */
export interface PlaceholderVocabulary {
  labels: PlaceholderLabels;
  notes: PlaceholderNotes;
}

/** The notes a placeholder can carry after its number: "[DATE 2, 14 days
 * after DATE 1]", "[AGE 1, 90+]". One grammar for all of them (`parsePlaceholder`);
 * a new note is a rule that names it and a line of text here. */
export interface PlaceholderNotes {
  /** How far a date is after the earliest date in the text. `label` and
   * `number` name that earliest date's placeholder. */
  daysAfter: (days: number, label: string, number: number) => string;
  /** An age of 90 or over: the age itself stays on the device. */
  ageOver90: string;
}

export const DEFAULT_NOTES: PlaceholderNotes = {
  daysAfter: (days, label, number) =>
    `${days} ${days === 1 ? "day" : "days"} after ${label} ${number}`,
  ageOver90: "90+",
};

export const DEFAULT_LABELS: PlaceholderLabels = {
  name: "NAME",
  doctor: "DOCTOR",
  clinic: "CLINIC",
  healthCard: "HEALTH CARD",
  recordNumber: "RECORD NUMBER",
  sin: "SIN",
  dateOfBirth: "DATE OF BIRTH",
  age: "AGE",
  address: "ADDRESS",
  postalCode: "POSTAL CODE",
  phone: "PHONE",
  email: "EMAIL",
  web: "WEB ADDRESS",
  unclearDate: "DATE",
  manual: "REMOVED",
};

/** Lower wins when two findings overlap; then the longer. */
const PRIORITY: Record<RemovedKind | "date" | "possibleName", number> = {
  manual: 0,
  email: 1,
  web: 1,
  healthCard: 2,
  sin: 2,
  recordNumber: 3,
  dateOfBirth: 4,
  phone: 5,
  age: 5,
  postalCode: 6,
  address: 7,
  doctor: 8,
  clinic: 8,
  name: 9,
  date: 10,
  unclearDate: 10,
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
  /** A relative named after a family word: never taken for a profile person
   * because a surname is shared. */
  kin?: true;
  /** From a header line with no person cue: kept only as "SURNAME, Given". */
  uncuedHeader?: true;
  /** Already decided (when more is removed later): kept as it was. */
  replacement?: string;
  /** The matching copy's text for this range (digits and letters folded),
   * which a date is read from. */
  folded?: string;
  /** For one end of a range ("8" in "8-12 October 2026"), whose own text
   * cannot be read alone: the date it stands for. */
  reading?: DateReading;
}

// ---------------------------------------------------------------- dates

interface MonthWord {
  month: number;
  language: "en" | "fr" | "es" | "pt" | "pl";
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
// The copy the rules run on has no accents: "février" stands as "fevrier".
FRENCH.forEach((word, index) =>
  MONTH_WORDS.set(fold(word), { month: index + 1, language: "fr", full: true }),
);
FRENCH_SHORT.forEach((word, index) => {
  const bare = fold(word.replace(".", ""));
  if (!MONTH_WORDS.has(bare))
    MONTH_WORDS.set(bare, { month: index + 1, language: "fr", full: false });
});
// Spanish, Portuguese and Polish month names (full words only: a short form
// such as "ago" or "dic" is too often an ordinary word). Polish months are
// written in the genitive in a date ("14 maja 2026"), so both forms count.
const OTHER_MONTHS: [MonthWord["language"], string[]][] = [
  [
    "es",
    "enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre".split(
      " ",
    ),
  ],
  [
    "pt",
    "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split(
      " ",
    ),
  ],
  [
    "pl",
    "stycznia lutego marca kwietnia maja czerwca lipca sierpnia września października listopada grudnia".split(
      " ",
    ),
  ],
  [
    "pl",
    "styczeń luty marzec kwiecień maj czerwiec lipiec sierpień wrzesień październik listopad grudzień".split(
      " ",
    ),
  ],
];
for (const [language, words] of OTHER_MONTHS)
  words.forEach((word, index) => {
    const key = fold(word);
    if (!MONTH_WORDS.has(key))
      MONTH_WORDS.set(key, { month: index + 1, language, full: true });
  });
MONTH_WORDS.set("setiembre", { month: 9, language: "es", full: true });
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so that "mars" is not read as "mar" and "sept" as "sep".
const MONTH = `(?:${[...MONTH_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join("|")})\\.?`;

/** A date form: how to find it, and how to read it back as numbers. */
interface DateForm {
  id:
    | "iso"
    | "slashYmd"
    | "ymdWord"
    | "dmy"
    | "mdy"
    | "numeric"
    | "numeric2"
    | "dotYmd"
    | "compact"
    | "monthYear"
    | "dayMonth"
    | "zhYmd"
    | "zhMonthYear"
    | "zhMonthDay"
    | "monthDay"
    | "year";
  pattern: string;
  /** Read only after a date label (see RULES). */
  labelOnly?: true;
  /** A month and a year, a day and a month with no year, or a year alone:
   * never a date of birth, and a year only after a cue word ("in 2019"). */
  partial?: "monthYear" | "monthDay" | "year";
  read: (
    match: RegExpExecArray,
    dayFirst: boolean,
  ) => { year: number; month: number; day: number; unclear?: true } | null;
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
    // 2026-10-08, and 2026-10-08T07:40 (the time stays beside the mark)
    id: "iso",
    pattern: "\\b(\\d{4})-(\\d{2})-(\\d{2})(?=T\\d|\\b)",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 2026年10月8日 (Chinese)
    id: "zhYmd",
    pattern: "(?<!\\d)(\\d{4})年[ ]?(\\d{1,2})月[ ]?(\\d{1,2})日",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 2026/10/08
    id: "slashYmd",
    pattern: "\\b(\\d{4})/(\\d{1,2})/(\\d{1,2})\\b",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 2026-Oct-08
    id: "ymdWord",
    pattern: `\\b(\\d{4})-(${MONTH})-(\\d{1,2})\\b`,
    read: (m) => ({ year: +m[1], month: monthOf(m[2]), day: +m[3] }),
  },
  {
    // 8 October 2026, 17-Apr-1961, 2 mars 1958, 1er mars 1958, 8th October
    // 2026, 8th of October 2026
    id: "dmy",
    pattern: `\\b(\\d{1,2})(?:er|st|nd|rd|th|\\.o|o|a|°)?(?:[ ]+(?:of|de|do))?([ -])(${MONTH})(?:[ ,-]+del?[ ]+|[ ,-]*)(\\d{4})\\b`,
    read: (m) => ({ year: +m[4], month: monthOf(m[3]), day: +m[1] }),
  },
  {
    // October 8, 2026, Oct. 8 2026 and October 8th, 2026
    id: "mdy",
    pattern: `(?<![\\p{L}])(${MONTH}) (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b`,
    read: (m) => ({ year: +m[3], month: monthOf(m[1]), day: +m[2] }),
  },
  {
    // 08/10/2026 or 10/08/2026, and with full stops
    // No backreference: the forms are joined into one pattern for dates of
    // birth, where group numbers move.
    id: "numeric",
    pattern: "\\b(\\d{1,2})([/.-])(\\d{1,2})[/.-](\\d{4})\\b",
    read: (m, dayFirst) => dayMonth(+m[1], +m[3], +m[4], dayFirst),
  },
  {
    // 2026.10.08
    id: "dotYmd",
    pattern: "\\b(\\d{4})\\.(\\d{1,2})\\.(\\d{1,2})\\b",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 20261008, and a lab or HL7 timestamp 20261008074000 (the date part
    // only: the time stays). Eight digits that read as a calendar day.
    id: "compact",
    pattern:
      "\\b((?:19|20)\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])(?=(?:\\d{4}(?:\\d{2})?)?(?!\\d))",
    read: (m) => ({ year: +m[1], month: +m[2], day: +m[3] }),
  },
  {
    // 08/10/26: slashes only, so that a range such as 12.5-15.0 is not one.
    // Bare, "1/2/24" is as likely a ratio or a dose as a date: read only
    // after a date label, or as a date of birth.
    id: "numeric2",
    pattern: "\\b(\\d{1,2})/(\\d{1,2})/(\\d{2})\\b",
    labelOnly: true,
    read: (m, dayFirst) =>
      dayMonth(+m[1], +m[2], twoDigitYear(+m[3]), dayFirst),
  },
  {
    // October 2026, oct. 2026, mars 2026: moved with its 15th day.
    id: "monthYear",
    pattern: `(?<![\\p{L}\\d]|\\d[ -])(${MONTH})(?:[ ,]+del?)?[ ,]+(\\d{4})\\b`,
    partial: "monthYear",
    read: (m) => ({ year: +m[2], month: monthOf(m[1]), day: 15 }),
  },
  {
    // 2026年10月 (Chinese): moved with its 15th day.
    id: "zhMonthYear",
    pattern: "(?<!\\d)(\\d{4})年[ ]?(\\d{1,2})月(?![ ]?\\d{1,2}日)",
    partial: "monthYear",
    read: (m) => ({ year: +m[1], month: +m[2], day: 15 }),
  },
  {
    // 10月8日 (Chinese), no year: a plain mark.
    id: "zhMonthDay",
    pattern: "(?<![\\d年])(\\d{1,2})月[ ]?(\\d{1,2})日",
    partial: "monthDay",
    read: (m) => ({ year: 2000, month: +m[1], day: +m[2] }),
  },
  {
    // 8 October, 8th October, le 8 octobre: no year, so a plain mark.
    id: "dayMonth",
    pattern: `\\b(\\d{1,2})(?:er|st|nd|rd|th|\\.o|o|a|°)?(?:[ ]+(?:of|de|do))?[ ]+(${MONTH})(?![\\p{L}\\d])`,
    partial: "monthDay",
    read: (m) => ({ year: 2000, month: monthOf(m[2]), day: +m[1] }),
  },
  {
    // Oct 8, October 8th: no year, so a plain mark. The year 2000 only
    // makes 29 February a valid day.
    id: "monthDay",
    pattern: `(?<![\\p{L}\\d])(${MONTH})[ ]+(\\d{1,2})(?:st|nd|rd|th)?(?![\\p{L}\\d])`,
    partial: "monthDay",
    read: (m) => ({ year: 2000, month: monthOf(m[1]), day: +m[2] }),
  },
  {
    // A year alone, only after a cue ("in 2019", "depuis 2019"): moved
    // with its 1 July.
    id: "year",
    pattern: "\\b((?:19|20)\\d{2})\\b",
    partial: "year",
    read: (m) => ({ year: +m[1], month: 7, day: 1 }),
  },
];
/** The cue words a year alone follows. */
const YEAR_CUE =
  "(?:in|since|from|until|till|by|during|before|after|en|depuis|dès|avant|après|jusqu['’]en|vers)";
function dayMonth(
  first: number,
  second: number,
  year: number,
  dayFirst: boolean,
) {
  // One of them over 12 settles it; otherwise the option does, and the
  // date is marked unclear: it is removed rather than moved.
  const unclear = first <= 12 && second <= 12 && first !== second;
  const firstIsDay = first > 12 || (second <= 12 && dayFirst);
  const parts = firstIsDay
    ? { year, month: second, day: first }
    : { year, month: first, day: second };
  return unclear ? { ...parts, unclear: true as const } : parts;
}
/** A whole date: what a date of birth, and a date label, may be followed by. */
const DATE = `(?:${DATE_FORMS.filter((form) => !form.partial)
  .map((form) => form.pattern)
  .join("|")})`;

// A weekday before a date is moved with it: recomputed in English and French.
const WEEKDAYS_EN = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const WEEKDAYS_FR = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
];
const WEEKDAY_WORDS = new Map<
  string,
  { day: number; language: "en" | "fr"; full: boolean }
>();
WEEKDAYS_EN.forEach((word, day) => {
  WEEKDAY_WORDS.set(word, { day, language: "en", full: true });
  WEEKDAY_WORDS.set(word.slice(0, 3), { day, language: "en", full: false });
});
WEEKDAY_WORDS.set("tues", { day: 2, language: "en", full: false });
WEEKDAY_WORDS.set("thur", { day: 4, language: "en", full: false });
WEEKDAY_WORDS.set("thurs", { day: 4, language: "en", full: false });
WEEKDAYS_FR.forEach((word, day) =>
  WEEKDAY_WORDS.set(word, { day, language: "fr", full: true }),
);
const WEEKDAY = `(?:${[...WEEKDAY_WORDS.keys()]
  .sort((a, b) => b.length - a.length)
  .join("|")})`;
/** A weekday, a full stop and a comma, before the date itself. */
const WEEKDAY_BEFORE = `(?:(?<![\\p{L}])${WEEKDAY}\\.?,?[ \\t]+)?`;
const WEEKDAY_PREFIX = new RegExp(`^(${WEEKDAY})(\\.?,?[ \\t]+)`, "iu");
/** A weekday after a date, plain or in brackets: "2026-10-08 (Thursday)". */
const WEEKDAY_AFTER = `(?:[ \\t]*[(,]?[ \\t]*(?<![\\p{L}])${WEEKDAY}(?![\\p{L}])\\.?\\)?)?`;
/** Polish "r." (roku, "of the year") after a date's year: "5 marca 2026 r." is one date. */
const POLISH_YEAR_AFTER = "(?:[ \\t]?r\\.(?![\\p{L}]))?";
// The rules trim a trailing full stop before reading the date ("2026 r").
const POLISH_YEAR_SUFFIX = /(?<=\d)[ \t]?r\.?$/u;
const WEEKDAY_SUFFIX = new RegExp(
  `[ \\t]*[(,]?[ \\t]*(?<![\\p{L}])${WEEKDAY}(?![\\p{L}])\\.?\\)?$`,
  "iu",
);

const pad = (value: number) => String(value).padStart(2, "0");

/** How a date found in the text reads (#72): a whole date with its day, a
 * month and year or a year alone, or a numeric date that could be read two
 * ways. null if it is no date. A weekday before it is ignored. */
type DateReading =
  | { kind: "full"; iso: string; epochDay: number }
  | { kind: "partial"; key: string }
  | { kind: "unclear"; key: string };

function readDateText(text: string, dayFirst: boolean): DateReading | null {
  const dateText = text
    .replace(WEEKDAY_PREFIX, "")
    .replace(WEEKDAY_SUFFIX, "")
    .replace(POLISH_YEAR_SUFFIX, "");
  for (const form of DATE_FORMS) {
    const match = new RegExp(`^${form.pattern}$`, "iu").exec(dateText);
    if (!match) continue;
    const parts = form.read(match, dayFirst);
    if (!parts) return null;
    if (parts.unclear)
      return {
        kind: "unclear",
        key: dateText.toLowerCase().replace(/\s+/g, " "),
      };
    const { year, month, day } = parts;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Not Date.UTC(year, ...), which reads the years 0 to 99 as 1900 to 1999.
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    if (date.getUTCMonth() !== month - 1) return null;
    if (form.partial)
      return {
        kind: "partial",
        key:
          form.partial === "year"
            ? String(year)
            : form.partial === "monthDay"
              ? `md${pad(month)}-${pad(day)}`
              : `${year}-${pad(month)}`,
      };
    return {
      kind: "full",
      iso: `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`,
      epochDay: Math.round(date.getTime() / 86_400_000),
    };
  }
  return null;
}

/** The date read from `text`, as "1961-04-17", or null; an unclear date
 * gives both readings. */
function readDate(text: string, dayFirst: boolean): string[] {
  const dateText = text
    .replace(WEEKDAY_PREFIX, "")
    .replace(POLISH_YEAR_SUFFIX, "");
  for (const form of DATE_FORMS) {
    if (form.partial) continue;
    const match = new RegExp(`^${form.pattern}$`, "iu").exec(dateText);
    if (!match) continue;
    const iso = (parts: { year: number; month: number; day: number }) =>
      `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
    const parts = form.read(match, dayFirst);
    if (!parts) return [];
    const other = parts.unclear ? form.read(match, !dayFirst) : null;
    return other ? [iso(parts), iso(other)] : [iso(parts)];
  }
  return [];
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
// An identity label in capitals is never a word of the name before it: "Pacjentka: WIERZBICKA,
// Zuzanna    PESEL …", "Nombre: Lucía Prueba Sanz    DNI …". "NAM" is left out: it is a given
// name too. Before a comma it is a surname in "SURNAME, Given" ("NIE, Wei"): a label is
// followed by a colon or its value.
const ID_LABEL_WORD =
  "(?:DNI|NIE|NIF|PESEL|CPF|RG|NHC|CNS|MRN|HRN|IPP|RAMQ|OHIP|DOB)(?![\\p{L}'’-]|,)";
const LABEL_PART = `(?!${ID_LABEL_WORD})${NAME_PART}(?![\\p{L}'’-]|[ \\t]*[:#])`;
// Surname first, as lab, imaging and hospital headers have it (#80 review):
// "Okafor, Margaret A.", "OKAFOR, MARGARET", "de la Cruz, Maria".
const SURNAME_FIRST = `(?:${PARTICLE_ANY_CASE}[ \\t]+)*${LABEL_PART},[ \\t]+${LABEL_PART}(?:[ \\t]+${LABEL_PART})?(?:[ \\t]+${UPPER}\\.?(?![\\p{L}]))?`;
// A name as written after a label, in any case ("Avery EXAMPLE", "MARGARET
// OKAFOR").
const AS_WRITTEN = `${LABEL_PART}(?:[ \\t]+(?:${PARTICLE_ANY_CASE}[ \\t]+)*${LABEL_PART}){0,3}`;
// After a label: surname first, or the name as written.
const LABELLED_NAME = `(?:${SURNAME_FIRST}|${AS_WRITTEN})`;
// Initials before a name: "Dr. J. Smith", "cc: Dr. A. Patel" (#80 review).
const INITIALS = `(?:${UPPER}\\.[ \\t]*)*`;
// A clinician after a title or a label: initials and a name, or surname
// first ("Okafor, Margaret").
const CLINICIAN_NAME = `(?:${SURNAME_FIRST}|${INITIALS}${AS_WRITTEN})`;
// Credentials after a name: "Jane Doe, MD", "OKAFOR, MARGARET, NP".
const CREDENTIAL =
  "(?:MD|M\\.D\\.|NP|RN|RPN|FRCPC|FRCSC|CCFP|PhD|Ph\\.D\\.|PharmD|RPh|MSW|RSW)";
// Who wrote, signed or sent a document.
const BY =
  "(?:(?:[Rr]eferred|[Ss]igned|[Cc]o-signed|[Ee]lectronically signed|[Rr]eported|[Dd]ictated|[Tt]ranscribed|[Rr]ecorded|[Dd]ocumented|[Pp]repared|[Cc]hecked|[Aa]rranged|[Ss]upplied|[Rr]eviewed|[Ee]ntered|[Cc]ompleted|[Vv]erified|[Aa]uthored|[Ww]ritten|[Ss]een|[Ee]xamined) by" +
  "|(?:[Rr]éféré|[Ss]igné|[Dd]icté|[Nn]oté|[Oo]rganisé|[Vv]érifié|[Pp]réparé|[Rr]édigé|[Pp]araphé|[Ss]aisi|[Rr]evu|[Cc]omplété|[Tt]ransmis|[Ff]ourni|[Vv]u)e? par" +
  "|(?:[Ff]irmad|[Dd]ictad|[Rr]edactad|[Rr]egistrad|[Pp]reparad|[Rr]evisad|[Ee]laborad)[oa] por" +
  "|(?:[Aa]ssinad|[Dd]itad|[Rr]edigid|[Rr]egistrad|[Pp]reparad|[Rr]evisad)[oa] por" +
  "|(?:[Pp]odpisan[oy]|[Ss]porządzon[oy]|[Pp]rzygotowan[oy]|[Zz]atwierdzon[oy]) przez)";
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
// The dash after a label is an alternation, not a character class: the rules are folded,
// and "[-–—]" would fold to the range "[--—]", which holds every letter ("Patient ABC").
const NAME_LABELS = [
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
  "Claimant",
  "Client",
  "Usager",
  "Usagère",
  "Paciente",
  "Pacjent",
  "Pacjentka",
  "Nombre del paciente",
  "Nome do paciente",
  "Nombre",
  "Nome",
  "Imię i nazwisko",
];
const NAME_LABEL = `${anyCase(NAME_LABELS)}(?:[ \\t]*:|[ \\t]+(?:-|–|—))`;
// A header laid out in columns, with no colon or dash: a label in capitals and a space
// ("PATIENT AVERY SAMPLETON"), or any label and a gap of two spaces or a tab ("Patient
// \tSampleton, Avery") (#252 review). "Re", "Pt" and "Name" alone are too common for it.
const COLUMN_LABELS = NAME_LABELS.filter(
  (label) =>
    !["Re", "Pt", "Name", "Nombre", "Nome", "Contact", "Parent"].includes(
      label,
    ),
);
const COLUMN_LABEL = `(?:(?:${COLUMN_LABELS.map((label) =>
  escapeRegExp(label.toUpperCase()),
).join("|")})[ \\t]+|${anyCase(COLUMN_LABELS)}(?:[ ]{2,}|[ ]*\\t[ \\t]*))`;
// A name in a column: its words joined by single spaces, so the next column ("    MRN …")
// is not taken, and up to two surnames before a comma ("PRUEBA SANZ, LUCÍA").
const COLUMN_NAME = `(?:(?:${PARTICLE_ANY_CASE}[ ])*${LABEL_PART}(?:[ ]${LABEL_PART})?,[ ]${LABEL_PART}(?:[ ]${LABEL_PART})?(?:[ ]${UPPER}\\.?(?![\\p{L}]))?|${LABEL_PART}(?:[ ](?:${PARTICLE_ANY_CASE}[ ])*${LABEL_PART}){0,3})`;
/** Labels as written and with only their first word capitalised, as a sentence starts:
 * "Ratownik medyczny Piotr Testowy", "Médico de familia …". */
const withSentenceCase = (labels: string[]) =>
  labels.flatMap((label) => [label, label[0].toUpperCase() + label.slice(1)]);
// A Spanish or Portuguese role before a name. After an article or a determiner the role may
// be in any case ("La Médica Inés …"); after a bare preposition only in lower case, since
// "Licencia por Médica Laboral Temporal" is a heading, not a doctor (#271 review).
const ES_PT_ARTICLE = `(?:[Ee]l|[Ll]a|[Ll]os|[Ll]as|[Uu]n|[Uu]na|[Dd]el|[Aa]l|[Ss]u|[Ss]us|[Oo]|[Aa]|[Oo]s|[Aa]s|[Uu]m|[Uu]ma|[Dd]o|[Dd]a|[Dd]os|[Dd]as|[Pp]elo|[Pp]ela|[Aa]o|à|[Ss]eu|[Ss]ua)`;
const ES_PT_PREPOSITION = `(?:[Pp]or|[Cc]on|[Pp]ara|[Cc]om|[Ss]in|[Ss]em)`;
const esPtRole = (roles: string[]) =>
  `(?:(?<=(?<![\\p{L}])${ES_PT_ARTICLE}[ \\t]+)${anyCase(withSentenceCase(roles))}|(?<=(?<![\\p{L}])${ES_PT_PREPOSITION}[ \\t]+)(?:${[
    ...roles,
  ]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")}))`;
// A Polish qualifier between a role and the name: "Pielęgniarka oddziałowa Maria Testowa",
// "Lekarz prowadzący Jan Przykładny" (#271 review).
const PL_ROLE_QUALIFIER = `(?:[ \\t]+(?:oddziałowa|oddziałowy|naczelna|naczelny|zabiegowa|zabiegowy|dyplomowana|dyplomowany|koordynująca|koordynujący|prowadząca|prowadzący))?`;
// Status words a flowsheet writes after "Patient" in a column: "PATIENT  REFUSED
// MEDICATION", "Patient\tDischarged home.", "PACIENTE  ESTABLE" are no names (#252 review).
const STATUS_WORDS = new Set(
  foldAll([
    "stable",
    "comfortable",
    "refused",
    "refuses",
    "refusing",
    "tolerated",
    "tolerates",
    "tolerating",
    "discharged",
    "improved",
    "improving",
    "alert",
    "awake",
    "asleep",
    "oriented",
    "ambulating",
    "ambulatory",
    "resting",
    "sleeping",
    "eating",
    "afebrile",
    "seen",
    "assessed",
    "transferred",
    "admitted",
    "declined",
    "declines",
    "agreed",
    "agrees",
    "consented",
    "verbalized",
    "verbalizes",
    "reports",
    "reported",
    "states",
    "stated",
    "denies",
    "denied",
    "complains",
    "feels",
    "feeling",
    "doing",
    "ate",
    "voided",
    "calm",
    "anxious",
    "agitated",
    "confused",
    "cooperative",
    "independent",
    "mobile",
    "sitting",
    "lying",
    "ready",
    "unchanged",
    "deteriorating",
    "critical",
    "fair",
    "good",
    "well",
    "unwell",
    "deceased",
    "expired",
    "left",
    "returned",
    "went",
    "tired",
    "weak",
    "nauseous",
    "drowsy",
    "settled",
    "confortable",
    "refuse",
    "refusé",
    "tolère",
    "toléré",
    "sorti",
    "sortie",
    "amélioré",
    "alerte",
    "éveillé",
    "éveillée",
    "orienté",
    "orientée",
    "calme",
    "conscient",
    "consciente",
    "collaborant",
    "dort",
    "repose",
    "mange",
    "estable",
    "cómodo",
    "cómoda",
    "rechaza",
    "rechazó",
    "tolera",
    "toleró",
    "mejorado",
    "mejorada",
    "mejor",
    "alerta",
    "despierto",
    "despierta",
    "orientado",
    "orientada",
    "tranquilo",
    "tranquila",
    "colaborador",
    "colaboradora",
    "duerme",
    "descansa",
    "come",
    "estável",
    "confortável",
    "recusa",
    "recusou",
    "tolerou",
    "melhorado",
    "melhorada",
    "acordado",
    "acordada",
    "calmo",
    "calma",
    "colaborativo",
    "dorme",
    "stabilny",
    "stabilna",
    "stabilnie",
    "komfortowo",
    "odmawia",
    "odmówił",
    "odmówiła",
    "toleruje",
    "wypisany",
    "wypisana",
    "lepiej",
    "przytomny",
    "przytomna",
    "zorientowany",
    "zorientowana",
    "spokojny",
    "spokojna",
    "śpi",
    "odpoczywa",
    "je",
  ]).map((word) => word.toLowerCase()),
);
// Words of a section heading after such a label: "PATIENT INFORMATION" is no name.
const HEADER_WORDS = new Set(
  foldAll([
    "information",
    "informations",
    "history",
    "summary",
    "details",
    "detail",
    "instructions",
    "education",
    "services",
    "service",
    "name",
    "number",
    "id",
    "consent",
    "label",
    "record",
    "chart",
    "care",
    "portal",
    "list",
    "copy",
    "file",
    "note",
    "notes",
    "report",
    "profile",
    "data",
    "demographics",
    "identification",
    "identifiant",
    "nom",
    "prénom",
    "número",
    "numer",
    "datos",
    "dados",
    "dane",
    "historia",
    "informacje",
    "información",
    "informação",
    "résumé",
    "sommaire",
    "safety",
    "satisfaction",
    "survey",
    "questionnaire",
    "rights",
    "copie",
  ]).map((word) => word.toLowerCase()),
);
// Other clinicians' titles, in any case and longest first, so "Nurse
// Practitioner:" is one title, not "Nurse" before a name (#80 review).
const CLINICIAN_TITLE = anyCase([
  "Charge nurse",
  "Triage nurse",
  "Night nurse",
  "Staff nurse",
  "Nurse practitioner",
  "Pharmacy technician",
  "Technologist",
  "Technician",
  "Sonographer",
  "Radiologist",
  "Surgeon",
  "Anesthesiologist",
  "Paramedic",
  "Respiratory therapist",
  "Therapist",
  "Care coordinator",
  "Case manager",
  "Support worker",
  "Resident",
  "Physio",
  "Infirmière clinicienne",
  "Infirmière auxiliaire",
  "Radiologiste",
  "Chirurgien",
  "Chirurgienne",
  "Technologue",
  "Technicien",
  "Technicienne",
  "Manipulatrice",
  "Manipulateur",
  "Préposée",
  "Préposé",
  "Paramédic",
  "Résident",
  "Résidente",
  "Enfermera",
  "Enfermero",
  "Enfermera de enlace",
  "Farmacéutica",
  "Farmacéutico",
  "Fisioterapeuta",
  "Trabajadora social",
  "Trabajador social",
  "Enfermeira",
  "Enfermeiro",
  "Farmacêutica",
  "Farmacêutico",
  "Assistente social",
  "Pielęgniarka",
  "Pielęgniarz",
  "Farmaceuta",
  "Fizjoterapeuta",
  "Pracownik socjalny",
  "Pracowniczka socjalna",
  "Registered nurse",
  "Nurse",
  "Dietitian",
  "Dietician",
  "Pharmacist",
  "Physiotherapist",
  "Physical therapist",
  "Occupational therapist",
  "Social worker",
  "Midwife",
  "Infirmière praticienne spécialisée",
  "Infirmière praticienne",
  "Infirmier praticien",
  "Infirmière",
  "Infirmier",
  "Pharmacienne",
  "Pharmacien",
  "Physiothérapeute",
  "Ergothérapeute",
  "Nutritionniste",
  "Diététiste",
  "Travailleuse sociale",
  "Travailleur social",
  "Sage-femme",
]);

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
// The town after a street address's comma: "77 Placeholder Crescent, Sampletown". Not a title or a
// unit word.
const TOWN_AFTER = `(?:,[ \\t]*(?!(?:Dr|Dre|Mr|Mrs|Ms|Mme|Mlle|Suite|Unit|Apt|App|Bureau|Local)\\b)${NAME_WORD}(?:[ -]${NAME_WORD}){0,3}(?:,?[ \\t]+${PROVINCES}\\b)?)?`;
// A unit written before the street: "Unit 6B, 217 Street Crescent", "Appartement 6B, 217 rue …".
const UNIT_FIRST = `(?:(?:Unit|Apt\\.?|Apartment|Suite|Ste\\.?|Appartement|App\\.?|Bureau|Local|Unidad|Apto\\.?|Sala|#)[ \\t]*[\\w-]+,[ \\t]*)?`;
const UNIT = `(?:,?[ \\t]*(?:Unit|Apt\\.?|Apartment|Suite|app\\.?|apt\\.?|appartement|bureau|unité|local|#)[ \\t]*[\\w-]+)?`;
// In any case: a hospital's header is often in capitals (#80 review).
const CLINIC_WORDS = anyCase([
  "Community Health Centre",
  "Community Health Center",
  "Family Health Team",
  "Health Team",
  "Family Practice",
  "Walk-in Clinic",
  "Urgent Care Centre",
  "Urgent Care",
  "FHT",
  "Institute",
  "Foundation",
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
  "Public School",
  "Elementary School",
  "Secondary School",
  "High School",
  "Middle School",
  "School",
  "Academy",
  "Daycare",
]);
// Words that name a clinic or an agency with no clinic word, after "at", "to", "from", "with"
// or "by": "Silver Acorn Neurology", "Blue Compass Health", "Harbourview Family Services".
const ORG_WORDS = `(?:${[
  "Health",
  "Wellness",
  "Neurology",
  "Cardiology",
  "Dermatology",
  "Radiology",
  "Physiotherapy",
  "Physio",
  "Rehabilitation",
  "Rehab",
  "Pediatrics",
  "Paediatrics",
  "Orthopaedics",
  "Orthopedics",
  "Ophthalmology",
  "Optometry",
  "Eye Care",
  "Dentistry",
  "Dental",
  "Audiology",
  "Counselling",
  "Counseling",
  "Psychology",
  "Psychiatry",
  "Oncology",
  "Endocrinology",
  "Gastroenterology",
  "Urology",
  "Nephrology",
  "Respirology",
  "Rheumatology",
  "Fertility",
  "Midwifery",
  "Chiropractic",
  "Podiatry",
  "Home Care",
  "Care",
  "Services",
  "Society",
  "Association",
  "Agency",
  "Outreach",
  "Associates",
  "Partners",
].join("|")})(?:[ \\t]+(?:Centre|Center|Clinic|Group|Services|Associates))?`;
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
  "health",
  "public",
  "mental",
  "primary",
  "home",
  "oral",
  "occupational",
  "pediatric",
  "paediatric",
  "adult",
  "geriatric",
  "senior",
  "seniors",
  "youth",
  "child",
  "children's",
  "women's",
  "sports",
  "social",
  "support",
  "care",
  "services",
  "wellness",
  "dental",
  "eye",
  "sleep",
  "pain",
  "memory",
  "cancer",
  "diabetes",
  "heart",
  "stroke",
  "emergency",
  "outpatient",
  "inpatient",
  "addiction",
  "addictions",
  "palliative",
  "neurology",
  "cardiology",
  "dermatology",
  "radiology",
  "imaging",
  "physiotherapy",
  "physio",
  "rehabilitation",
  "rehab",
  "oncology",
  "psychiatry",
  "psychology",
  "pediatrics",
  "paediatrics",
  "counselling",
  "counseling",
  "high",
  "elementary",
  "secondary",
  "middle",
  "nursing",
  "sunday",
  "summer",
  // Articles and French clinic words, as the folded text has them: "La Santé
  // publique" is not a clinic called "La".
  "la",
  "le",
  "les",
  "l'",
  "un",
  "une",
  "des",
  "du",
  "de",
  "a",
  "an",
  "sante",
  "medical",
  "medicale",
  "imagerie",
  "radiologie",
  "dentaire",
  "readaptation",
  "physiotherapie",
  "optometrie",
  // Document words, folded: "Rapport Médical", "Informe Médico", "Laudo de Imagem" and
  // "Karta Informacyjna" are headings, not clinics (#249 review).
  "rapport",
  "certificat",
  "dossier",
  "examen",
  "bilan",
  "suivi",
  "compte",
  "rendu",
  "resume",
  "formulaire",
  "demande",
  "ordonnance",
  "consultation",
  "attestation",
  "note",
  "lettre",
  "avis",
  "protocole",
  "requete",
  "prescription",
  "evaluation",
  "synthese",
  "feuille",
  "fiche",
  "informe",
  "certificado",
  "historia",
  "expediente",
  "resumen",
  "solicitud",
  "receta",
  "consulta",
  "nota",
  "carta",
  "evaluacion",
  "hoja",
  "ficha",
  "analisis",
  "estudio",
  "seguimiento",
  "parte",
  "relatorio",
  "laudo",
  "atestado",
  "prontuario",
  "resumo",
  "pedido",
  "receita",
  "avaliacao",
  "exame",
  "encaminhamento",
  "solicitacao",
  "guia",
  "raport",
  "zaswiadczenie",
  "skierowanie",
  "karta",
  "wypis",
  "opis",
  "wynik",
  "wyniki",
  "badanie",
  "recepta",
  "notatka",
  "ocena",
  "konsultacja",
]);
// Profile-name words that are also ordinary words: removed only as part of
// the whole name.
const ORDINARY_WORDS = new Set(
  foldAll([
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
  ]),
);
// Words that follow a label or a family word but start no name: "Re:
// Follow-up visit", "Patient: Seen today", "Contact: Mother …".
// A treatment or a program ends a phrase that is not a person: "a therapist Cognitive
// Behavioural Therapy". Folded, as the text the rules read is (#228 review).
const TREATMENT_WORDS = new Set(
  foldAll([
    "therapy",
    "therapies",
    "thérapie",
    "terapia",
    "terapii",
    "treatment",
    "traitement",
    "tratamiento",
    "tratamento",
    "session",
    "sessions",
    "assessment",
    "évaluation",
    "program",
    "programme",
    "programa",
  ]),
);
// A place or a team after a person's name ends the name: "Maria Lopez Unit 4B".
const PLACE_WORDS = new Set(
  foldAll([
    "clinic",
    "clinique",
    "clínica",
    "service",
    "services",
    "unit",
    "unité",
    "team",
    "équipe",
    "group",
    "groupe",
    "grupo",
    "centre",
    "center",
    "centro",
  ]),
);
const NOT_NAMES = new Set(
  foldAll([
    "kierujący",
    "kierująca",
    "oddziału",
    "elektroradiologii",
    "medycznej",
    "medyczny",
    "medyczna",
    "oddziałowa",
    "oddziałowy",
    "naczelna",
    "naczelny",
    "zabiegowa",
    "zabiegowy",
    "dyplomowana",
    "dyplomowany",
    "superior",
    "sanitario",
    "especialista",
    "residente",
    "adjunto",
    "adjunta",
    "jefe",
    "jefa",
    "responsable",
    "responsável",
    "prowadzący",
    "prowadząca",
    "dyżurny",
    "dyżurna",
    "cpf",
    "dni",
    "nie",
    "nif",
    "pesel",
    "rg",
    "cns",
    "nhc",
    "tsi",
    "cip",
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
    // What follows "Patient:" or "RE:" when it is no name.
    "stable",
    "unchanged",
    "improving",
    "improved",
    "worsening",
    "follow",
    "pending",
    "doing",
    "no",
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
  ]),
);

/** Relationship words and the like that a vault name may be made of, never
 * used alone ("Mom", "Me"). */
const RELATIONSHIP_WORDS = new Set(
  foldAll([
    "me",
    "mom",
    "mum",
    "dad",
    "mother",
    "father",
    "son",
    "daughter",
    "wife",
    "husband",
    "spouse",
    "partner",
    "brother",
    "sister",
    "grandma",
    "grandpa",
    "nana",
    "papa",
    "baby",
    "moi",
    "maman",
    "papa",
    "mère",
    "père",
    "fils",
    "fille",
    "conjoint",
    "conjointe",
  ]),
);
const HAN = /\p{Script=Han}/u;
/** The words of a name worth finding alone: three letters or more (two
 * characters or more in Han script), and neither a surname particle nor an
 * ordinary or relationship word; a hyphenated surname's parts too, and a
 * surname without its d'. */
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
      if (HAN.test(bare)) {
        // A Han name has no spaces: its given name is any run of two or
        // more of its characters ("小明" in "王小明").
        const characters = [...bare];
        for (let from = 0; from < characters.length; from += 1)
          for (let to = from + 2; to <= characters.length; to += 1)
            words.add(characters.slice(from, to).join(""));
        continue;
      }
      if (
        bare.length >= 3 &&
        !PARTICLES.has(lower) &&
        !ORDINARY_WORDS.has(lower) &&
        !RELATIONSHIP_WORDS.has(lower)
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
  /** Relational prose can also introduce a disease: flag that conflict. */
  reviewClinicalConflict?: true;
  upperPrefix?: true;
  /** A value that reads as a whole date is a date, not this record number. */
  skipDates?: true;
  /** A name after a family word: a relative, who may share the patient's
   * surname without being the patient. */
  kin?: true;
  /** A day and a month: not when the month is the lower-case word "may"
   * ("may 5 mg"). */
  notLowerCaseMay?: true;
  /** "Mother: First Last": refused in a family-history line or section. */
  relationLabel?: true;
  /** A name with no person cue (a header line, a care verb): refused for any non-name word. */
  uncued?: true;
  /** A header line's name: kept only as "SURNAME, Given" (see find()). */
  uncuedHeader?: true;
  /** A name in a header's column: refused for a section heading ("PATIENT INFORMATION"). */
  columnLabel?: true;
  /** A town in brackets: refused for a bracket note or a medical word. */
  townInBrackets?: true;
}

const HEALTH_CARD_LABEL =
  "(?:[Hh]ealth [Cc]ard(?: [Nn]umber| [Nn]o\\.?| #)?|[Hh]ealth (?:[Ii]nsurance )?[Nn]umber|HCN|PHN|OHIP|RAMQ|MSP|AHCIP|NAM|[Hh]ealth #|[Cc]arte d'assurance maladie|[Nn]uméro d'assurance maladie)";
// Digit groups with an optional two-letter version code, or Quebec's form:
// nothing after them on the line is taken.
const HEALTH_CARD_VALUE =
  "(?:[A-Z]{4}[ -]?\\d{4}[ -]?\\d{4}|(?:\\d{4,5}[ -]?\\d{3,4}[ -]?\\d{3,4}|\\d{8,12})(?:[ -]?[A-Z]{2}(?![\\p{L}]))?)";

// Plural family words, for relatives named together.
const KIN_PLURAL_WORDS = anyCase([
  "daughters",
  "sons",
  "sisters",
  "brothers",
  "children",
  "parents",
  "grandchildren",
  "filles",
  "fils",
  "sœurs",
  "frères",
  "enfants",
  "hijos",
  "hijas",
  "hermanos",
  "hermanas",
  "filhos",
  "filhas",
  "irmãos",
  "irmãs",
  "córki",
  "synowie",
  "dzieci",
]);
// "kids" in lower case only: "Kids Help Phone" is a service.
const KIN_PLURAL = `(?:${KIN_PLURAL_WORDS}|kids)`;
// Between names in a list: "Maribel and Odette", "Paul, Marc et Luc".
const NAME_JOIN =
  "(?:[ \\t]*,[ \\t]*(?:(?:and|et|y|e|i)[ \\t]+)?|[ \\t]+(?:and|et|y|e|i)[ \\t]+)";
// Specialties and services a town in brackets can follow: "Cardiologie (Ville-Exemple)".
const SPECIALTY_BEFORE_TOWN = anyCase([
  "cardiologie",
  "neurologie",
  "pédiatrie",
  "radiologie",
  "imagerie",
  "dermatologie",
  "orthopédie",
  "ophtalmologie",
  "oncologie",
  "gériatrie",
  "psychiatrie",
  "gynécologie",
  "obstétrique",
  "urologie",
  "néphrologie",
  "pneumologie",
  "gastro-entérologie",
  "endocrinologie",
  "rhumatologie",
  "physiothérapie",
  "ergothérapie",
  "médecine interne",
  "médecine familiale",
  "chirurgie",
  "urgence",
  "clinique",
  "CLSC",
  "GMF",
  "cardiology",
  "neurology",
  "pediatrics",
  "paediatrics",
  "radiology",
  "imaging",
  "dermatology",
  "orthopaedics",
  "orthopedics",
  "ophthalmology",
  "oncology",
  "geriatrics",
  "psychiatry",
  "gynecology",
  "obstetrics",
  "urology",
  "nephrology",
  "respirology",
  "gastroenterology",
  "endocrinology",
  "rheumatology",
  "physiotherapy",
  "internal medicine",
  "family medicine",
  "surgery",
  "emergency",
  "clinic",
  "cardiologue",
  "neurologue",
  "pédiatre",
  "radiologiste",
  "radiologue",
  "dermatologue",
  "orthopédiste",
  "ophtalmologiste",
  "ophtalmologue",
  "oncologue",
  "gériatre",
  "psychiatre",
  "gynécologue",
  "obstétricien",
  "obstétricienne",
  "urologue",
  "néphrologue",
  "pneumologue",
  "gastro-entérologue",
  "endocrinologue",
  "rhumatologue",
  "physiatre",
  "interniste",
  "chirurgien",
  "chirurgienne",
  "omnipraticien",
  "omnipraticienne",
  "médecin de famille",
  "médecin",
  "infirmière praticienne",
  "physiothérapeute",
  "ergothérapeute",
  "physiatrie",
  "médecine du sport",
  "cardiologist",
  "neurologist",
  "pediatrician",
  "paediatrician",
  "radiologist",
  "dermatologist",
  "orthopaedic surgeon",
  "orthopedic surgeon",
  "ophthalmologist",
  "oncologist",
  "geriatrician",
  "psychiatrist",
  "gynecologist",
  "obstetrician",
  "urologist",
  "nephrologist",
  "respirologist",
  "gastroenterologist",
  "endocrinologist",
  "rheumatologist",
  "physiatrist",
  "internist",
  "surgeon",
  "family physician",
  "nurse practitioner",
]);
// Notes written in brackets after a specialty: never a town.
const BRACKET_NOTES = new Set(
  foldAll([
    "urgent",
    "urgente",
    "suivi",
    "externe",
    "interne",
    "adulte",
    "adultes",
    "pédiatrique",
    "enfant",
    "enfants",
    "nouveau",
    "nouvelle",
    "demande",
    "priorité",
    "priority",
    "new",
    "adult",
    "pediatric",
    "paediatric",
    "outpatient",
    "inpatient",
    "routine",
    "semi-urgent",
    "virtual",
    "virtuel",
    "virtuelle",
    "phone",
    "téléphone",
    "telephone",
    "video",
    "vidéo",
    "pending",
    "en attente",
    "annulé",
    "cancelled",
    "canceled",
    "externa",
    "externo",
    "interna",
    "interno",
    "urgente",
    "consulta",
    "seguimiento",
    "control",
    "nueva",
    "nuevo",
    "retorno",
    "primera",
    "primeira",
    "revisión",
    "revisão",
    "telefónica",
    "presencial",
    "pilne",
    "kontrola",
    // Hospital units and specialties: "en Medicina Interna (Planta)" is not a town.
    "medicina",
    "cardiología",
    "cardiologia",
    "neurología",
    "neurologia",
    "pediatría",
    "pediatria",
    "urgencias",
    "urgencia",
    "cirugía",
    "cirurgia",
    "enfermería",
    "enfermagem",
    "consultorio",
    "consultório",
    "planta",
    "piso",
    "sala",
    "andar",
    "box",
    "cama",
    "unidad",
    "unidade",
    "servicio",
    "serviço",
    "oddział",
    "poradnia",
    "clínica",
    "hospital",
    "domu",
    "dom",
    "pomocy",
    "społecznej",
    "opieki",
    "szpitalu",
    "szpitala",
    "przychodni",
  ]).map((word) => word.toLowerCase()),
);
// Words of a family-history line, never a relative's name after "Mother:": "Mother: Breast
// cancer at 52", "Father: Atrial Fibrillation". A list cannot hold every disease, so a word
// with a medical ending ("Sclerosis", "Fibrillation", "Carcinoma") counts too (#228 review).
const FAMILY_HISTORY_WORDS = new Set(
  foldAll([
    "Mother:",
    "alive",
    "deceased",
    "unknown",
    "healthy",
    "well",
    "none",
    "adopted",
    "living",
    "died",
    "passed",
    "cancer",
    "breast",
    "colon",
    "colorectal",
    "prostate",
    "ovarian",
    "lung",
    "skin",
    "pancreatic",
    "thyroid",
    "heart",
    "cardiac",
    "coronary",
    "artery",
    "disease",
    "diabetes",
    "type",
    "stroke",
    "dementia",
    "hypertension",
    "high",
    "kidney",
    "renal",
    "liver",
    "asthma",
    "arthritis",
    "depression",
    "anxiety",
    "bipolar",
    "epilepsy",
    "glaucoma",
    "osteoporosis",
    "leukemia",
    "lymphoma",
    "melanoma",
    "MI",
    "CAD",
    "CHF",
    "COPD",
    "HTN",
    "DM",
    "CKD",
    "CVA",
    "TIA",
    "décédé",
    "décédée",
    "vivant",
    "vivante",
    "inconnu",
    "diabète",
    "fallecido",
    "fallecida",
    "falecido",
    "falecida",
    "zmarły",
    "zmarła",
    "sudden",
    "death",
    "multiple",
    "atrial",
    "attack",
    "arrest",
    "disorder",
    "syndrome",
    "seizure",
    "seizures",
    "suicide",
    "overdose",
    "alcohol",
    "addiction",
    "blood",
    "pressure",
    "cholesterol",
    "sugar",
    "early",
    "late",
    "onset",
    "natural",
    "causes",
    "old",
    "age",
    "accident",
    "aneurysm",
    "embolism",
    "eczema",
    "lupus",
    "gout",
    "migraine",
    "migraines",
    "pulmonary",
    "hepatic",
    "macular",
    "sickle",
    "cell",
    "cystic",
    "celiac",
    "hearing",
    "loss",
    "vision",
    "blind",
    "deaf",
    "mental",
    "cerebral",
    "palsy",
    "cleft",
    "schizophrenia",
    "autism",
    "adhd",
    "ms",
    "als",
    "bph",
    "gerd",
    "ibs",
    "ibd",
    "nil",
    "n/a",
    "aortic",
    "valve",
    "bowel",
    "brain",
    "bone",
    "clot",
    "clots",
    "failure",
    "embolism",
    "alcoholism",
    "illness",
    "sickness",
    "blindness",
    "deafness",
    "weakness",
    "obesity",
    "disability",
  ]).map((word) => word.toLowerCase()),
);
const MEDICAL_ENDING =
  /(?:osis|itis|emia|aemia|noma|coma|rcoma|pathy|ectomy|plasia|algia|ation|ition|ciency|philia|plegia|trophy)$/u;
const FAMILY_HISTORY_HEADING =
  /(?:family history|family hx|\bfhx\b|\bfh\b[ \t]*:|antecedents familiaux|histoire familiale|historia familiar|antecedentes familiares|historico familiar|wywiad rodzinny)/iu;
/** In a family-history section: the nearest heading above, within the same block of lines
 * (a blank line or a heading alone on its line, such as "Emergency contact:", ends it), or
 * on the same line, is a family-history heading. */
function inFamilyHistory(text: string, at: number): boolean {
  const lines = text.slice(Math.max(0, at - 400), at).split("\n");
  if (FAMILY_HISTORY_HEADING.test(lines[lines.length - 1])) return true;
  for (let k = lines.length - 2; k >= 0; k--) {
    const line = lines[k].trim();
    if (line === "") return false;
    if (FAMILY_HISTORY_HEADING.test(line)) return true;
    if (/^[^:]{1,40}:$/u.test(line)) return false;
  }
  return false;
}
function familyHistoryLabel(text: string, at: number, name: string): boolean {
  if (inFamilyHistory(text, at)) return true;
  const words = name
    .split(/[ \t]+/u)
    .map((word) => word.toLowerCase().replace(/[.,;:]+$/u, ""));
  return (
    words.some(
      (word) => FAMILY_HISTORY_WORDS.has(word) || MEDICAL_ENDING.test(word),
    ) ||
    // "Sudden Death" is two ordinary words; "Rose Baker" is a person.
    words.every((word) => ORDINARY_WORDS.has(word))
  );
}
// A heading that ends in a document word, before the patient's name: "Discharge letter: Wren
// Halloway", "Plan de soins pour …", "Karta informacyjna — …" (uncued names, design note 2).
const DOCUMENT_HEADING = `(?:[\\p{L}'’-]+[ \\t]+){0,4}${anyCase(
  withSentenceCase([
    "note",
    "notes",
    "letter",
    "summary",
    "report",
    "plan",
    "care plan",
    "review",
    "referral",
    "consultation",
    "assessment",
    "discharge",
    "consult",
    "lettre",
    "compte rendu",
    "rapport",
    "résumé",
    "sommaire",
    "plan de soins",
    "bilan",
    "note de suivi",
    "demande",
    "informe",
    "informe de alta",
    "resumen",
    "carta",
    "plan de cuidados",
    "nota",
    "valoración",
    "resumo",
    "resumo de alta",
    "relatório",
    "plano de cuidados",
    "nota de alta",
    "avaliação",
    "encaminhamento",
    "karta informacyjna",
    "plan opieki",
    "wypis",
    "skierowanie",
    "notatka",
    "epikryza",
    "opinia",
  ]),
)}(?:[ \\t]+(?:de|du|des|d['’]|of|da|do|z)[ \\t]*[\\p{L}'’-]+)?`;
// Care verbs that take a person, not a thing: "Paramedics brought …", "ont amené …",
// "trajo a …". Not received, transferred, saw: they take a vaccine or a unit as often (#264).
const CARE_VERB = anyCase(
  withSentenceCase([
    "brought",
    "accompanied",
    "asked to see",
    "amené",
    "amenée",
    "ont amené",
    "a amené",
    "a accompagné",
    "trajo a",
    "trajeron a",
    "acompañó a",
    "trouxe",
    "trouxeram",
    "acompanhou",
    "przywiózł",
    "przywiozła",
    "przywieźli",
  ]),
);
// Words that are never part of an uncued name: a side, a body part, a wound, a time word, a
// severity or a course ("Wypis: ZAWAŁ, Ostry", "Informe de alta: ICTUS, Isquémico",
// "PNEUMONIA, Resolving"). Whole words, not endings: given names end like participles too
// (Mohammed, René, José, Margarida, Mário, Xiaoming), and a wrong refusal leaks a name.
const UNCUED_NOT_NAME_WORDS = new Set(
  foldAll([
    "unit",
    "oddział",
    "oddziału",
    "oddziale",
    "unité",
    "unidad",
    "unidade",
    "medicina",
    "médecine",
    "atención",
    "atenção",
    "primaria",
    "primária",
    "zapalenie",
    "zapalenia",
    "pronto",
    "ambulatório",
    "ambulatorio",
    "enfermaria",
    "uti",
    "uci",
    "urgência",
    "urgências",
    "urgencia",
    "urgencias",
    // Conditions, for "FRACTURE, Displaced" and "UDAR, Niedokrwienny". Words that are also
    // names are left out (Rana, Guz, Fall, Pain).
    "fracture",
    "angina",
    "pneumonia",
    "sepsis",
    "infection",
    "ulcer",
    "abscess",
    "anemia",
    "anaemia",
    "fever",
    "syncope",
    "delirium",
    "infarction",
    "thrombosis",
    "hernia",
    "tumour",
    "tumor",
    "lesion",
    "wound",
    "injury",
    "sprain",
    "dislocation",
    "obstruction",
    "haemorrhage",
    "hemorrhage",
    "effusion",
    "edema",
    "oedema",
    "cough",
    "dehydration",
    "arrhythmia",
    "fibrillation",
    "contusion",
    "laceration",
    "angine",
    "pneumonie",
    "pneumopathie",
    "ulcère",
    "abcès",
    "anémie",
    "fièvre",
    "chute",
    "infarctus",
    "embolie",
    "thrombose",
    "hernie",
    "tumeur",
    "lésion",
    "plaie",
    "brûlure",
    "entorse",
    "luxation",
    "occlusion",
    "hémorragie",
    "épanchement",
    "œdème",
    "insuffisance",
    "arythmie",
    "fractura",
    "neumonía",
    "infección",
    "úlcera",
    "absceso",
    "fiebre",
    "caída",
    "síncope",
    "infarto",
    "ictus",
    "embolia",
    "trombosis",
    "lesión",
    "herida",
    "quemadura",
    "esguince",
    "luxación",
    "obstrucción",
    "hemorragia",
    "derrame",
    "insuficiencia",
    "arritmia",
    "fibrilación",
    "contusión",
    "fratura",
    "sepse",
    "infecção",
    "abscesso",
    "febre",
    "queda",
    "trombose",
    "hérnia",
    "lesão",
    "ferida",
    "queimadura",
    "luxação",
    "obstrução",
    "insuficiência",
    "fibrilação",
    "contusão",
    "złamanie",
    "dławica",
    "posocznica",
    "sepsa",
    "zakażenie",
    "infekcja",
    "wrzód",
    "ropień",
    "niedokrwistość",
    "gorączka",
    "upadek",
    "omdlenie",
    "zawał",
    "udar",
    "zakrzepica",
    "przepuklina",
    "nowotwór",
    "oparzenie",
    "skręcenie",
    "zwichnięcie",
    "niedrożność",
    "krwotok",
    "krwawienie",
    "obrzęk",
    "niewydolność",
    "arytmia",
    "migotanie",
    "stłuczenie",
    "resolving",
    "resolved",
    "healing",
    "healed",
    "improving",
    "improved",
    "worsening",
    "worsened",
    "recovering",
    "recovered",
    "ongoing",
    "treated",
    "untreated",
    "complicated",
    "uncomplicated",
    "suspected",
    "confirmed",
    "community-acquired",
    "acquired",
    "résolue",
    "résolu",
    "guérie",
    "guéri",
    "consolidée",
    "consolidé",
    "stabilisée",
    "stabilisé",
    "traitée",
    "traité",
    "compliquée",
    "compliqué",
    "améliorée",
    "amélioré",
    "aggravée",
    "aggravé",
    "communautaire",
    "suspectée",
    "confirmée",
    "resuelta",
    "resuelto",
    "resolvida",
    "resolvido",
    "curada",
    "curado",
    "estabilizada",
    "estabilizado",
    "tratada",
    "tratado",
    "complicada",
    "complicado",
    "mejorada",
    "mejorado",
    "melhorada",
    "melhorado",
    "consolidada",
    "consolidado",
    "controlada",
    "controlado",
    "adquirida",
    "adquirido",
    "comunitaria",
    "comunitario",
    "comunitária",
    "comunitário",
    "sospechada",
    "confirmada",
    "confirmado",
    "wyleczony",
    "wyleczona",
    "wyleczone",
    "zagojony",
    "zagojona",
    "leczony",
    "leczona",
    "powikłany",
    "powikłana",
    "pozaszpitalne",
    "pozaszpitalny",
    "pozaszpitalna",
    "ustępujący",
    "ustępująca",
    "ustępujące",
    "acute",
    "chronic",
    "severe",
    "mild",
    "moderate",
    "recurrent",
    "uncontrolled",
    "unspecified",
    "aigu",
    "aiguë",
    "chronique",
    "sévère",
    "léger",
    "légère",
    "modéré",
    "modérée",
    "agudo",
    "aguda",
    "crónico",
    "crónica",
    "crônico",
    "crônica",
    "grave",
    "leve",
    "moderado",
    "moderada",
    "severo",
    "severa",
    "recurrente",
    "recorrente",
    "isquémico",
    "isquémica",
    "isquêmico",
    "isquêmica",
    "hemorrágico",
    "hemorrágica",
    "ostry",
    "ostra",
    "ostre",
    "przewlekły",
    "przewlekła",
    "przewlekłe",
    "ciężki",
    "ciężka",
    "łagodny",
    "łagodna",
    "umiarkowany",
    "umiarkowana",
    "left",
    "right",
    "bilateral",
    "knee",
    "hip",
    "shoulder",
    "back",
    "chest",
    "neck",
    "arm",
    "leg",
    "wrist",
    "ankle",
    "elbow",
    "eye",
    "ear",
    "gauche",
    "droite",
    "genou",
    "hanche",
    "épaule",
    "izquierda",
    "izquierdo",
    "derecha",
    "derecho",
    "rodilla",
    "cadera",
    "esquerda",
    "esquerdo",
    "direita",
    "direito",
    "joelho",
    "quadril",
    "lewa",
    "lewe",
    "lewy",
    "prawa",
    "prawe",
    "prawy",
    "kolano",
    "biodro",
    "bark",
    "injury",
    "wound",
    "ulcer",
    "pressure",
    "type",
    "follow",
    "up",
    "week",
    "month",
    "year",
    "insuffisance",
    "insuficiencia",
    "insuficiência",
    "cardiaque",
    "cardíaca",
    "cardíaco",
    "rénale",
    "hépatique",
    "pulmonaire",
    "respiratoire",
    "respiratória",
    "respiratorio",
    "plaie",
    "úlcera",
    "ulcère",
    "escarre",
    "chute",
    "caída",
    "queda",
    "douleur",
    "dolor",
    "ból",
    "niewydolność",
    "serca",
    "nerek",
    "cukrzyca",
    "odleżyna",
    "upadek",
    "diabète",
    "diabetes",
    "home",
    "medications",
    "medication",
    "meds",
    "results",
    "records",
    "papers",
    "documents",
    "exams",
    "exames",
    "anteriores",
    "previous",
    "old",
    "wyniki",
    "badań",
    "dokumentację",
    "dokumentacja",
    "leki",
    "médicaments",
    "résultats",
    "medicamentos",
    "resultados",
    "estudios",
    "informes",
    "laudos",
    "wheelchair",
    "in",
    "by",
    "into",
    "to",
    "from",
    "back",
    "out",
    "up",
    "over",
    "with",
    "for",
    "à",
    "au",
    "aux",
    "en",
    "por",
    "para",
    "com",
    "em",
    "ao",
    "przez",
    "do",
    "na",
  ]).map((word) => word.toLowerCase()),
);
// Words on the lists that are also given names or surnames never refuse a name: a wrong
// refusal leaks it ("Paramedics brought Emma Walker", "WARD, Emma", "Rana Khan, DNI …"). The
// body, time and unit lists leave these out; the clinic and role lists need "Pain", "Summer" and
// "Head".
const ALSO_NAMES = new Set(["summer", "pain", "good", "head"]);
// Words on NOT_NAMES that are also names. As a first word they still end a label's value
// ("Patient: Head CT", "Pacjent: Nie zgłasza …"), but not after a person title ("Dr. Head",
// "Mr. Son"), nor before more words that are all name-like ("HEAD, Martin", "Patient: Elle
// Martin", "Patient: Nie Wei"). "Echo" and "Plan" stay out: far more often a test and a plan.
const NAMES_ON_NOT_NAMES = new Set(["head", "son", "nie", "elle"]);
function firstWordIsName(
  text: string,
  start: number,
  candidate: string,
): boolean {
  const words = candidate.split(/[^\p{L}'’-]+/u).filter(Boolean);
  if (!NAMES_ON_NOT_NAMES.has(words[0]?.toLowerCase() ?? "")) return false;
  if (TITLE_RIGHT_BEFORE.test(text.slice(Math.max(0, start - 14), start)))
    return true;
  const rest = words.slice(1);
  return (
    rest.length > 0 &&
    rest.every((word) => {
      const lower = word.toLowerCase();
      return (
        !NOT_NAMES.has(lower) &&
        !STATUS_WORDS.has(lower) &&
        !HEADER_WORDS.has(lower) &&
        !uncuedNotName(word)
      );
    })
  );
}
/** An uncued name candidate is no name when any word is a clinical, document, heading, status,
 * generic, body or drug word, or has a medical ending. */
function uncuedNotName(candidate: string): boolean {
  return candidate
    .split(/[^\p{L}'’]+/u)
    .filter(Boolean)
    .some((word) => {
      const lower = word.toLowerCase();
      if (ALSO_NAMES.has(lower)) return false;
      return (
        UNCUED_NOT_NAME_WORDS.has(lower) ||
        FAMILY_HISTORY_WORDS.has(lower) ||
        HEADER_WORDS.has(lower) ||
        STATUS_WORDS.has(lower) ||
        (NOT_NAMES.has(lower) && !NAMES_ON_NOT_NAMES.has(lower)) ||
        TREATMENT_WORDS.has(lower) ||
        PLACE_WORDS.has(lower) ||
        GENERIC_BEFORE_CLINIC.has(lower) ||
        DRUG_NAMES.has(lower) ||
        MEDICAL_ENDING.test(lower) ||
        new RegExp(`^${CLINIC_WORDS}$`, "u").test(word)
      );
    });
}
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
      /\b(?:MRN|HRN|Medical record(?: number| no\.?| #)?|Health record(?: number| no\.?| #)?|Chart(?: number| no\.?| #)?|Record(?: number| no\.?| #)|Hospital(?: number| no\.?| #)|Patient(?: ID| number| no\.?| #)|Pt(?: ID| number| no\.?| #)|Account(?: number| no\.?| #)|Acct(?: number| no\.?| #)|Unit(?: number| no\.?| #)|Client(?: ID| number| no\.?| #)|Order(?: number| no\.?| #)|Report(?: number| no\.?| #)|Reference(?: number| no\.?| #)|Ref(?: no\.?| #)|Accession(?: number| no\.?| #)?|Requisition(?: number| no\.?| #)?|Lab(?: number| no\.?| #)|Encounter(?: number| no\.?| #)?|Visit(?: number| no\.?| #)|Case(?: number| no\.?| #)|File(?: number| no\.?| #)|Specimen(?: number| no\.?| #| ID)?|Sample(?: number| no\.?| #| ID)|Spécimen(?: no\.?| n°| #)?|Échantillon(?: no\.?| n°| #)?|Dossier(?:[ \t]+(?:médical|patient|hospitalier|clinique))?(?: no\.?| n°| #)?|ID[ \t]+patient|Identifiant(?: du)?[ \t]+patient|(?:N[o°]|Numéro)[ \t]+(?:de[ \t]+|du[ \t]+|d['’][ \t]*)(?:dossier(?:[ \t]+(?:médical|patient|hospitalier|clinique))?|patient|hôpital|requête|demande|laboratoire|visite|épisode|rapport|référence|prélèvement|spécimen|échantillon))[ \t]*[:#]?[ \t]*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/giu,
    group: 1,
  },
  // The same labels when they carry an explicit qualifier ("number", "no.",
  // "#", "ID", "n°", or the French "No/Numéro de …"): the value may then
  // start with a short letter prefix before a space ("REF 12345"). Without
  // the qualifier a following word is clinical text ("Specimen: blood 10 mL",
  // "Chart: see 2024 notes") and stays. Known cost: "Patient no 12" removes
  // the 12, as "Lab no 12" always did.
  {
    kind: "recordNumber",
    pattern:
      /\b(?:(?:MRN|HRN|Medical record|Health record|Chart|Record|Hospital|Patient|Pt|Account|Acct|Unit|Client|Order|Report|Reference|Ref|Accession|Requisition|Lab|Encounter|Visit|Case|File|Specimen|Sample|Spécimen|Échantillon|Dossier(?:[ \t]+(?:médical|patient|hospitalier|clinique))?)(?: number| no\.?| #| ID| n°)|ID[ \t]+patient|Identifiant(?: du)?[ \t]+patient|(?:N[o°]|Numéro)[ \t]+(?:de[ \t]+|du[ \t]+|d['’][ \t]*)(?:dossier(?:[ \t]+(?:médical|patient|hospitalier|clinique))?|patient|hôpital|requête|demande|laboratoire|visite|épisode|rapport|référence|prélèvement|spécimen|échantillon))[ \t]*[:#]?[ \t]*([A-Z]{1,5}[ \t][A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/giu,
    group: 1,
    upperPrefix: true,
  },
  // More record-number labels (policy, certificate, exam, visit, student, file; the French,
  // Spanish, Portuguese and Polish words for them), then a code of four or more digits with
  // letters, hyphens, slashes or dots: "Policy no. GRP-00731-554/02", "Examen n° AB-26-004517",
  // "Prontuário: 1234.567-8", "dossier 1234 5678".
  {
    kind: "recordNumber",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Insurance policy|Policy|Certificate|Student ID|Student number|Exam|Examen|Visit|Clinic file|Claim|Reference|Référence patient|Référence|Usager|Numéro de police|Numéro scolaire|Numéro d['’]examen|Numéro d['’]usager|IPP|Identifiant patient IPP|NHC|Prontuário|Prontuario|Dossier|Nr księgi głównej|Nr księgi|Número de póliza|Número de apólice|Póliza|Polisa|Apólice|Pedido|N\\.?º de petición|Número de petición|historia clínica|historii choroby|Nr zlecenia|Numer zlecenia|numer prawa wykonywania zawodu|NPWZ|PWZ|Colegiada|Licencia|Licença|Licenca|CNH|CRM|COREN|CRO|CREFITO|Colegiado|Col\\.|Registro profissional)(?:-[A-Z]{2})?(?:[ \\t]+(?:number|no\\.?|nr\\.?|n°|nº|n\\.º|#|numéro|número|numer|de licencia|de licença))?[ \\t]*[:#]?[ \\t]*((?:[A-Z]{1,4}[ ](?=\\d{4}))?(?=(?:[A-Za-z/.-]*\\d){4})[A-Za-z0-9][A-Za-z0-9/.-]*(?:[ ]\\d{3,8})?)(?![ \\t]*(?:mg|mcg|µg|ug|g|kg|ml|l|dl|mmol|umol|µmol|meq|iu|u|%|mm|cm|m|bpm|mmhg|ng|pg|fl|\\/))`,
      "giu",
    ),
    group: 1,
    skipDates: true,
  },
  // A birth date after its cue. These cues are the real defence for the age: the 90-and-over
  // net only covers ages of 90 and more, so an unread birth date of an 85-year-old becomes
  // DATE 1, and every day gap counted from it then gives the exact age (#253).
  {
    kind: "dateOfBirth",
    pattern: new RegExp(
      `(?:\\bDOB(?:[ \\t]*\\/[ \\t]*(?:Age|Âge|Edad|Idade|Wiek))?|\\bD\\.O\\.B\\.?|\\bDate of birth(?:[ \\t]*\\((?:DOB|D\\.O\\.B\\.?)\\))?|\\bDate[ \\t]+(?:de[ \\t]+)?naiss\\.?|\\bF\\.?[ \\t]?de[ \\t]+nac\\.?|\\bF\\.?N\\.?[ \\t]*:|\\bD\\.?N\\.?[ \\t]*:|\\bur\\.[ \\t]+dnia|\\bN[ée]\\(e\\)[ \\t]+le|\\bData[ \\t]+urodz\\.?|\\bDt\\.?[ \\t]+nasc\\.?|\\bBirth[ \\t]*:|出生年月日|\\bBirth ?date|\\bBorn(?:[ \\t]+on)?|(?<![\\p{L}\\d.])b\\.|\\bDate de naissance|\\bnaissance|\\bDDN|\\bN[ée]e?[ \\t]+(?:le|en)|` +
        `\\bFecha de nacimiento|\\bFecha[ \\t]+(?:de[ \\t]+)?nac\\.?|\\bFec\\.?[ \\t]?nac\\.?|\\bNacid[oa](?:[ \\t]+el)?|\\bF\\.?[ \\t]?nac\\.?|\\bData de nascimento|\\bData[ \\t]+(?:de[ \\t]+)?nasc\\.?|\\bNascid[oa](?:[ \\t]+em)?|\\bNasc\\.|` +
        `\\bData urodzenia|\\bur\\.|\\bUrodzon[ya](?:[ \\t]+dnia)?|出生日期|出生於|出生于|出生|生日)[ \\t]*:?[ \\t：]*(${DATE})`,
      "giu",
    ),
    group: 1,
  },
  // A date in brackets straight after an age ("Age 76 (2 January 1950)") is
  // the date of birth.
  {
    kind: "dateOfBirth",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Age|Aged|Âge|Edad|Idade|Wiek|年龄|年齡)[ \\t]*:?[ \\t]*\\d{1,3}(?:[ \\t]*(?:years?(?:[ \\t]old)?|yrs?|ans|años|anos|lat|歲|岁))?[ \\t]*[,;]?[ \\t]*[(（][ \\t]*(${DATE})[ \\t]*[)）]`,
      "giu",
    ),
    group: 1,
  },
  // A date in brackets straight after "Patient <name>" is the date of birth.
  {
    kind: "dateOfBirth",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Patient|Patiente|Paciente|Pacjent|Pacjentka|患者|病人)[ \\t]*:?[ \\t]+${CAPITALIZED_NAME}[ \\t]*[(（][ \\t]*(${DATE})[ \\t]*[)）]`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "phone",
    pattern:
      /(?:\+?1[ .-]?)?(?:\(\d{3}\)[ ]?|\b\d{3}[ .-]?)\d{3}[ .-]?\d{4}\b(?:[ \t]*(?:ext\.?|x|poste)[ \t]*\d{1,5}\b)?/gi,
  },
  // A phone with a country code ("+34 612 345 678", "+48 601 234 567"), a Brazilian
  // phone ("(11) 91234-5678"), or any phone after its label in es/pl/pt.
  {
    kind: "phone",
    pattern:
      /(?<![\d+])\+(?:[2-9]\d{0,2})[ .-]?\(?\d{1,3}\)?(?:[ .-]?\d{2,4}){2,4}(?!\d)|(?<![\d(])\(\d{2}\)[ ]?9?\d{4}-?\d{4}(?!\d)/g,
  },
  {
    kind: "phone",
    pattern:
      /(?<![\p{L}])(?:Teléfono|Telefono|Telefone|Telefon|Tel|Tfno|Móvil|Movil|Celular|Cel|kom|tel\. kom)\.?[ \t]*[:#]?[ \t]*(\+?[\d(][\d ().-]{6,16}\d)(?!\d)/giu,
    group: 1,
  },
  // A national identity number after its label: DNI/NIE "12345678Z", PESEL, CPF
  // "123.456.789-09", RG, NIF; and a CPF by its shape.
  {
    kind: "sin",
    pattern:
      /(?<![\p{L}])(?:DNI|NIE|NIF|PESEL|CPF|RG|documento de identidad)[ \t]*(?:n[º°o.][ \t]*)?[:#]?[ \t]*([0-9XYZ][0-9 .-]{6,16}[0-9A-Z])(?![\p{L}\d])/gu,
    group: 1,
  },
  {
    kind: "sin",
    pattern: /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?![\d-])/g,
  },
  // A health card after its label: "tarjeta sanitaria SNSA…", "CNS 898 0012 3456 7890".
  {
    kind: "healthCard",
    pattern:
      /(?<![\p{L}])(?:[Tt]arjeta sanitaria(?: individual)?|TSI|CIP|CNS|[Cc]art[ãa]o (?:[Nn]acional de [Ss]a[úu]de|SUS|do SUS))[ \t]*(?:n[º°o.][ \t]*)?[:#]?[ \t]*((?=(?:[A-Z -]*\d){8})[A-Z0-9][A-Z0-9 -]{7,22}[A-Z0-9])(?![\p{L}\d])/gu,
    group: 1,
  },
  // A social insurance number: nine digits in threes (joined by a space, a
  // hyphen or, as French documents write it, a point), or after its label.
  {
    kind: "sin",
    pattern:
      /\b(?:SIN|NAS|Social [Ii]nsurance(?: [Nn]umber| [Nn]o\.?| #)?|[Nn]uméro d['’]assurance sociale)[ \t]*[:#]?[ \t]*(\d{3}[ .-]{0,2}\d{3}[ .-]{0,2}\d{3})\b/gu,
    group: 1,
  },
  // A sensitive field may describe a value as valid, invalid or mistyped.
  // Its label, not a checksum, identifies the field. Descriptors stay on
  // this line, contain no digits or sentence punctuation, and are bounded.
  {
    kind: "sin",
    pattern:
      /\b(?:SIN|NAS|Social [Ii]nsurance(?: [Nn]umber)?|[Nn]uméro d['’]assurance sociale)[ \t]+[\p{L}][\p{L}'’ -]{0,47}[ \t]*[:#]?[ \t]*(\d{3}[ .-]{0,2}\d{3}[ .-]{0,2}\d{3})\b/gu,
    group: 1,
  },
  // Known cost: any nine digits in equal threes match, so "Lot 123.456.789"
  // is removed too, as "Lot 123 456 789" always was.
  {
    kind: "sin",
    pattern:
      /(?<![\d-])(?<!\d\.)(?<!\+\d{1,3}[ .-]?)(?<!(?:[Tt]el(?:éfono|efono|efone|efon)?|[Tt]fno|[Mm][óo]vil|[Cc]elular|[Cc]el|[Kk]om|[Pp]hone|[Cc]ell)\.?[ \t]*[:#]?[ \t]*)\d{3}([ .-])\d{3}\1\d{3}(?![\d-])(?!\.\d)(?![ \t]*(?:\/|[x×][ \t]*10))/gu,
  },
  // A web address: with its scheme or "www.", or a bare domain with a common
  // ending, and whatever follows it.
  {
    kind: "web",
    pattern:
      /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|org|net|gov|edu|info|io|health|fr|uk|us)\b(?:\/[^\s<>"'()[\]]*)?/gi,
  },
  // An age of 90 or over, which is identifying on its own: "93 years old", "93 ans",
  // "93 años", "93 anos", "93 lata", "Edad: 93", "Wiek: 93".
  {
    kind: "age",
    pattern:
      /\b(?:(?:9\d|1[01]\d)[ -](?:years?|yrs?|y)[ -]?old|(?:9\d|1[01]\d)[ \t]?(?:y\.?o\.?|yo|y\/o)|(?:aged?|edad|idade|wiek)[ \t]*:?[ \t]*(?:9\d|1[01]\d)|(?:âgée?[ \t]+de[ \t]+)?(?:9\d|1[01]\d)[ \t]+(?:ans|años|anos|lat|lata))(?![\p{L}\d])/giu,
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
      /(?<![\p{L}])(?:Address|Mailing address|Home address|Home|Adresse|Domicile|Direcci[oó]n|Domicilio|Endere[cç]o|Adres)[ \t]*(?:[:：]|[ \t](?:–|—|-))[ \t]*([^\n]+)/giu,
    group: 1,
  },
  {
    kind: "address",
    pattern: new RegExp(
      `${UNIT_FIRST}\\b\\d{1,6}[A-Za-z]?(?:-\\d{1,6})?[ \\t]+(?:${NAME_WORD}\\.?[ \\t]+){1,4}${STREET_TYPE}\\b\\.?(?:[ \\t]+(?:East|West|North|South|E|W|N|S)\\b)?${UNIT}${TOWN_AFTER}`,
      "gu",
    ),
  },
  {
    // 1234, rue Sherbrooke Est; 88, boul. René-Lévesque Ouest, app. 5
    kind: "address",
    pattern: new RegExp(
      `${UNIT_FIRST}\\b\\d{1,6}[A-Za-z]?(?:-\\d{1,6})?,?[ \\t]+${FRENCH_STREET_TYPE}[ \\t]+(?:(?:de|du|des|la|le|l['’]|d['’])[ \\t]*)*${NAME_WORD}(?:[ \\t-]+${NAME_WORD})*(?:[ \\t]+(?:Est|Ouest|Nord|Sud|E|O|N|S)\\b)?${UNIT}${TOWN_AFTER}`,
      "gu",
    ),
  },
  // A town alone in brackets after a specialty or a service: "Cardiologie (Ville-Exemple)",
  // "Pediatrics (Sampletown)". Not a note such as "(Urgent)" or "(Suivi)", an abbreviation
  // such as "(ECG)", or a title.
  {
    kind: "address",
    pattern: new RegExp(
      `(?<=(?<![\\p{L}])${SPECIALTY_BEFORE_TOWN}[ \\t]*\\([ \\t]*)(?!(?:Dr|Dre|Mr|Mrs|Ms|Mme|Mlle|Pr|Prof)(?![\\p{L}]))(?:[LD]['’])?\\p{Lu}\\p{Ll}[\\p{L}'’]*(?:[ -]\\p{Lu}[\\p{L}'’]*|-(?:(?:sur|en|lès|les|de|du|des|la|le|aux|à)-)+\\p{Lu}[\\p{L}'’]*|-[dl]['’]\\p{Lu}[\\p{L}'’]*){0,4}(?=[ \\t]*\\))`,
      "gu",
    ),
    townInBrackets: true,
  },
  // A town with its region in brackets after "de", "da", "do" or "z": "de Valdeprueba
  // (Toledo)", "de Vila Teste (Campinas)".
  {
    kind: "address",
    pattern: new RegExp(
      `(?<=(?<![\\p{L}])(?:de|da|do|desde|en|em|no|na|z|ze)[ \\t]+)\\p{Lu}\\p{Ll}[\\p{L}'’]*(?:[ -]\\p{Lu}\\p{Ll}[\\p{L}'’]*){0,2}[ \\t]*\\(\\p{Lu}\\p{Ll}[\\p{L}'’]*(?:[ -]\\p{Lu}\\p{Ll}[\\p{L}'’]*){0,2}\\)`,
      "gu",
    ),
    townInBrackets: true,
  },
  // A Polish town after a word that always means a place: "mieszka w Testowej Woli",
  // "zam. Testowo", "z miejscowości Testowa Wola". A town after a bare "z" is left: "z"
  // also means "with" ("z Piotrem").
  {
    kind: "address",
    pattern: new RegExp(
      `(?<=(?<![\\p{L}])(?:[Mm]ieszka(?:ł|ła|jący|jąca)?[ \\t]+w|[Zz]amieszkał[ay]?[ \\t]+w|[Zz]am\\.|[Zz][ \\t]+(?:miejscowości|miasta|gminy|wsi)|[Ww][ \\t]+(?:miejscowości|mieście|gminie|wsi))[ \\t]+)(?!(?:Ul|Al|Pl|Os|Ulica|Aleja|Plac|Osiedle|UL|AL|PL|OS)(?![\\p{L}]))\\p{Lu}\\p{Ll}+(?:[ -]\\p{Lu}\\p{Ll}+){0,2}`,
      "gu",
    ),
    townInBrackets: true,
  },
  // A Polish street: "ul. Polna 3", "al. Testowa 45 m. 3", "os. Przykładowe 12/4". Not a
  // citation ("Smith et al. Lancet 2019"): never after "et", and a year is no house number.
  {
    kind: "address",
    pattern: new RegExp(
      `(?<![\\p{L}])(?<![Ee][Tt][ \\t]?)(?:[Uu]l\\.|[Aa]l\\.|[Pp]l\\.|[Oo]s\\.|UL\\.|AL\\.|PL\\.|OS\\.|[Uu]lica|[Aa]leja|[Pp]lac|[Oo]siedle|ULICA|ALEJA|PLAC|OSIEDLE)[ \\t]*\\p{Lu}[\\p{L}.-]*(?:[ \\t]+\\p{Lu}[\\p{L}.-]*){0,3}[ \\t]+(?!(?:19|20)\\d{2}(?!\\d))\\d{1,4}[A-Za-z]?(?:\\/\\d{1,4}[A-Za-z]?)?(?:[ \\t]*m\\.[ \\t]*\\d{1,4})?(?![\\p{L}\\d])${TOWN_AFTER}`,
      "gu",
    ),
  },
  // A named residence: "Résidence Les Jardins du Parc", "Foyer Saint-Joseph", "Manoir des Pins".
  {
    kind: "address",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Résidence|Residence|Foyer|Manoir|Maison de retraite|Residencia|Residência)[ \\t]+(?:(?:de|du|des|la|le|les|l['’]|d['’])[ \\t]*)*${NAME_WORD}(?:[ \\t-]+(?:(?:de|du|des|la|le|les)[ \\t]+)?${NAME_WORD}){0,4}`,
      "gu",
    ),
  },
  // "home address 99 Fable Quay, Town": a number and a street without a label's colon.
  {
    kind: "address",
    pattern:
      /(?<![\p{L}])(?:home|mailing|current|residential) address[ \t]+(\d[^\n.;]{4,80})/giu,
    group: 1,
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
      `(?<![\\p{L}])(?:\\p{Lu}\\p{L}*-)?${anyCase(["Hôpital", "Polyclinique", "Cliniques", "Clinique", "Centre hospitalier", "Centre de santé", "CLSC", "CHSLD", "Pharmacie", "Laboratoire", "Cabinet médical"])}(?:(?:[ \\t]+|(?<=[ldLD]['’])|[ \\t]*(?:\/|&|–)[ \\t]*)(?:(?:de|du|des|la|le|les|médicales?|universitaire|régionale?|générale?|familiale)(?![\\p{L}])|l['’]|d['’]|${NAME_WORD})){1,8}(?:[ \\t]*\\(${NAME_WORD}(?:[ -]${NAME_WORD}){0,3}\\))?`,
      "gu",
    ),
  },
  {
    // Clínica San Rafael; Centro de Saúde Vila Exemplo; Szpital Wojewódzki w Testowie; GMF du Parc
    kind: "clinic",
    pattern: new RegExp(
      `(?<![\\p{L}])${anyCase(["Clínica", "Centro de Salud", "Centro de Saúde", "Unidade Básica de Saúde", "Posto de Saúde", "Hospital", "UBS", "Przychodnia", "Przychodni", "Przychodnią", "Poradnia", "Poradni", "Szpital", "Szpitala", "Szpitalu", "Szpitalem", "Ośrodek Zdrowia", "Ośrodka Zdrowia", "Ośrodku Zdrowia", "Centrum Medyczne", "Centrum Medycznego", "Centrum Medycznym", "Laboratorium", "Laboratorio", "Laboratório", "GMF", "CISSS", "CIUSSS", "Centre médical", "Centre de réadaptation", "Groupe de médecine de famille", "Groupe de médecine familiale", "GMF-U", "GMF-R", "Super-clinique", "école primaire", "École primaire", "école secondaire", "École secondaire", "école", "Ecole", "collège", "Cégep", "cégep", "polyvalente", "CPE", "Centre de la petite enfance", "garderie", "escuela", "colegio", "escola", "Szkoła Podstawowa", "szkoła", "przedszkole"])}(?:[ \\t]+(?:(?:de|del|da|do|dos|das|du|des|la|le|les|w|we|nr)[ \\t]+)?(?:[lLdD]['’])?${NAME_WORD}|[ \\t]+nr[ \\t]*\\d{1,4}){1,5}`,
      "gu",
    ),
  },
  {
    // A clinic or an agency named with no clinic word, after "at", "to", "from", "with" or "by":
    // "seen at Silver Acorn Neurology", "a referral from Harbourview Family Services".
    kind: "clinic",
    pattern: new RegExp(
      `(?<=(?<![\\p{L}])(?:at|to|from|with|by|At|To|From|With|By)[ \\t]+(?:the[ \\t]+)?)(?:${NAME_WORD}[ \\t]+){1,4}${ORG_WORDS}(?![\\p{L}])`,
      "gu",
    ),
  },
  {
    // A letterhead's first words: "Exemple Santé", "Testbourg Physio Plus", "Boréal Imagerie".
    kind: "clinic",
    pattern: new RegExp(
      `(?<=(?:^|\\n)[ \\t]*)(?:${NAME_WORD}[ \\t]+){1,3}(?:Santé|Médical|Médicale|Physio|Physiothérapie|Réadaptation|Imagerie|Radiologie|Dentaire|Optométrie)(?:[ \\t]+Plus)?(?![\\p{L}])`,
      "gu",
    ),
  },
  {
    // Imagerie du Quartz; Neurologie du Gland-Argenté; Santé de la Boussole-Bleue
    kind: "clinic",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Imagerie|Neurologie|Cardiologie|Santé|Physiothérapie|Physio|Radiologie|Dermatologie|Pédiatrie|Ophtalmologie|Optométrie|Dentisterie|Ergothérapie|Réadaptation|Psychologie|Orthopédie|Soins|Polyclinique)[ \\t]+(?:du|des|de la|de l['’]|d['’]|de)[ \\t]*${NAME_WORD}(?:[ \\t]+${NAME_WORD}){0,3}`,
      "gu",
    ),
  },
  {
    // Centre de jour Saint-Michel; Centre jeunesse de Laval; Centre Les Érables;
    // CENTRE DE PÉDIATRIE LES PETITS PAS (a header line in capitals)
    kind: "clinic",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Centre|CENTRE)(?:[ \\t]+(?:(?:de|d['’]|du|des)[ \\t]*)?(?:la[ \\t]+|l['’])?\\p{Ll}[\\p{Ll}-]*(?:[ \\t]+\\p{Ll}[\\p{Ll}-]*)?)?(?:(?:[ \\t]+|(?<=[ldLD]['’]))(?:(?:de|du|des|la|le|les)[ \\t]+|[ldLD]['’])*${NAME_WORD}){1,6}`,
      "gu",
    ),
  },
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Dr|Dra|Dre|dr|Doctor|Doctora|Docteur|Docteure|Doutor|Doutora|(?:prof\\.[ \\t]*)?dr[ \\t]+hab\\.[ \\t]*n\\.[ \\t]*med|dr[ \\t]+n\\.[ \\t]*med|dr[ \\t]+hab|prof\\.[ \\t]*dr[ \\t]+hab|[Ll]ek\\.[ \\t]*(?:med|dent)\\.|(?<!(?:[Jj]eden|[Nn]owy|[Tt]en|[Ii]nny|[Kk]ażdy|[Dd]rugi|[Kk]olejny|[Jj]akiś|[Dd]any|[Tt]amten)[ \\t]+)lek\\.|[Mm]gr[ \\t]+(?:farm|inż)|[Mm]gr)\\.?[ \\t]+(${INITIALS}${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:(?:Mr|Mrs|Ms|Miss|Mx|Prof|Pr|Mme|Mlle|Sra|Srta|Sr|Don|Doña|Doña|Pani|Pan(?![ \\t]+Am(?:erican)?(?![\\p{L}])))\\.?|M\\.)[ \\t]+(${INITIALS}${CAPITALIZED_NAME})`,
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
    kind: "name",
    pattern: new RegExp(`(?<![\\p{L}])${COLUMN_LABEL}(${COLUMN_NAME})`, "gu"),
    group: 1,
    columnLabel: true,
  },
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Rr]eferring physician|[Pp]hysician|[Pp]rovider|[Oo]rdering provider|[Aa]ttending|[Ss]igned|[Ff]amily doctor|cc|CC|c\\.c\\.|C\\.C\\.|[Cc]opie conforme|[Cc]opy to|[Mm]édecin traitant|${BY})[ \\t]*:[ \\t]*(?:(?:Dr|Dre)\\.?[ \\t]+)?(${CLINICIAN_NAME})`,
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
  // Explicit relationships fill gaps left by a supplied PERSON list.
  // Require a full name; a disease in this position remains a preview flag.
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Cc]opied to|[Cc]opy to|[Ss]poke with|[Mm]et with|[Aa] rencontré|[Aa]ccompanying relative|[Pp]roche accompagnante)[ \\t]+(${SURNAME_FIRST}|${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
    reviewClinicalConflict: true,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Cc]hecked by|[Vv]érifiée? par)[ \\t]+${CAPITALIZED_NAME}[ \\t]+(?:with|avec)[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
    reviewClinicalConflict: true,
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
  // Other clinicians by their title, with or without a colon: "Nurse
  // Practitioner Jane Doe", "Nurse: Jane Doe", "NP: Jane Doe".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:(?:${CLINICIAN_TITLE}|NP|RN|RPN|RM|IPS)[ \\t]*:|${CLINICIAN_TITLE}${PL_ROLE_QUALIFIER}[ \\t]*,?[ \\t]+)[ \\t]*(${CLINICIAN_NAME})`,
      "gu",
    ),
    group: 1,
  },
  // A clinician named in passing by role, in lower case, with a full name: "her
  // pharmacist, Jordan Example", "la pharmacienne Hélène Example". A single
  // capitalized word after a lower-case role is too often a place or a service.
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:nurse|pharmacist|physiotherapist|physio|social worker|technologist|technician|sonographer|radiologist|surgeon|paramedic|therapist|midwife|dietitian|resident|infirmière|infirmier|pharmacienne|pharmacien|physiothérapeute|radiologue|chirurgienne|chirurgien|technologue|technicienne|technicien|enfermera|enfermero|farmacéutica|farmacéutico|fisioterapeuta|enfermeira|enfermeiro|farmacêutica|farmacêutico|fisioterapeuta|pielęgniarka|pielęgniarz|farmaceuta|fizjoterapeuta)${PL_ROLE_QUALIFIER}[ \\t]*,?[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
  },
  // A clinician named by role, with no title, in es/pt/pl: "la médica Inés Ficticia Peral",
  // "a assistente social Carla Exemplo Lima", "Lekarz Jan Testowy". A full name of two or
  // more words only; physicians are doctors. In Spanish and Portuguese the role follows an
  // article or a determiner, since "médica" and "técnica" are also "medical" and "technique"
  // ("Historia Médica Completa", "técnica Seldinger Modificada") (#262 review).
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])${esPtRole([
        "médico de familia",
        "médica de familia",
        "médico",
        "médica",
        "dentista",
        "odontólogo",
        "odontóloga",
      ])}[ \\t]*,?[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])${esPtRole([
        "trabajadora social",
        "trabajador social",
        "psicóloga",
        "psicólogo",
        "nutricionista",
        "dietista",
        "matrona",
        "técnico de radiología",
        "técnica de radiología",
        "auxiliar de enfermería",
        "auxiliar",
        "terapeuta ocupacional",
        "logopeda",
        "podóloga",
        "podólogo",
        "optometrista",
        "assistente social",
        "técnica de enfermagem",
        "técnico de enfermagem",
        "auxiliar de enfermagem",
        "fonoaudióloga",
        "fonoaudiólogo",
        "parteira",
        "obstetriz",
        "cuidadora",
        "cuidador",
        "agente comunitário de saúde",
        "agente de saúde",
      ])}[ \\t]*,?[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "doctor",
    pattern: new RegExp(
      `(?<![\\p{L}])${anyCase(
        withSentenceCase([
          "lekarz rodzinny",
          "lekarz",
          "lekarka",
          "stomatolog",
        ]),
      )}${PL_ROLE_QUALIFIER}[ \\t]*,?[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])${anyCase(
        withSentenceCase([
          "psycholog",
          "psycholożka",
          "dietetyk",
          "dietetyczka",
          "położna",
          "ratownik medyczny",
          "ratowniczka medyczna",
          "ratownik",
          "terapeuta zajęciowy",
          "terapeutka zajęciowa",
          "terapeutka",
          "opiekun medyczny",
          "opiekunka medyczna",
          "technik radiologii",
          "technik",
          "pracownik socjalny",
          "pracowniczka socjalna",
          "logopeda",
        ]),
      )}${PL_ROLE_QUALIFIER}[ \\t]*,?[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
  },
  // A patient named in a header line, after the document's title, as "SURNAME, Given":
  // "Physiotherapy summary — HALLOWAY, Wren". The name ends the line or stops at a column gap.
  // find() drops the other runs this matches: a header's subject is what the document is about.
  {
    kind: "name",
    pattern: new RegExp(
      `(?<=(?:^|\\n)[ \\t]*${DOCUMENT_HEADING}(?:[ \\t]*(?:—|–|-|:)[ \\t]*|[ \\t]+(?:for|pour|concernant|concerning|regarding|para|dla|sobre|de)[ \\t]+))(${COLUMN_NAME})(?=[ \\t]*(?:[.,;]|\\n|$)|[ ]{2,}|\\t)`,
      "gu",
    ),
    group: 1,
    uncued: true,
    uncuedHeader: true,
  },
  // A person after a care verb: "Paramedics brought Tobiah Farnsworth", "trajo a Lucas …".
  {
    kind: "name",
    pattern: new RegExp(
      // Not after a Spanish clitic: "lo trajeron a Consultas Externas" is "to".
      `(?<![\\p{L}])(?<![Ll](?:o|a|os|as|e|es)[ \\t]+)${CARE_VERB}[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
      "gu",
    ),
    group: 1,
    uncued: true,
  },
  // A relative named in passing: "her husband, Jordan", "son conjoint, Jean".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Hh]usband|[Ww]ife|[Ss]pouse|[Pp]artner|[Ss]on|[Dd]aughter|[Mm]other|[Ff]ather|[Bb]rother|[Ss]ister|[Cc]onjointe?|[ÉéEe]poux|[ÉéEe]pouse|[Ff]ils|[Ff]ille|[Mm]ère|[Pp]ère|[Ff]rère|[Ss]œur)[ \\t]*,?[ \\t]+(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
    kin: true,
  },
  // More family and carer words, in the seven languages: "her guardian
  // Vellin", "sa nièce, Jeanne", "su hija, Marta", "córka Anna", "o filho, Pedro".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])${anyCase([
        "guardian",
        "caregiver",
        "carer",
        "neighbour",
        "neighbor",
        "grandmother",
        "grandfather",
        "grandson",
        "granddaughter",
        "grandchild",
        "niece",
        "nephew",
        "aunt",
        "uncle",
        "cousin",
        "sibling",
        "stepmother",
        "stepfather",
        "stepson",
        "stepdaughter",
        "son-in-law",
        "daughter-in-law",
        "brother-in-law",
        "sister-in-law",
        "tuteur",
        "tutrice",
        "voisin",
        "voisine",
        "nièce",
        "neveu",
        "tante",
        "oncle",
        "cousine",
        "grand-mère",
        "grand-père",
        "petit-fils",
        "petite-fille",
        "belle-fille",
        "gendre",
        "beau-père",
        "belle-mère",
        "beau-frère",
        "belle-sœur",
        "demi-frère",
        "demi-sœur",
        "aidant",
        "aidante",
        "esposo",
        "esposa",
        "hijo",
        "hija",
        "madre",
        "padre",
        "hermano",
        "hermana",
        "nieto",
        "nieta",
        "tío",
        "tía",
        "abuelo",
        "abuela",
        "yerno",
        "nuera",
        "cuñado",
        "cuñada",
        "tutor",
        "tutora",
        "vecino",
        "vecina",
        "cuidador",
        "cuidadora",
        "marido",
        "filho",
        "filha",
        "mãe",
        "pai",
        "irmão",
        "irmã",
        "neto",
        "neta",
        "tio",
        "avô",
        "avó",
        "genro",
        "nora",
        "cunhado",
        "cunhada",
        "vizinho",
        "vizinha",
        "cuidador",
        "cuidadora",
        "mąż",
        "żona",
        "syn",
        "córka",
        "matka",
        "ojciec",
        "brat",
        "siostra",
        "wnuk",
        "wnuczka",
        "babcia",
        "dziadek",
        "ciocia",
        "wujek",
        "teść",
        "teściowa",
        "zięć",
        "synowa",
        "szwagier",
        "szwagierka",
        "opiekun",
        "opiekunka",
        "sąsiad",
        "sąsiadka",
        "丈夫",
        "妻子",
        "儿子",
        "女儿",
        "母亲",
        "父亲",
        "兄弟",
        "姐妹",
        "孫子",
        "监护人",
        "監護人",
        "friend",
        "boyfriend",
        "girlfriend",
        "fiancé",
        "fiancée",
        "roommate",
        "landlord",
        "landlady",
        "ami",
        "amie",
        "copain",
        "copine",
        "amigo",
        "amiga",
        "novio",
        "novia",
        "namorado",
        "namorada",
        "przyjaciel",
        "przyjaciółka",
        "córkę",
        "córką",
        "córki",
        "syna",
        "synem",
        "mężem",
        "męża",
        "żoną",
        "żonę",
        "matką",
        "matkę",
        "ojcem",
        "ojca",
        "bratem",
        "brata",
        "siostrą",
        "siostrę",
        "wnuczką",
        "wnuczkę",
        "wnukiem",
        "wnuka",
        "opiekunem",
        "opiekunką",
        "朋友",
      ])}[ \\t]*,?[ \\t]+(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
    kin: true,
  },
  // Relatives named together after a plural: "her daughters Maribel and Odette", "ses fils
  // Paul et Marc". The first name, then each name after it.
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])${KIN_PLURAL}[ \\t]*,?[ \\t]+(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
    kin: true,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `(?<=(?<![\\p{L}])${KIN_PLURAL}[ \\t]*,?[ \\t]+${CAPITALIZED_NAME}(?:${NAME_JOIN}${CAPITALIZED_NAME}){0,4}${NAME_JOIN})(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
    kin: true,
  },
  // A relation used as a label: "Mother: Rosalind Sampleton". Only a first and a last name
  // that end the entry, and never a family-history line ("Mother: Breast cancer at 52").
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Mother|Father|Mom|Mum|Dad|Spouse|Husband|Wife|Partner|Son|Daughter|Brother|Sister|Mère|Père|Conjoint|Conjointe|Fils|Fille|Madre|Padre|Hijo|Hija|Mãe|Pai|Filho|Filha|Matka|Ojciec|Syn|Córka)[ \\t]*:[ \\t]*(${NAME_PART}[ \\t]+${NAME_PART})(?=[ \\t]*(?:[.,;(]|\\n|$))`,
      "gu",
    ),
    group: 1,
    kin: true,
    relationLabel: true,
  },
  // A patient after a referral verb: "Le remito a Rosa Ejemplar", "encaminho Rosa Exemplo",
  // "kieruję Różę Przykładową".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Rr]emito a|[Dd]erivo a|[Ee]nv[íi]o a|[Pp]resento a|[Ee]ncaminho|[Ee]ncaminhamos|[Aa]presento|[Kk]ieruję|[Kk]ierujemy|[Pp]rzekazuję)[ \\t]+(?:(?:al|a la|o|a|el paciente|la paciente|o paciente|a paciente|pana|panią|pacjenta|pacjentkę)[ \\t]+)?(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  // A full name right before an identity label: "Tomás Prueba Iglesias, DNI …". The label
  // tells a person's line, not who the words before it are, so the run is refused for any
  // non-name word, is never a document heading's subject ("Informe de alta: Neumonía Adquirida
  // NHC …"), and never starts inside a capitalised run ("Oddział Chorób Wewnętrznych PESEL …").
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?<!(?:^|\\n)[ \\t]*${DOCUMENT_HEADING}[ \\t]*(?:—|–|-|:)[ \\t]*)(?<!\\p{Lu}[\\p{L}'’-]*[ \\t]+)(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})(?=,?[ \\t]+(?:DNI|NIE|NIF|PESEL|CPF|RG|NHC|CNS|Nr księgi|[Tt]arjeta sanitaria)(?![\\p{L}]))`,
      "gu",
    ),
    group: 1,
    uncued: true,
  },
  // The same, written "SURNAME, Given": "WIERZBICKA, Zuzanna    PESEL …".
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(${UPPER}[\\p{Lu}'’-]+(?:[ ]${UPPER}[\\p{Lu}'’-]+){0,2},[ ]${LABEL_PART}(?:[ ]${LABEL_PART})?)(?=,?[ \\t]+(?:DNI|NIE|NIF|PESEL|CPF|RG|NHC|CNS|Nr księgi|[Tt]arjeta sanitaria)(?![\\p{L}]))`,
      "gu",
    ),
    group: 1,
    uncued: true,
  },
  // A closing, then the name on the next non-empty line.
  {
    kind: "name",
    pattern: new RegExp(
      `(?<![\\p{L}])(?:Sincerely|Yours truly|Regards|Best regards|Kind regards|Cordialement|Salutations distinguées|Atentamente|Saludos cordiales|Un saludo|Atenciosamente|Z poważaniem|Z wyrazami szacunku|Pozdrawiam),[ \\t]*\\n(?:[ \\t]*\\n)*[ \\t]*(?:(?:Dr|Dra|Dre|dr|Doutor|Doutora|lek\\.)\\.?[ \\t]+)?(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
  },
  ...DATE_FORMS.filter((form) => !form.labelOnly && !form.partial).map(
    (form) => ({
      kind: "date" as const,
      pattern: new RegExp(
        `${WEEKDAY_BEFORE}${form.pattern}${POLISH_YEAR_AFTER}${WEEKDAY_AFTER}`,
        "giu",
      ),
    }),
  ),
  // "Date: 17/10/26", "Visit date: …", "Date de la visite : …", "dated …".
  ...DATE_FORMS.filter((form) => form.labelOnly).map((form) => ({
    kind: "date" as const,
    pattern: new RegExp(
      `(?<![\\p{L}])(?:[Dd]ate(?![\\p{L}])[^\\n:]{0,30}:|[Dd]ated|(?:[Cc]ollected|[Rr]eceived|[Rr]eported|[Aa]dmitted|[Dd]ischarged|[Ss]igned)[ \\t]*:)[ \\t]*(${WEEKDAY_BEFORE}${form.pattern})`,
      "gu",
    ),
    group: 1,
  })),
  // "October 2026": moved with its 15th day.
  ...DATE_FORMS.filter((form) => form.partial === "monthYear").map((form) => ({
    kind: "date" as const,
    pattern: new RegExp(form.pattern, "giu"),
  })),
  // "Oct 8", "8 octobre": a day and a month, no year, so a plain mark.
  ...DATE_FORMS.filter((form) => form.partial === "monthDay").map((form) => ({
    kind: "date" as const,
    pattern: new RegExp(form.pattern, "giu"),
    notLowerCaseMay: true as const,
  })),
  // "in 2019", "depuis 2019": a year after a cue word, a plain mark.
  ...DATE_FORMS.filter((form) => form.partial === "year").map((form) => ({
    kind: "date" as const,
    pattern: new RegExp(
      `(?<![\\p{L}])${YEAR_CUE}[ \\t]+(${form.pattern})`,
      "giu",
    ),
    group: 1,
  })),
];

/**
 * Where folding would change what a pattern means: a character inside a class that folds to
 * a class operator ("-", "^", "]", "\\") or to more than one character ("œ" → "oe"), or a
 * character outside a class that folds into regex syntax ("（" → "("). "[-–—]" folded to the
 * range "[--—]", which holds every letter, so "Patient ABC" lost "BC" to a name (#252).
 */
export function foldHazardsIn(source: string): string[] {
  const hazards: string[] = [];
  let inClass = false;
  // The last literal character inside the class, for a range ("[À-ÿ]").
  let previous = "";
  for (let at = 0; at < source.length; at++) {
    const char = source[at];
    if (char === "\\") {
      // An escaped character the text's fold changes never matches: "\u00e9" (é)
      // stays in the pattern while the text holds "e".
      const escape =
        /^(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/u.exec(
          source.slice(at + 1),
        );
      if (escape) {
        const escaped = String.fromCodePoint(
          parseInt(escape[1] ?? escape[2] ?? escape[3], 16),
        );
        if (fold(escaped) !== escaped)
          hazards.push(
            `the escape at ${at} (${JSON.stringify(escaped)}) folds to ${JSON.stringify(fold(escaped))}`,
          );
        at += escape[0].length;
        previous = escaped;
      } else {
        previous = source[at + 1] ?? "";
        at++;
      }
      continue;
    }
    if (!inClass && char === "[") {
      inClass = true;
      previous = "";
      continue;
    }
    if (inClass && char === "]") {
      inClass = false;
      continue;
    }
    // A range inside a class whose end folds changes its span: "[À-ÿ]" → "[A-y]".
    if (inClass && char === "-" && previous && source[at + 1] !== "]") {
      const next = source[at + 1] === "\\" ? "" : (source[at + 1] ?? "");
      if (fold(previous) !== previous || (next && fold(next) !== next))
        hazards.push(
          `the range ${JSON.stringify(`${previous}-${next}`)} at ${at} has an end that folds`,
        );
    }
    if (inClass) previous = char;
    const folded = fold(char);
    if (folded === char) continue;
    if (
      inClass
        ? folded.length !== 1 || /[-^\]\\]/u.test(folded)
        : /[\\^$.|?*+()[\]{}]/u.test(folded)
    )
      hazards.push(
        `${JSON.stringify(char)} at ${at} folds to ${JSON.stringify(folded)}${inClass ? " inside a class" : ""}`,
      );
  }
  return hazards;
}
/** Each rule, date form and date range whose meaning folding would change; the tests require
 * none. */
export const FOLD_HAZARDS: string[] = [];

// The rules run on the matching copy, so their accented letters are folded
// as the copy's are ("Hôpital" finds "Hopital", which is how the copy
// spells it).
for (const [index, rule] of RULES.entries()) {
  for (const hazard of foldHazardsIn(rule.pattern.source))
    FOLD_HAZARDS.push(
      `rule ${index} (${rule.kind}, ${rule.pattern.source.slice(0, 60)}…): ${hazard}`,
    );
  rule.pattern = new RegExp(fold(rule.pattern.source), rule.pattern.flags);
}
for (const form of DATE_FORMS) {
  for (const hazard of foldHazardsIn(form.pattern))
    FOLD_HAZARDS.push(`date form ${form.id}: ${hazard}`);
  form.pattern = fold(form.pattern);
}

const DAY_WITH_ORDINAL = "(\\d{1,2}(?:er|st|nd|rd|th)?)";
const RANGE_JOINER = "[ ]*(?:-|to|through|au|et|and)[ ]*";
/** "8-12 October 2026", "from 8 to 12 October 2026", "du 8 au 12 octobre 2026",
 * and "Oct 8-12, 2026": a range of days in one month. Each end is a date. */
const RANGES = [
  {
    // groups: 1 first day, 2 second day, 3 month, 4 year
    pattern: new RegExp(
      `\\b${DAY_WITH_ORDINAL}${RANGE_JOINER}${DAY_WITH_ORDINAL}(?:[ ]+of)?[ ]+(${MONTH})[ ,-]*(\\d{4})\\b`,
      "giud",
    ),
    order: { first: 1, second: 2, month: 3, year: 4 },
    monthFirst: false,
  },
  {
    // groups: 1 month, 2 first day, 3 second day, 4 year
    pattern: new RegExp(
      `(?<![\\p{L}])(${MONTH})[ ]+${DAY_WITH_ORDINAL}${RANGE_JOINER}${DAY_WITH_ORDINAL},?[ ]+(\\d{4})\\b`,
      "giud",
    ),
    order: { first: 2, second: 3, month: 1, year: 4 },
    monthFirst: true,
  },
];
for (const [index, range] of RANGES.entries()) {
  for (const hazard of foldHazardsIn(range.pattern.source))
    FOLD_HAZARDS.push(`date range ${index}: ${hazard}`);
  range.pattern = new RegExp(fold(range.pattern.source), range.pattern.flags);
}

function findRanges(text: string): Finding[] {
  const found: Finding[] = [];
  for (const range of RANGES) {
    for (const match of text.matchAll(range.pattern)) {
      const spans = match.indices;
      if (!spans) continue;
      const month = monthOf(match[range.order.month]);
      const year = +match[range.order.year];
      const ends = [range.order.first, range.order.second].map((group) => {
        const day = parseInt(match[group], 10);
        const date = new Date(0);
        date.setUTCFullYear(year, month - 1, day);
        return month >= 1 && date.getUTCMonth() === month - 1 && day >= 1
          ? ({
              kind: "full",
              iso: `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`,
              epochDay: Math.round(date.getTime() / 86_400_000),
            } as DateReading)
          : null;
      });
      if (!ends[0] || !ends[1]) continue;
      const matchEnd = match.index + match[0].length;
      // The first end is its day (with its month in front, written month
      // first); the second runs from its day to the end of the match.
      const at = (group: number) => spans[group] as [number, number];
      const firstStart = range.monthFirst
        ? at(range.order.month)[0]
        : at(range.order.first)[0];
      found.push(
        {
          kind: "date",
          start: firstStart,
          end: at(range.order.first)[1],
          reading: ends[0],
        },
        {
          kind: "date",
          start: at(range.order.second)[0],
          end: matchEnd,
          reading: ends[1],
        },
      );
    }
  }
  return found;
}

// A relative named in passing, in title-case text: "Daughter Present At Visit", "Brought Son
// Home", "Patient: Son Visited Today". The run ends at a capitalised small word, words that
// follow a relative are dropped from its end, and it is no name when its first word is one.
// Name particles (De, La, Van …) stay. "Will" is a given name, so it is neither.
const KIN_CUT_WORDS = new Set([
  "at",
  "of",
  "by",
  "up",
  "to",
  "in",
  "on",
  "with",
  "for",
  "from",
  "is",
  "was",
  "and",
  "du",
  "des",
  "au",
  "aux",
  "lors",
  "avec",
  "pour",
  "par",
  "en",
  "et",
  "por",
  "con",
  "para",
  "com",
  "em",
  "na",
  "przez",
  "i",
]);
const KIN_FOLLOW_WORDS = new Set(
  foldAll([
    "present",
    "aware",
    "called",
    "drove",
    "supportive",
    "updated",
    "informed",
    "notified",
    "visiting",
    "visited",
    "arrived",
    "lives",
    "home",
    "bedside",
    "nearby",
    "présent",
    "présente",
    "informé",
    "informée",
    "avisé",
    "avisée",
    "presente",
    "informado",
    "informada",
    "avisado",
    "avisada",
    "obecny",
    "obecna",
    "poinformowany",
    "poinformowana",
  ]).map((word) => word.toLowerCase()),
);
function kinName(candidate: string): string {
  const words = [...candidate.matchAll(/[^ \t]+/gu)];
  const listWord = (word: string) => {
    const lower = word.toLowerCase();
    // Keep the same name exceptions as the surrounding refusal checks.
    if (ALSO_NAMES.has(lower) || NAMES_ON_NOT_NAMES.has(lower)) return false;
    return (
      KIN_FOLLOW_WORDS.has(lower) ||
      STATUS_WORDS.has(lower) ||
      NOT_NAMES.has(lower) ||
      HEADER_WORDS.has(lower)
    );
  };
  let count = words.findIndex((word) =>
    KIN_CUT_WORDS.has(word[0].toLowerCase()),
  );
  if (count < 0) count = words.length;
  while (count > 0 && listWord(words[count - 1][0])) count--;
  if (count === 0 || listWord(words[0][0])) return "";
  const last = words[count - 1];
  return candidate.slice(0, (last.index ?? 0) + last[0].length);
}
function ruleFindings(text: string, options: DeidentifyOptions): Finding[] {
  const found: Finding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const detail = rule.group ? match[rule.group] : match[0];
      if (!detail) continue;
      // The pattern runs case-insensitively; a letter prefix must really be capitals
      // ("Order number: see 2024 notes" is a sentence, not an ID).
      if (rule.upperPrefix && !/^[A-Z]{1,5}[ \t]/u.test(detail)) continue;
      if (rule.notLowerCaseMay && /(?<![\p{L}])may(?![\p{L}])/u.test(detail))
        continue;
      const offset = rule.group ? match[0].indexOf(detail) : 0;
      const start = match.index + offset;
      // A label's value may run past the detail into trailing punctuation,
      // and a French clinic's name into connecting words.
      let trimmed = detail.replace(/[\s,;.]+$/u, "");
      // Polish "2026 r.": the full stop belongs to the abbreviation.
      if (
        rule.kind === "date" &&
        /\d[ \t]?r$/u.test(trimmed) &&
        text.charAt(start + trimmed.length) === "."
      )
        trimmed += ".";
      // An unqualified Encounter followed by a valid whole date is a date
      // field. Explicit record labels and invalid date-shaped IDs retain
      // record-number protection.
      if (
        rule.kind === "recordNumber" &&
        /^Encounter[ \t]*:?[ \t]*$/iu.test(match[0].slice(0, offset)) &&
        (() => {
          const reading = readDateText(trimmed, options.dayFirst ?? true);
          return reading !== null && reading.kind !== "unclear";
        })()
      )
        continue;
      // A value cut inside a longer token ("135-14" of "135-145 mmol/L"), an amount
      // ("Claim 1250.00") or a lab reference range ("Reference: 135-145") is not a
      // record number (#228 review).
      // "HC 3390127": a letter prefix before the digits must really be capitals.
      if (
        rule.kind === "recordNumber" &&
        /^[A-Za-z]{1,4} \d/u.test(trimmed) &&
        !/^[A-Z]{1,4} \d/u.test(trimmed)
      )
        continue;
      if (
        rule.kind === "recordNumber" &&
        (/[\p{L}\p{N}]/u.test(text.charAt(start + detail.length)) ||
          /^\d{1,7}[.,]\d{2}$/u.test(trimmed) ||
          (/^\d{1,4}(?:[.,]\d+)?[-–]\d{1,4}(?:[.,]\d+)?$/u.test(trimmed) &&
            /^R[ée]f/iu.test(match[0].slice(0, offset).trim())))
      )
        continue;
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
        NOT_NAMES.has(trimmed.split(/[\s,]+/)[0].toLowerCase()) &&
        !firstWordIsName(text, start, trimmed)
      )
        continue;
      // A treatment after a role word is not a name ("a therapist Cognitive
      // Behavioural Therapy"); a place or a team ends the name before it
      // ("Charge nurse Maria Lopez Unit 4B") (#228 review).
      if (rule.kind === "name" || rule.kind === "doctor") {
        const words = [...trimmed.matchAll(/[^\s,]+/gu)];
        const at = words.findIndex((word) => {
          const lower = word[0].toLowerCase();
          return TREATMENT_WORDS.has(lower) || PLACE_WORDS.has(lower);
        });
        if (at >= 0) {
          if (
            at === 0 ||
            TREATMENT_WORDS.has(words[at][0].toLowerCase()) ||
            words
              .slice(0, at)
              .every((word) => GENERIC_BEFORE_CLINIC.has(word[0].toLowerCase()))
          )
            continue;
          trimmed = trimmed.slice(0, words[at].index).replace(/[\s,]+$/u, "");
        }
      }
      if (rule.relationLabel && familyHistoryLabel(text, match.index, trimmed))
        continue;
      if (rule.kin) {
        trimmed = kinName(trimmed);
        if (!trimmed) continue;
      }
      if (rule.uncued && uncuedNotName(trimmed)) continue;
      if (rule.columnLabel) {
        const words = trimmed
          .split(/[^\p{L}'’]+/u)
          .filter(Boolean)
          .map((word) => word.toLowerCase());
        const first = words[0] ?? "";
        if (
          words.some((word) => HEADER_WORDS.has(word)) ||
          // Not "SURNAME, Given": a first word that is a status or a
          // not-a-name word ends it. Not ORDINARY_WORDS: those are first names
          // that are also words ("PATIENT  MAY SAMPLETON").
          (!trimmed.includes(",") &&
            (STATUS_WORDS.has(first) ||
              (NOT_NAMES.has(first) && !firstWordIsName(text, start, trimmed))))
        )
          continue;
      }
      if (
        rule.townInBrackets &&
        (BRACKET_NOTES.has(trimmed.toLowerCase()) ||
          trimmed.split(/[^\p{L}'’]+/u).some((word) => {
            const lower = word.toLowerCase();
            return (
              BRACKET_NOTES.has(lower) ||
              FAMILY_HISTORY_WORDS.has(lower) ||
              ORDINARY_WORDS.has(lower) ||
              MEDICAL_ENDING.test(lower)
            );
          }))
      )
        continue;
      // A bare "Nombre:" or "Nome:" is also French and Portuguese for "number":
      // only a first and a last name after it ("Nombre : Deux comprimés").
      if (
        rule.kind === "name" &&
        /^(?:Nombre|Nome|NOMBRE|NOME)[ \t]*[:\-–—][ \t]*$/u.test(
          match[0].slice(0, offset),
        ) &&
        trimmed.split(/[ \t]+/).length < 2
      )
        continue;
      if (
        (rule.kind === "name" ||
          rule.kind === "doctor" ||
          rule.kind === "address") &&
        isMedicalTerm(
          text,
          start,
          start + trimmed.length,
          rule.kind !== "address",
        )
      )
        continue;
      if (rule.skipDates) {
        const reading = readDateText(trimmed, options.dayFirst ?? true);
        if (reading !== null) continue;
      }
      const end = start + trimmed.length;
      found.push({
        kind:
          rule.reviewClinicalConflict &&
          (clinicalNameOccurrence(text, start, end) ||
            /\b(?:syndrome|disease|maladie|palsy|paralysis|paralysie|tenosynovitis|tenosynovite|sign|signe)\b/iu.test(
              trimmed,
            ))
            ? "possibleName"
            : rule.kind,
        start,
        end,
        ...(rule.kin ? { kin: true as const } : {}),
        ...(rule.uncuedHeader ? { uncuedHeader: true as const } : {}),
      });
      // Only an immediately linked checksum control inherits a SIN/NAS
      // field. An unrelated nine-digit measurement never inherits it.
      if (rule.kind === "sin") {
        const control =
          /^[ \t]*;[ \t]*(?:checksum[- ](?:in)?valid[ \t]+control|controle[ \t]+a[ \t]+somme[ \t]+(?:in)?valide)[ \t]*:[ \t]*(\d{3}[ .-]{0,2}\d{3}[ .-]{0,2}\d{3})\b/iu.exec(
            text.slice(end),
          );
        if (control) {
          const controlStart = end + control[0].lastIndexOf(control[1]);
          found.push({
            kind: "sin",
            start: controlStart,
            end: controlStart + control[1].length,
          });
        }
      }
    }
  }
  return found;
}

/** A title or a role word right before `at`: the name rules decide what follows, not a town list. */
const TITLE_BEFORE =
  /(?:\b(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mme|Mlle|M|Pr|Prof|Sr|Sra|Srta|Pan|Pani)\.?|\b(?:nurse|pharmacist|physiotherapist|technologist|sonographer|radiologist|surgeon|infirmière|infirmier|pharmacienne|pharmacien|technologue|radiologue|chirurgien|chirurgienne|enfermera|enfermero|farmacéutico|farmacéutica|enfermeiro|enfermeira|farmacêutico|farmacêutica))[ \t]+$/iu;
const followsTitle = (text: string, at: number) =>
  TITLE_BEFORE.test(text.slice(Math.max(0, at - 30), at));

// A short birth cue that is also an everyday abbreviation: "DN:" (district nurse), "FN:"
// (febrile neutropenia), "b." (the second item of a lettered list, "Plan B.").
const SHORT_BIRTH_CUE =
  /(?:(?<![\p{L}])(?:D\.?N\.?|F\.?N\.?)[ \t]*:|(?<![\p{L}\d.])[Bb]\.)[ \t：]*$/iu;
/**
 * A date after a short birth cue is a birth date only when it is at least a year before
 * another date in the text (an adult's birth date is decades before a visit), or when it is
 * the only date in the text. Otherwise it is an event date (#259 review). The cost, accepted:
 * an unknown infant's birth date beside a visit days later is read as an event, so the gap
 * gives the age in days; the patient's own birth date is still covered by knownBirthDates.
 */
function keepShortBirthCue(
  finding: Finding,
  dates: { finding: Finding; days: number[] }[],
): boolean {
  const own = dates.find((date) => date.finding === finding)?.days ?? [];
  const others = dates.filter(
    (date) =>
      date.finding.end <= finding.start || date.finding.start >= finding.end,
  );
  // An unclear day and month ("12/03/2026") has both readings: years apart either way.
  if (
    others.some((date) =>
      date.days.some((day) => own.some((birth) => day - birth >= 365)),
    )
  )
    return true;
  return others.length === 0;
}

// "HALLOWAY, Wren": a surname in capitals, a comma and a given name. A header line's name with
// no person cue counts only in this form. A person field near a "Given Surname" run tells a
// person's document, not that the run is the person: "Referral Letter: Orthopaedic Surgery"
// stands over "DOB: …" as often as a name does, on the next line or in a column (#264 review).
const SURNAME_FIRST_IN_CAPITALS = /^\p{Lu}[\p{Lu}'’ -]+,[ \t]+\p{Lu}/u;

function find(text: string, options: DeidentifyOptions): Finding[] {
  const found: Finding[] = findRanges(text);
  found.push(...ruleFindings(text, options));
  {
    const short = found.filter(
      (finding) =>
        finding.kind === "dateOfBirth" &&
        SHORT_BIRTH_CUE.test(
          text.slice(Math.max(0, finding.start - 12), finding.start),
        ),
    );
    if (short.length) {
      const dates = found.flatMap((finding) => {
        if (finding.kind !== "date" && finding.kind !== "dateOfBirth")
          return [];
        const days = readDate(
          text.slice(finding.start, finding.end).replace(WEEKDAY_SUFFIX, ""),
          options.dayFirst ?? true,
        ).map((iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000));
        return [{ finding, days }];
      });
      const dropped = new Set(
        short.filter((finding) => !keepShortBirthCue(finding, dates)),
      );
      // The plain date found at the same place stays, as an event date.
      if (dropped.size)
        found.splice(
          0,
          found.length,
          ...found.filter((finding) => !dropped.has(finding)),
        );
    }
  }
  {
    const header = found.filter(
      (finding) =>
        finding.uncuedHeader &&
        !SURNAME_FIRST_IN_CAPITALS.test(text.slice(finding.start, finding.end)),
    );
    if (header.length) {
      const dropped = new Set(header);
      found.splice(
        0,
        found.length,
        ...found.filter((finding) => !dropped.has(finding)),
      );
    }
  }
  // A town inside a clinic's name ("CLSC de Saint-Michel-des-Saints") is part of that name.
  const clinics = found.filter((finding) => finding.kind === "clinic");
  const inClinic = (span: { start: number; end: number }) =>
    clinics.some(
      (clinic) => clinic.start <= span.start && span.end <= clinic.end,
    );
  // Names of Canadian health facilities and of municipalities of two or more words.
  for (const [kind, spans] of [
    ["clinic", facilitySpans(text)],
    ["address", municipalitySpans(text)],
  ] as const)
    for (const span of spans)
      if (
        !isMedicalTerm(text, span.start, span.end) &&
        !(
          kind === "address" &&
          (followsTitle(text, span.start) || inClinic(span))
        )
      )
        found.push({ kind, start: span.start, end: span.end });
  // A town alone in brackets ("(Rouyn-Noranda)").
  for (const span of bracketedMunicipalities(text))
    if (!isMedicalTerm(text, span.start, span.end))
      found.push({ kind: "address", start: span.start, end: span.end });
  // Each known name: whole wherever it stands (even across a line break),
  // in either order and surname first ("EXAMPLE, Avery"), and each of its
  // words, in any case, unless it is also an ordinary word.
  for (const name of options.knownNames) {
    const person = fold(name.trim()).toLowerCase();
    const parts = fold(name.trim())
      .split(/\s+/)
      .filter(Boolean)
      .map(escapeRegExp);
    // A one-word name that is too short, a common word or a relationship
    // word ("Mom", "Me") is never used, even whole.
    if (parts.length === 1 && !nameWords(fold(name)).length) continue;
    for (const order of nameOrders(parts))
      for (const match of text.matchAll(
        new RegExp(`(?<![\\p{L}])${order}(?![\\p{L}])`, "giu"),
      ))
        found.push({
          kind: "name",
          start: match.index,
          end: match.index + match[0].length,
          person,
        });
    for (const word of nameWords(fold(name)))
      for (const match of text.matchAll(wordPattern(word)))
        found.push({
          kind: "name",
          start: match.index,
          end: match.index + match[0].length,
          person,
        });
  }
  // Known clinics and doctors: whole, in any case.
  for (const [kind, names] of [
    ["clinic", options.knownClinics ?? []],
    ["doctor", options.knownDoctors ?? []],
  ] as const)
    for (const name of names) {
      const parts = fold(name).split(/\s+/).filter(Boolean).map(escapeRegExp);
      if (!parts.length) continue;
      const surname = fold(name).trim().split(/\s+/).pop()?.toLowerCase();
      for (const order of kind === "doctor"
        ? nameOrders(parts)
        : [parts.join("\\s+")])
        for (const match of text.matchAll(
          new RegExp(`(?<![\\p{L}])${order}(?![\\p{L}])`, "giu"),
        ))
          found.push({
            kind,
            start: match.index,
            end: match.index + match[0].length,
            group: kind === "doctor" ? surname : undefined,
          });
    }
  // A date in brackets right after a profile name is that person's date of
  // birth ("Avery Example (14/03/1979)").
  for (const name of options.knownNames) {
    const parts = fold(name.trim())
      .split(/\s+/)
      .filter(Boolean)
      .map(escapeRegExp);
    if (!parts.length) continue;
    for (const order of nameOrders(parts))
      for (const match of text.matchAll(
        new RegExp(
          `(?<![\\p{L}])${order}(?![\\p{L}])[ \\t]*[(（][ \\t]*(${DATE})[ \\t]*[)）]`,
          "giu",
        ),
      )) {
        const start = match.index + match[0].lastIndexOf(match[1]);
        found.push({
          kind: "dateOfBirth",
          start,
          end: start + match[1].length,
        });
      }
  }
  // A known birth date is a date of birth wherever it stands, in any form.
  const birthDates = new Set(options.knownBirthDates ?? []);
  if (birthDates.size)
    for (const form of DATE_FORMS) {
      if (form.partial) continue;
      for (const match of text.matchAll(new RegExp(form.pattern, "giu"))) {
        const read = readDate(match[0], options.dayFirst ?? true);
        if (read.some((iso) => birthDates.has(iso)))
          found.push({
            kind: "dateOfBirth",
            start: match.index,
            end: match.index + match[0].length,
          });
      }
    }
  return dropMonthNames(text, found);
}

/**
 * A month word inside a day-month-year (or month-year) date is part of the
 * date, not a name: a vault name such as "Rose Mai" or "Avril Testeau" must
 * not turn "le 14 mai 2026" into "le 14 [NAME 1] 2026". Names found only
 * as the month word are dropped there, so the date rule wins.
 */
function dropMonthNames(text: string, found: Finding[]): Finding[] {
  const spans: [number, number][] = [];
  for (const form of DATE_FORMS)
    for (const match of text.matchAll(new RegExp(form.pattern, "giu")))
      spans.push([match.index, match.index + match[0].length]);
  if (!spans.length) return found;
  return found.filter((finding) => {
    if (
      finding.kind !== "name" &&
      finding.kind !== "doctor" &&
      finding.kind !== "possibleName"
    )
      return true;
    const word = text
      .slice(finding.start, finding.end)
      .toLowerCase()
      .replace(/\.$/, "");
    if (!MONTH_WORDS.has(word)) return true;
    return !spans.some(([a, b]) => a <= finding.start && finding.end <= b);
  });
}

/** A name's parts as it stands in the document: as given, surname first
 * with a comma ("Example, Avery"), and the other way round. */
function nameOrders(parts: string[]): string[] {
  const orders = new Set<string>([parts.join("\\s+")]);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const rest = parts.slice(0, -1);
    orders.add(`${last},?\\s+${rest.join("\\s+")}`);
    orders.add([...parts].reverse().join("\\s+"));
  }
  return [...orders];
}

/** A capital first: "Avery", "AVERY", "O'Neil-Smith", "d'Amours". */
const writtenAsName = (word: string) => /^(?:[dD]['’])?\p{Lu}/u.test(word);

// Han text has no spaces between words, so a Han name stands anywhere.
const wordPattern = (word: string) =>
  HAN.test(word)
    ? new RegExp(escapeRegExp(word), "gu")
    : new RegExp(`(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`, "giu");

/**
 * Public medical terms a name rule must never remove (the allow-list): an eponym's name word
 * in one of its clinical phrases ("Guyon's canal", "Romberg test", "Bell's palsy", "maladie
 * d'Addison"), and a drug name. Without it a word that looks like a name inside such a phrase
 * would be taken out, and a later "Dr. Guyon" would take every "Guyon" with it.
 */
const GUARD_APOSTROPHE = /[’‘`´]/gu;
const guardKey = (value: string) =>
  fold(value).toLowerCase().replace(GUARD_APOSTROPHE, "'");
const EPONYM_FORMS = new Map<string, string[]>();
for (const entry of allowList.eponyms) {
  // An eponym named for several people stands alone too: "Wolff-Parkinson-White".
  const together =
    entry.tokens.length > 1
      ? [guardKey(entry.tokens.join("-")), guardKey(entry.tokens.join(" "))]
      : [];
  for (const token of entry.tokens) {
    // The whole token ("De Quervain") and each of its words ("Wolff" of
    // "Wolff-Parkinson-White") lead to the phrases it stands in.
    const whole = guardKey(token);
    for (const key of new Set([whole, ...whole.split(/[\s-]+/u)])) {
      if (key.length < 3) continue;
      const forms = EPONYM_FORMS.get(key) ?? [];
      // A name of several words is also guarded as it stands alone
      // ("Wolff-Parkinson-White", "De Quervain"), not only inside a phrase.
      if (/[\s-]/u.test(whole)) forms.push(whole);
      forms.push(...together);
      for (const form of entry.forms) forms.push(guardKey(form));
      EPONYM_FORMS.set(key, forms);
    }
  }
}
const DRUG_NAMES = new Set(allowList.drugs.map(guardKey));
// Phrases that look like a name or an address ("Dr. Reddy's", "St. John's wort") but are not.
const LOOKALIKES = allowList.lookalikes.map(guardKey);
const GUARD_REACH = 60;
// A drug name that is also a first name ("Ella", "Yasmin", "Diane", "Allegra") is spared only
// where the words beside it read as a drug: a strength, a form or a frequency right after it, a
// brand number ("Diane-35"), a drug verb right before it, or a place in a medication or allergy
// list. A role, a relation or a title before it ("daughter Ella", "Nurse Yasmin") is not enough,
// and neither is the same person named elsewhere in the text.
// After the word: a strength, a brand number ("Diane-35") or a counted form ("2 drops", "one
// tablet"). A frequency alone ("once", "twice a week", "daily") never makes the word a drug:
// "Her daughter Ella twice a week drives her" (#228 review).
const COUNT =
  "(?:\\d+|one|two|three|half|un|une|deux|trois|uno|una|dos|tres|um|uma|duas|três|jedn[aą]|dwie)";
const DRUG_STRENGTH_AFTER = new RegExp(
  `^(?:${[
    "-[ \\t]?\\d",
    "[ \\t]*\\(?[ \\t]*\\d+(?:[.,]\\d+)?[ \\t]*(?:mg|mcg|µg|ug|g|ml|units?|iu|ui|%)(?![\\p{L}])",
    `[ \\t]*,?[ \\t]+${COUNT}[ \\t]+(?:tablets?|capsules?|pills?|comprim[ée]s?|g[ée]lules?|c[áa]psulas?|comprimidos?|tabletk[aęi]|kapsułk[aęi]|drops?|puffs?|sprays?|patch(?:es)?|tabs?|caps?|injections?|gouttes?|gotas?|krople?|kropli)(?![\\p{L}])`,
  ].join("|")})`,
  "iu",
);
// A form word that is never an ordinary word, with no count: "Yasmin tablets".
const DRUG_FORM_AFTER =
  /^[ \t]*,?[ \t]+(?:tablets?|capsules?|pills?|comprim[ée]s?|g[ée]lules?|c[áa]psulas?|comprimidos?|tabletk[aęi]|kapsułk[aęi])(?![\p{L}])/iu;
// Prescription abbreviations, in capitals only: "Yasmin PO", "Allegra PRN".
const DRUG_ABBREVIATION_AFTER =
  /^[ \t]*,?[ \t]+(?:BID|TID|QID|QHS|QAM|QPM|PRN|PO|OD|q\d+h)(?![\p{L}])/u;
const DRUG_LIST_LABEL =
  /(?<![\p{L}])(?:medications?|meds|current medications|rx|allerg(?:y|ies)|m[ée]dicaments?|medicamentos?|medicaci[óo]n|leki|alergi(?:e|a|as))[ \t]*:/giu;
const DRUG_BEFORE =
  /(?:\b(?:discontinued|switched (?:from|to)|changed (?:from|to)|allergic to|allergy to|intolerant (?:of|to)|reaction to|dose of|trial of|refill of|allergique (?:au|à la|à)|alérgic[oa] a|alergia a|dose (?:de|du))|\bm(?:g|cg) of)[ \t]*$/iu;
const LIST_SEPARATOR = /[,;/+]|\b(?:and|or|et|ou|y|e|i)\b/iu;
function startsWithDrug(chunk: string): boolean {
  const words = guardKey(chunk)
    .split(/[ \t]+/u)
    .filter(Boolean);
  return (
    DRUG_NAMES.has(words[0] ?? "") ||
    DRUG_NAMES.has(words.slice(0, 2).join(" "))
  );
}
function readsAsDrug(
  text: string,
  start: number,
  end: number,
  afterPerson: boolean,
): boolean {
  // Only a short stretch on each side, on the same line: a page read as one
  // very long line must not be copied for every place a name stands.
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(Math.max(lineStart, start - 160), start);
  const lineEnd = text.indexOf("\n", end);
  const after = text.slice(
    end,
    Math.min(lineEnd < 0 ? text.length : lineEnd, end + 40),
  );
  if (DRUG_STRENGTH_AFTER.test(after)) return true;
  // Right after a role, a relation or a title, nothing weaker spares it.
  if (afterPerson) return false;
  if (
    DRUG_FORM_AFTER.test(after) ||
    DRUG_ABBREVIATION_AFTER.test(after) ||
    DRUG_BEFORE.test(before)
  )
    return true;
  // "Medications: Allegra, Yasmin, Ella": every item between the label and
  // the word starts with a drug name.
  let listStart = -1;
  for (const label of before.matchAll(DRUG_LIST_LABEL))
    listStart = label.index + label[0].length;
  if (listStart < 0) return false;
  return before
    .slice(listStart)
    .split(LIST_SEPARATOR)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .every(startsWithDrug);
}
// A title right before a word: "Dr. Holter" is a person even though "Holter" alone is on
// the allow-list (#228 review).
const TITLE_RIGHT_BEFORE =
  /(?:(?<![\p{L}])(?:Dr|Dre|Mr|Mrs|Ms|Mx|Miss|Mme|Mlle|Prof|Pr|Sr|Sra|Srta|Nurse|Pani|Pan)\.?|(?<![\p{L}])M\.)[ \t]+$/u;
/** `afterPerson`: a name rule found the word right after a role, a relation or a title. */
function isMedicalTerm(
  text: string,
  start: number,
  end: number,
  afterPerson = false,
): boolean {
  const span = guardKey(text.slice(start, end));
  const titled = TITLE_RIGHT_BEFORE.test(
    text.slice(Math.max(0, start - 14), start),
  );
  if (DRUG_NAMES.has(span) && readsAsDrug(text, start, end, afterPerson))
    return true;
  const from = Math.max(0, start - GUARD_REACH);
  const window = guardKey(text.slice(from, end + GUARD_REACH));
  const spanStart = start - from;
  const spanEnd = end - from;
  for (const phrase of LOOKALIKES)
    for (
      let at = window.indexOf(phrase);
      at >= 0;
      at = window.indexOf(phrase, at + 1)
    )
      if (at < spanEnd && spanStart < at + phrase.length) return true;
  for (const word of new Set([span, ...span.split(/[^\p{L}'-]+/u)])) {
    const forms = EPONYM_FORMS.get(word);
    if (!forms) continue;
    for (const form of forms) {
      if (titled && form === span) continue;
      for (
        let at = window.indexOf(form);
        at >= 0;
        at = window.indexOf(form, at + 1)
      )
        if (at < spanEnd && spanStart < at + form.length) return true;
    }
  }
  return false;
}

/** A clinical role belongs to this occurrence, never to a surname globally.
 * Matching-copy accents have already been folded. Direct identity findings
 * still win; this prevents their alias sweep from consuming an eponym. */
function clinicalNameOccurrence(
  text: string,
  start: number,
  end: number,
): boolean {
  if (isMedicalTerm(text, start, end)) return true;
  // Only the words next to the name matter, so only a short stretch on each
  // side is read: on a page read as one very long line the whole line would
  // be copied and scanned for every place a name stands.
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(Math.max(lineStart, start - 120), start);
  const lineEnd = text.indexOf("\n", end);
  const after = text.slice(
    end,
    Math.min(lineEnd < 0 ? text.length : lineEnd, end + 80),
  );
  const clinicalBefore = [
    ...before.matchAll(
      /\b(?:syndrome|disease|maladie|paralysis|paralysie|tenosynovitis|tenosynovite)[ \t]+(?:of|de|d['’])[ \t]*/giu,
    ),
  ].some((match) =>
    /^(?:\p{Lu}[\p{L}'’-]*[ \t]+){0,2}(?:\p{Lu}[\p{L}'’]*-)?$/u.test(
      before.slice(match.index + match[0].length),
    ),
  );
  return (
    clinicalBefore ||
    /^[ \t]*(?:['’]s[ \t]+)?(?:syndrome|disease|maladie|palsy|paralysis|paralysie|tenosynovitis|tenosynovite|sign|signe)\b/iu.test(
      after,
    )
  );
}

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
      nameWords(fold(name)).map((word) => word.toLowerCase()),
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
  // The same name found again and again (a signature on every line) is swept
  // once: its other places do not depend on which finding they came from.
  const swept = new Map<string, string>();
  for (const finding of named) {
    const whole = text.slice(finding.start, finding.end);
    const sweptKey = `${finding.kind}:${finding.kin ? "kin:" : ""}${whole.toLowerCase()}`;
    const earlier = swept.get(sweptKey);
    if (earlier !== undefined) {
      finding.group = earlier;
      continue;
    }
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
    swept.set(sweptKey, group);
    const place = (match: RegExpExecArray | RegExpMatchArray, as: string) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (clinicalNameOccurrence(text, start, end)) return;
      places.push({
        kind:
          /\s/u.test(match[0]) || writtenAsName(match[0])
            ? finding.kind
            : "possibleName",
        start,
        end,
        group: as,
        whole,
        swept: true,
        ...(finding.kin ? { kin: true as const } : {}),
      });
    };
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

function result(toSend: string, onDevice: OnDevice): Deidentified {
  const value = { toSend } as Deidentified;
  Object.defineProperty(value, "onDevice", {
    value: onDevice,
    enumerable: false,
  });
  return Object.freeze(value);
}

/** Takes identifying details out of `text` (#72). The text is cleaned
 * first (`cleanText`); the rules run on a matching copy with letters and
 * digits folded, and every removal covers whole characters of the cleaned
 * text. */
export function deidentify(
  text: string,
  options: DeidentifyOptions,
): Deidentified {
  const dayFirst = options.dayFirst ?? true;
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  const notes = { ...DEFAULT_NOTES, ...options.notes };
  const cleaned = cleanText(text);
  const matching = matchingCopy(cleaned.text);
  const copy = matching.copy;
  const found = resolve(find(copy, options));
  const findings = resolve([
    ...found,
    ...dropMonthNames(copy, otherPlaces(copy, found, options)),
  ]).map((finding) => {
    const [start, end] = toSourceRange(matching, finding.start, finding.end);
    return {
      ...finding,
      start,
      end,
      folded: copy.slice(finding.start, finding.end),
    };
  });
  return build(cleaned.text, findings, {
    dayFirst,
    labels,
    notes,
    otherLanguages: options.otherLanguages ?? [],
    cleaning: {
      replacedRuns: cleaned.replacedRuns,
      droppedCodePoints: cleaned.droppedCodePoints,
    },
  });
}

function nextPlaceholder(
  source: string,
  label: string,
  first: number,
  reserved: Set<string>,
  /** The same kind's word in the other languages (#215): a number one of
   * them already shows in the document is skipped too, so that a pasted
   * answer can read that mark in any language. */
  otherWords: readonly string[] = [],
): { number: number; replacement: string } {
  let number = first;
  // Check the complete candidate directly: custom labels can contain any
  // other marker, including an overlapping marker at the same position.
  const written = (word: string, number: number) =>
    source.includes(`[${word} ${number}]`) ||
    source.includes(`[${word} ${number},`);
  while (
    written(label, number) ||
    otherWords.some((word) => written(word, number)) ||
    reserved.has(`[${label} ${number}]`)
  )
    number++;
  const replacement = `[${label} ${number}]`;
  reserved.add(replacement);
  return { number, replacement };
}

/** A placeholder without its note: "[DATE 2, 14 days after DATE 1]" is
 * "[DATE 2]". */
const baseOf = (replacement: string) =>
  replacement.replace(/,[^\][]*\]$/u, "]");

/** 90 years in days: the age at which the app promises "90+". */
const NINETY_YEARS = Math.floor(90 * 365.2425);

function build(
  source: string,
  findings: Finding[],
  settings: Omit<OnDevice, "removed" | "possibleNames" | "source">,
): Deidentified {
  const { dayFirst, labels, notes } = settings;
  const others = settings.otherLanguages ?? [];
  // One placeholder per distinct detail of a kind (and per person, for
  // names), numbered in the order first seen.
  const numbers = new Map<string, number>();
  const counts = new Map<string, number>();
  const reserved = new Set(
    findings.flatMap((finding) =>
      finding.replacement === undefined ? [] : [baseOf(finding.replacement)],
    ),
  );
  /** The number for a detail: its own, once, then the same again. `word`
   * names the placeholder word (dates use `unclearDate`'s). */
  const numberFor = (counter: string, word: RemovedKind, identity: string) => {
    let number = numbers.get(identity);
    if (number === undefined) {
      number = nextPlaceholder(
        source,
        labels[word],
        (counts.get(counter) ?? 0) + 1,
        reserved,
        others.map((other) => other.labels[word]),
      ).number;
      counts.set(counter, number);
      numbers.set(identity, number);
    }
    return number;
  };
  const placeholder = (finding: Finding, original: string) => {
    const kind = finding.kind as Exclude<RemovedKind, "manual">;
    // A doctor is one placeholder by surname: "Dr. Blake Sample" and "Dr.
    // Sample" are the same person, as far as the text can tell.
    const words = original.toLowerCase().split(/\s+/);
    // An age of 90 or over: one number per age, so that two ages in one
    // document come back as their own.
    const age = kind === "age" ? /\d+/.exec(original)?.[0] : undefined;
    const identity = `${kind}:${
      age ??
      finding.person ??
      finding.group ??
      (kind === "doctor" ? words[words.length - 1] : words.join(" "))
    }`;
    const number = numberFor(kind, kind, identity);
    return noted(
      labels[kind],
      number,
      kind === "age" ? notes.ageOver90 : undefined,
    );
  };

  // Dates (#72): none is sent. Each distinct whole date gets a number in
  // calendar order, the same date always the same one, and a note with its
  // gap from the earliest date. A month and year, a year alone and a
  // numeric date that could be read two ways get a plain placeholder.
  const dateWord = labels.unclearDate;
  const readings = new Map<Finding, DateReading>();
  for (const finding of findings) {
    if (finding.kind !== "date" || finding.replacement !== undefined) continue;
    const reading =
      finding.reading ??
      readDateText(
        finding.folded ?? source.slice(finding.start, finding.end),
        dayFirst,
      );
    if (reading) readings.set(finding, reading);
  }
  const wholeDates = new Map<string, number>();
  for (const reading of readings.values())
    if (reading.kind === "full") wholeDates.set(reading.iso, reading.epochDay);
  const calendar = [...wholeDates.entries()].sort((a, b) => a[1] - b[1]);
  // A date 90 or more years before the latest one is most likely an unread
  // date of birth: a gap from it would give the patient's age to the day,
  // and the 90+ promise would not hold. It still gets its own number, but
  // is never the earliest date and never in a gap.
  const latestDay = calendar.length ? calendar[calendar.length - 1][1] : 0;
  const tooOld = new Set(
    calendar
      .filter(([, day]) => latestDay - day >= NINETY_YEARS)
      .map(([iso]) => iso),
  );
  const earliest = calendar.find(([iso]) => !tooOld.has(iso));
  const earliestDay = earliest ? earliest[1] : 0;
  let earliestNumber = 0;
  calendar.forEach(([iso]) => {
    const number = numberFor("date", "unclearDate", `date:${iso}`);
    if (earliest && iso === earliest[0]) earliestNumber = number;
  });
  const datePlaceholder = (reading: DateReading) => {
    if (reading.kind === "full") {
      const number = numberFor("date", "unclearDate", `date:${reading.iso}`);
      const days = reading.epochDay - earliestDay;
      return noted(
        dateWord,
        number,
        days > 0 && !tooOld.has(reading.iso)
          ? notes.daysAfter(days, dateWord, earliestNumber)
          : undefined,
      );
    }
    return noted(
      dateWord,
      numberFor("date", "unclearDate", `${reading.kind}:${reading.key}`),
    );
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
    let kind = finding.kind;
    if (finding.replacement !== undefined) {
      replacement = finding.replacement;
    } else if (finding.kind === "date") {
      const reading = readings.get(finding);
      if (!reading) continue;
      if (reading.kind === "unclear") kind = "unclearDate";
      replacement = datePlaceholder(reading);
    } else {
      const person =
        finding.kind === "name" || finding.kind === "doctor"
          ? (finding.person ??
            (finding.kin ? undefined : personOf(finding.whole ?? original)))
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
      kind,
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
  return result(text, { ...settings, removed, possibleNames, source });
}

/** "[LABEL n]", or "[LABEL n, note]". */
const noted = (label: string, number: number, note?: string) =>
  note ? `[${label} ${number}, ${note}]` : `[${label} ${number}]`;

/**
 * The patient removes more from the preview (#72): the part of the text to
 * send from `sentStart` to `sentEnd`, which must lie outside every
 * placeholder (a date included) already there, unless `over` is set: then
 * the parts it touches are taken into the new removal, whole (the native
 * re-check found a detail inside a placeholder, AI-02). It
 * becomes "[REMOVED n]".
 */
export function removeMore(
  deidentified: Deidentified,
  sentStart: number,
  sentEnd: number,
  options: { over?: boolean } = {},
): Deidentified {
  const { removed, possibleNames, source, ...settings } = deidentified.onDevice;
  // Map the range back to the document, through what came before it.
  let shift = 0;
  let start = -1;
  let end = -1;
  const swallowed = new Set<Removed>();
  for (const part of removed) {
    if (part.sentEnd <= sentStart) {
      shift += part.end - part.start - (part.sentEnd - part.sentStart);
      continue;
    }
    if (part.sentStart >= sentEnd) break;
    if (!options.over) throw new RangeError("overlaps a part already removed");
    swallowed.add(part);
    if (start < 0) start = Math.min(sentStart + shift, part.start);
    shift += part.end - part.start - (part.sentEnd - part.sentStart);
    end = Math.max(sentEnd + shift, part.end);
  }
  if (start < 0) start = sentStart + shift;
  if (end < 0) end = sentEnd + shift;
  if (start < 0 || end > source.length || end <= start)
    throw new RangeError("outside the text");
  const manual = removed.filter((part) => part.kind === "manual");
  const replacement = nextPlaceholder(
    source,
    settings.labels.manual,
    manual.length + 1,
    new Set(removed.map((part) => baseOf(part.replacement))),
    (settings.otherLanguages ?? []).map((other) => other.labels.manual),
  ).replacement;
  // Everything already decided stays as it was; only the new part is new.
  // A flagged word stays flagged unless the new part takes it.
  const findings: Finding[] = [
    ...removed
      .filter((part) => !swallowed.has(part))
      .map((part) => ({
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
      replacement,
    },
  ].sort((a, b) => a.start - b.start);
  return build(source, findings, settings);
}

/** A placeholder as written, split into its parts (#72): the word, the
 * number and the note after the number, if any. One grammar for every kind:
 * "[NAME 1]", "[DATE 2, 14 days after DATE 1]", "[AGE 1, 90+]". */
export function parsePlaceholder(
  text: string,
): { label: string; number: number; note?: string } | null {
  const found = PLACEHOLDER_SHAPE.exec(text);
  PLACEHOLDER_SHAPE.lastIndex = 0;
  if (!found || found[0] !== text) return null;
  return {
    label: found[1],
    number: Number(found[2]),
    ...(found[3] === undefined ? {} : { note: found[3] }),
  };
}
/** Anything shaped like one of ours: a word that is not a number, a number,
 * and perhaps a note. Square brackets and line ends never stand inside. */
const PLACEHOLDER_SHAPE =
  /\[([^\][,\d\n][^\][,\n]*?) (\d+)(?:, ([^\][\n]+))?\]/gu;

/** What one of this export's placeholders says (#215): its number and its
 * note, read back from the words it was written with. Null when it is not
 * one of these words' placeholders (a custom label, say): it is then put
 * back only as written. */
interface Mark {
  number: number;
  ageOver90?: true;
  daysAfter?: { days: number; ref: number };
}

function readMark(
  replacement: string,
  word: string,
  dateWord: string,
  notes: PlaceholderNotes,
): Mark | null {
  const head = `[${word} `;
  if (!replacement.startsWith(head) || !replacement.endsWith("]")) return null;
  const inner = /^(\d+)(?:, ([^]+))?$/u.exec(
    replacement.slice(head.length, -1),
  );
  if (!inner) return null;
  const number = Number(inner[1]);
  const note = inner[2];
  if (note === undefined) return { number };
  if (note === notes.ageOver90) return { number, ageOver90: true };
  // A gap note: find its two numbers by writing it again. A language may
  // group the digits of a long gap ("1,234", "1 234").
  const values = new Set<number>();
  for (const run of note.matchAll(/\d+(?:[,.   ]\d{3})*/gu)) {
    values.add(Number(run[0].replace(/\D/gu, "")));
    for (const digits of run[0].match(/\d+/gu) ?? [])
      values.add(Number(digits));
  }
  for (const days of values)
    for (const ref of values)
      if (notes.daysAfter(days, dateWord, ref) === note)
        return { number, daysAfter: { days, ref } };
  return null;
}

/** One of this export's placeholders as each language writes it: the same
 * kind, number and note, the word from one language and the note from any
 * (an answer may translate one and not the other). The first language is
 * the export's own. A word that is another kind's in some language is used
 * only when it is the export's own word for this kind. */
function spellings(
  part: Removed,
  languages: PlaceholderVocabulary[],
  kindsOf: Map<string, Set<RemovedKind>>,
): string[] {
  const kind: RemovedKind = part.kind === "date" ? "unclearDate" : part.kind;
  const [own] = languages;
  const mark = readMark(
    part.replacement,
    own.labels[kind],
    own.labels.unclearDate,
    own.notes,
  );
  if (!mark) return [];
  const noteIn = (language: PlaceholderVocabulary) =>
    mark.ageOver90
      ? language.notes.ageOver90
      : mark.daysAfter
        ? language.notes.daysAfter(
            mark.daysAfter.days,
            language.labels.unclearDate,
            mark.daysAfter.ref,
          )
        : undefined;
  const result = new Set<string>();
  for (const language of languages) {
    const word = language.labels[kind];
    if ((kindsOf.get(word)?.size ?? 0) > 1 && word !== own.labels[kind])
      continue;
    for (const noteLanguage of languages)
      result.add(noted(word, mark.number, noteIn(noteLanguage)));
  }
  return [...result];
}

/** One stretch of a pasted answer: as it was, put back, or placeholder-shaped
 * text that is not one of this export's. */
export interface RestoredPart {
  text: string;
  /** "restored": a placeholder of this export, put back exactly.
   * "flagged": shaped like one but not matching one, or one whose note was
   * changed: left as written, for the patient to check against the original. */
  kind: "plain" | "restored" | "flagged";
}

/**
 * Puts the details back into an answer that came back with the placeholders
 * (#72), on the device, and says what it could not (never guessing): each
 * placeholder of this export, written exactly as it was sent, becomes what it
 * stood for. A placeholder-shaped text that is not one of this export's, or
 * one of this export's whose note after the number was changed or left out,
 * is left as written and marked "flagged". A date that stood in several
 * spellings comes back as the first one. Ambiguous placeholders from older
 * snapshots (literal source markers or conflicting manual IDs) stay
 * unresolved, and are flagged.
 *
 * The answer may write a placeholder in another of the app's languages
 * (#215): the AI translated it, or was asked to answer in another language.
 * It is put back when it is the same mark, word, number and note, in one of
 * `otherLanguages`: "[DATE 2, 14 jours après DATE 1]" for "[DATE 2, 14 days
 * after DATE 1]". A word that means another kind in another language is
 * read only in this export's own words, and a mark that any language's
 * wording of it already shows in the document stays unresolved.
 */
export function restoreChecked(
  answer: string,
  deidentified: Deidentified,
): { text: string; parts: RestoredPart[]; flagged: string[] } {
  const back = new Map<string, string>();
  const firstPart = new Map<string, Removed>();
  const manualTokens = new Set(
    deidentified.onDevice.removed
      .filter((part) => part.kind === "manual")
      .map((part) => part.replacement),
  );
  const conflictingManual = new Set<string>();
  // Old overlapping removals could reuse a manual ID for a different detail.
  // Automatic names can intentionally share a canonical placeholder even
  // when their spelling differs; retain that existing grouping behavior.
  for (const part of deidentified.onDevice.removed) {
    const previous = back.get(part.replacement);
    if (
      manualTokens.has(part.replacement) &&
      previous !== undefined &&
      previous !== part.original
    )
      conflictingManual.add(part.replacement);
    if (previous === undefined) {
      back.set(part.replacement, part.original);
      firstPart.set(part.replacement, part);
    }
  }
  const { source, labels, notes } = deidentified.onDevice;
  const languages: PlaceholderVocabulary[] = [
    { labels, notes },
    ...(deidentified.onDevice.otherLanguages ?? []),
  ];
  // Each placeholder of this export as every language writes it (#215).
  const spelled = new Map<string, string[]>();
  if (languages.length > 1) {
    const kindsOf = new Map<string, Set<RemovedKind>>();
    for (const language of languages)
      for (const kind of Object.keys(language.labels) as RemovedKind[]) {
        const word = language.labels[kind];
        kindsOf.set(word, (kindsOf.get(word) ?? new Set()).add(kind));
      }
    for (const [replacement, part] of firstPart)
      spelled.set(replacement, spellings(part, languages, kindsOf));
  }
  for (const part of deidentified.onDevice.removed) {
    // Older snapshots may reuse a literal marker from the source. An answer
    // cannot tell its occurrences apart: leave that marker unresolved rather
    // than insert a person's detail into literal text. New allocations avoid
    // that ambiguity, in every language's wording of the mark.
    const bases = [
      part.replacement,
      ...(spelled.get(part.replacement) ?? []),
    ].map(baseOf);
    if (
      conflictingManual.has(part.replacement) ||
      bases.some(
        (base) =>
          source.includes(base) || source.includes(base.slice(0, -1) + ","),
      )
    )
      back.delete(part.replacement);
  }
  // The other languages' spellings of what can be put back; null when two
  // details would share one (flagged, never guessed).
  const elsewhere = new Map<string, string | null>();
  for (const [replacement, original] of back)
    for (const spelling of spelled.get(replacement) ?? []) {
      if (spelling === replacement) continue;
      const seen = elsewhere.get(spelling);
      const clash =
        (seen !== undefined && seen !== original) ||
        (firstPart.has(spelling) && back.get(spelling) !== original);
      elsewhere.set(spelling, clash ? null : original);
    }
  const parts: RestoredPart[] = [];
  const flagged: string[] = [];
  let at = 0;
  const plain = (end: number) => {
    if (end > at) parts.push({ text: answer.slice(at, end), kind: "plain" });
  };
  // Longest first, so that "[NAME 1]" never stands inside "[NAME 10]"'s place.
  // What this export sent is matched exactly, note and all; any other
  // placeholder-shaped text is flagged, never guessed.
  const keys = [...back.keys()].sort((x, y) => y.length - x.length);
  // A near miss is flagged too: this export's label words followed by a
  // number, in brackets or parentheses with any spacing and case, or bare in
  // capitals ("DATE 1" in a sentence). An answer often refers to a mark that
  // way, and it must not pass as "all matched". Every language's words count.
  const labelWords = [
    ...new Set(languages.flatMap((language) => Object.values(language.labels))),
  ].sort((x, y) => y.length - x.length);
  const caseless = (word: string) =>
    [...word]
      .map((character) =>
        character.toLowerCase() === character.toUpperCase()
          ? escapeRegExp(character)
          : `[${character.toLowerCase()}${character.toUpperCase()}]`,
      )
      .join("");
  const nearMiss = labelWords.length
    ? `|[\\[(][ \\t]*(?:${labelWords.map(caseless).join("|")})[ \\t]*\\d+[^\\])\\n]{0,80}[\\])]` +
      `|(?<![\\p{L}\\p{N}])(?:${labelWords.map(escapeRegExp).join("|")})[ \\u00a0]?\\d+(?!\\p{N})`
    : "";
  const pattern = new RegExp(
    `${keys.length ? `(${keys.map(escapeRegExp).join("|")})|` : "()(?!)|"}${PLACEHOLDER_SHAPE.source}${nearMiss}`,
    "gu",
  );
  for (const found of answer.matchAll(pattern)) {
    plain(found.index);
    const translated = elsewhere.get(found[0]);
    if (found[1] !== undefined && found[1] !== "") {
      parts.push({ text: back.get(found[1]) ?? found[1], kind: "restored" });
    } else if (typeof translated === "string") {
      parts.push({ text: translated, kind: "restored" });
    } else {
      parts.push({ text: found[0], kind: "flagged" });
      flagged.push(found[0]);
    }
    at = found.index + found[0].length;
  }
  plain(answer.length);
  return {
    text: parts.map((part) => part.text).join(""),
    parts,
    flagged,
  };
}

/** `restoreChecked`, as plain text. */
export function restore(answer: string, deidentified: Deidentified): string {
  return restoreChecked(answer, deidentified).text;
}
