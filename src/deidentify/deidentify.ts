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
  /** The placeholder words, in the app's language; English when not given. */
  labels?: Partial<PlaceholderLabels>;
  /** The notes after a placeholder's number, in the app's language. */
  notes?: Partial<PlaceholderNotes>;
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
  const dateText = text.replace(WEEKDAY_PREFIX, "").replace(WEEKDAY_SUFFIX, "");
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
  const dateText = text.replace(WEEKDAY_PREFIX, "");
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
const LABEL_PART = `${NAME_PART}(?![\\p{L}'’-]|[ \\t]*[:#])`;
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
])}(?:[ \\t]*:|[ \\t]+[-–—])`;
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
const NOT_NAMES = new Set(
  foldAll([
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
  /** A name after a family word: a relative, who may share the patient's
   * surname without being the patient. */
  kin?: true;
  /** A day and a month: not when the month is the lower-case word "may"
   * ("may 5 mg"). */
  notLowerCaseMay?: true;
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
  {
    kind: "dateOfBirth",
    pattern: new RegExp(
      `(?:\\bDOB|\\bD\\.O\\.B\\.?|\\bDate of birth|\\bBirth ?date|\\bBorn(?:[ \\t]+on)?|(?<![\\p{L}\\d.])b\\.|\\bDate de naissance|\\bnaissance|\\bDDN|\\bN[ée]e?[ \\t]+(?:le|en)|` +
        `\\bFecha de nacimiento|\\bNacid[oa](?:[ \\t]+el)?|\\bF\\.?[ \\t]?nac\\.?|\\bData de nascimento|\\bNascid[oa](?:[ \\t]+em)?|\\bNasc\\.|` +
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
  // A social insurance number: nine digits in threes (joined by a space, a
  // hyphen or, as French documents write it, a point), or after its label.
  {
    kind: "sin",
    pattern:
      /\b(?:SIN|NAS|Social [Ii]nsurance(?: [Nn]umber| [Nn]o\.?| #)?|[Nn]uméro d['’]assurance sociale)[ \t]*[:#]?[ \t]*(\d{3}[ .-]?\d{3}[ .-]?\d{3})\b/gu,
    group: 1,
  },
  // A sensitive field may describe a value as valid, invalid or mistyped.
  // Its label, not a checksum, identifies the field. Descriptors stay on
  // this line, contain no digits or sentence punctuation, and are bounded.
  {
    kind: "sin",
    pattern:
      /\b(?:SIN|NAS|Social [Ii]nsurance(?: [Nn]umber)?|[Nn]uméro d['’]assurance sociale)[ \t]+[\p{L}][\p{L}'’ -]{0,47}[ \t]*[:#]?[ \t]*(\d{3}[ .-]?\d{3}[ .-]?\d{3})\b/gu,
    group: 1,
  },
  // Known cost: any nine digits in equal threes match, so "Lot 123.456.789"
  // is removed too, as "Lot 123 456 789" always was.
  {
    kind: "sin",
    pattern: /(?<![\d-])(?<!\d\.)\d{3}([ .-])\d{3}\1\d{3}(?![\d-])(?!\.\d)/g,
  },
  // A web address: with its scheme or "www.", or a bare domain with a common
  // ending, and whatever follows it.
  {
    kind: "web",
    pattern:
      /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ca|org|net|gov|edu|info|io|health|fr|uk|us)\b(?:\/[^\s<>"'()[\]]*)?/gi,
  },
  // An age of 90 or over, which is identifying on its own.
  {
    kind: "age",
    pattern:
      /\b(?:(?:9\d|1[01]\d)[ -](?:years?|yrs?|y)[ -]?old|(?:9\d|1[01]\d)[ \t]?(?:y\.?o\.?|yo|y\/o)|aged?[ \t]*:?[ \t]*(?:9\d|1[01]\d)|(?:âgée?[ \t]+de[ \t]+)?(?:9\d|1[01]\d)[ \t]+ans)(?![\p{L}\d])/giu,
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
      `(?<![\\p{L}])(?:(?:Mr|Mrs|Ms|Miss|Mx|Prof|Pr|Mme|Mlle|Sra|Srta|Sr|Don|Doña|Doña|Pani|Pan)\\.?|M\\.)[ \\t]+(${INITIALS}${CAPITALIZED_NAME})`,
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
      `(?<![\\p{L}])(?:(?:${CLINICIAN_TITLE}|NP|RN|RPN|RM|IPS)[ \\t]*:|${CLINICIAN_TITLE}[ \\t]*,?[ \\t]+)[ \\t]*(${CLINICIAN_NAME})`,
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
      `(?<![\\p{L}])(?:nurse|pharmacist|physiotherapist|physio|social worker|technologist|technician|sonographer|radiologist|surgeon|paramedic|therapist|midwife|dietitian|resident|infirmière|infirmier|pharmacienne|pharmacien|physiothérapeute|radiologue|chirurgienne|chirurgien|technologue|technicienne|technicien|enfermera|enfermero|farmacéutica|farmacéutico|fisioterapeuta|enfermeira|enfermeiro|farmacêutica|farmacêutico|fisioterapeuta|pielęgniarka|pielęgniarz|farmaceuta|fizjoterapeuta)[ \\t]*,?[ \\t]+(${NAME_PART}(?:[ \\t]+(?:${PARTICLE}[ \\t]+)*${NAME_PART}){1,3})`,
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
      ])}[ \\t]*,?[ \\t]+(${CAPITALIZED_NAME})`,
      "gu",
    ),
    group: 1,
    kin: true,
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
  ...DATE_FORMS.filter((form) => !form.labelOnly && !form.partial).map(
    (form) => ({
      kind: "date" as const,
      pattern: new RegExp(
        `${WEEKDAY_BEFORE}${form.pattern}${WEEKDAY_AFTER}`,
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

// The rules run on the matching copy, so their accented letters are folded
// as the copy's are ("Hôpital" finds "Hopital", which is how the copy
// spells it).
for (const rule of RULES)
  rule.pattern = new RegExp(fold(rule.pattern.source), rule.pattern.flags);
for (const form of DATE_FORMS) form.pattern = fold(form.pattern);

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
for (const range of RANGES)
  range.pattern = new RegExp(fold(range.pattern.source), range.pattern.flags);

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
      if (
        (rule.kind === "name" || rule.kind === "doctor") &&
        isMedicalTerm(text, start, start + trimmed.length)
      )
        continue;
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
      });
      // Only an immediately linked checksum control inherits a SIN/NAS
      // field. An unrelated nine-digit measurement never inherits it.
      if (rule.kind === "sin") {
        const control =
          /^[ \t]*;[ \t]*(?:checksum[- ](?:in)?valid[ \t]+control|controle[ \t]+a[ \t]+somme[ \t]+(?:in)?valide)[ \t]*:[ \t]*(\d{3}[ .-]?\d{3}[ .-]?\d{3})\b/iu.exec(
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

function find(text: string, options: DeidentifyOptions): Finding[] {
  const found: Finding[] = findRanges(text);
  found.push(...ruleFindings(text, options));
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

/** A clinical role belongs to this occurrence, never to a surname globally.
 * Matching-copy accents have already been folded. Direct identity findings
 * still win; this prevents their alias sweep from consuming an eponym. */
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
for (const entry of allowList.eponyms)
  for (const token of entry.tokens) {
    const key = guardKey(token);
    const forms = EPONYM_FORMS.get(key) ?? [];
    for (const form of entry.forms) forms.push(guardKey(form));
    EPONYM_FORMS.set(key, forms);
  }
const DRUG_NAMES = new Set(allowList.drugs.map(guardKey));
const GUARD_REACH = 60;
function isMedicalTerm(text: string, start: number, end: number): boolean {
  const span = guardKey(text.slice(start, end));
  if (DRUG_NAMES.has(span)) return true;
  const from = Math.max(0, start - GUARD_REACH);
  const window = guardKey(text.slice(from, end + GUARD_REACH));
  const spanStart = start - from;
  const spanEnd = end - from;
  for (const word of span.split(/[^\p{L}'-]+/u)) {
    const forms = EPONYM_FORMS.get(word);
    if (!forms) continue;
    for (const form of forms) {
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
): { number: number; replacement: string } {
  let number = first;
  // Check the complete candidate directly: custom labels can contain any
  // other marker, including an overlapping marker at the same position.
  while (
    source.includes(`[${label} ${number}]`) ||
    source.includes(`[${label} ${number},`) ||
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
  // One placeholder per distinct detail of a kind (and per person, for
  // names), numbered in the order first seen.
  const numbers = new Map<string, number>();
  const counts = new Map<string, number>();
  const reserved = new Set(
    findings.flatMap((finding) =>
      finding.replacement === undefined ? [] : [baseOf(finding.replacement)],
    ),
  );
  /** The number for a detail: its own, once, then the same again. */
  const numberFor = (counter: string, label: string, identity: string) => {
    let number = numbers.get(identity);
    if (number === undefined) {
      number = nextPlaceholder(
        source,
        label,
        (counts.get(counter) ?? 0) + 1,
        reserved,
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
    const number = numberFor(kind, labels[kind], identity);
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
    const number = numberFor("date", dateWord, `date:${iso}`);
    if (earliest && iso === earliest[0]) earliestNumber = number;
  });
  const datePlaceholder = (reading: DateReading) => {
    if (reading.kind === "full") {
      const number = numberFor("date", dateWord, `date:${reading.iso}`);
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
      numberFor("date", dateWord, `${reading.kind}:${reading.key}`),
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
 */
export function restoreChecked(
  answer: string,
  deidentified: Deidentified,
): { text: string; parts: RestoredPart[]; flagged: string[] } {
  const back = new Map<string, string>();
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
    if (previous === undefined) back.set(part.replacement, part.original);
  }
  const source = deidentified.onDevice.source;
  for (const part of deidentified.onDevice.removed) {
    // Older snapshots may reuse a literal marker from the source. An answer
    // cannot tell its occurrences apart: leave that marker unresolved rather
    // than insert a person's detail into literal text. New allocations avoid
    // that ambiguity.
    const base = baseOf(part.replacement);
    if (
      conflictingManual.has(part.replacement) ||
      source.includes(base) ||
      source.includes(base.slice(0, -1) + ",")
    )
      back.delete(part.replacement);
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
  // way, and it must not pass as "all matched".
  const labelWords = [
    ...new Set(Object.values(deidentified.onDevice.labels)),
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
    if (found[1] !== undefined && found[1] !== "") {
      parts.push({ text: back.get(found[1]) ?? found[1], kind: "restored" });
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
