/**
 * The name remover (#72): takes identifying details out of a document's text
 * on this device, before any of it could be sent to a cloud model. Nothing
 * here touches the network; it is plain text in, plain text out.
 *
 * It removes names (the patient's profile names, and names after a title or
 * a label such as "Patient:"), health card and record numbers, dates of
 * birth, addresses, postal codes, phone numbers, email addresses, and clinic
 * and doctor names. Every other date is shifted by the same number of days,
 * so the gaps between them stay. Each removed detail becomes a placeholder,
 * such as "[NAME 1]", the same one each time the same detail appears.
 *
 * It is rules, not understanding: a rare condition, an unusual job or a small
 * town in free text can still point to a person, and a name with no title or
 * label that is not a profile name is not found. The patient's preview, where
 * more can be removed by hand (`removeMore`), is the last check.
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

export interface Deidentified {
  /** The text to send, with placeholders and shifted dates. */
  text: string;
  /** Everything taken out or shifted, in the order it appears. */
  removed: Removed[];
  /** How many days every date was moved; kept on the device. */
  dateShiftDays: number;
  /** The document as it was; kept on the device, for `removeMore`. */
  source: string;
}

export interface DeidentifyOptions {
  /** Names known to be the patient's or a family member's: every profile
   * name. Each word of three or more letters is removed wherever it stands
   * alone. */
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
const PRIORITY: Record<RemovedKind | "date", number> = {
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
};

interface Finding {
  kind: RemovedKind | "date";
  start: number;
  end: number;
  /** For names: the person they belong to, so that every part of one
   * person's name shares a placeholder. */
  person?: string;
  /** Already decided (when more is removed later): kept as it was. */
  replacement?: string;
}

const MONTHS = [
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
const MONTH_WORD =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
// Every date form read: ISO, day-month-year with a month name, month-day-year
// with a month name, and day/month/year with slashes or dashes.
const DATE_FORMS = [
  "\\b\\d{4}-\\d{2}-\\d{2}\\b",
  `\\b\\d{1,2}[ -]${MONTH_WORD}[ ,-]*\\d{4}\\b`,
  `\\b${MONTH_WORD} \\d{1,2},? \\d{4}\\b`,
  "\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{4}\\b",
];
const DATE = `(?:${DATE_FORMS.join("|")})`;

const NAME_WORD = "[A-Z][A-Za-z'’-]+";
const CAPITALIZED_NAME = `${NAME_WORD}(?: ${NAME_WORD}){0,3}`;
// "EXAMPLE, Avery" and "Avery EXAMPLE" both come after a label.
const LABELLED_NAME = `(?:[A-Z][A-Z'’-]+, ${NAME_WORD}(?: ${NAME_WORD})?|${CAPITALIZED_NAME})`;

const PROVINCES =
  "(?:ON|BC|QC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU|Ontario|British Columbia|Qu[eé]bec|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland and Labrador|Prince Edward Island|Yukon|Northwest Territories|Nunavut)";
const STREET_TYPE =
  "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Crescent|Cres|Place|Pl|Terrace|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Trail|Square|Sq|Gate|Row)";
const CLINIC_WORDS =
  "(?:Family Health Team|Family Practice|Medical Clinic|Medical Centre|Medical Center|Health Centre|Health Center|Health Sciences Centre|Clinic|Hospital|Laboratories|Laboratory|Imaging|Diagnostics|Pharmacy)";

/** A rule: what it finds, and which part of a match is the detail. */
interface Rule {
  kind: RemovedKind | "date";
  pattern: RegExp;
  /** The capture group holding the detail; the whole match when absent. */
  group?: number;
}

const RULES: Rule[] = [
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  // Labelled first: whatever follows the label, in any form.
  {
    kind: "healthCard",
    pattern:
      /\b(?:Health card(?: number| no\.?| #)?|Health (?:insurance )?number|HCN|PHN|OHIP|RAMQ|MSP|AHCIP|Health #)\s*[:#]?\s*([A-Z0-9][A-Z0-9 -]{5,}[A-Z0-9])/gi,
    group: 1,
  },
  // Ontario (10 digits and a version code) and Quebec (4 letters, 8 digits),
  // unlabelled.
  {
    kind: "healthCard",
    pattern:
      /\b\d{4}[- ]?\d{3}[- ]?\d{3}[- ]?[A-Z]{2}\b|\b[A-Z]{4} ?\d{4} ?\d{4}\b/g,
  },
  {
    kind: "recordNumber",
    pattern:
      /\b(?:MRN|Medical record(?: number| no\.?| #)?|Chart(?: number| no\.?| #)?|Record(?: number| no\.?| #)|Hospital(?: number| no\.?| #)|Patient ID|Accession(?: number| no\.?| #)?|Requisition(?: number| no\.?| #)?|Lab(?: number| no\.?| #)|Encounter(?: number| no\.?| #)?|Visit(?: number| no\.?| #)|Case(?: number| no\.?| #)|File(?: number| no\.?| #))\s*[:#]?\s*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)/gi,
    group: 1,
  },
  {
    kind: "dateOfBirth",
    pattern: new RegExp(
      `\\b(?:DOB|D\\.O\\.B\\.?|Date of birth|Birth ?date|Born)\\s*[:]?\\s*(${DATE})`,
      "gi",
    ),
    group: 1,
  },
  {
    kind: "phone",
    pattern:
      /(?:\+?1[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]?\d{3}[ .-]\d{4}\b(?:\s*(?:ext\.?|x)\s*\d{1,5}\b)?/gi,
  },
  {
    kind: "postalCode",
    pattern:
      /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/g,
  },
  {
    kind: "postalCode",
    pattern:
      /\b(?:A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+(\d{5}(?:-\d{4})?)\b/g,
    group: 1,
  },
  {
    kind: "address",
    pattern: /\b(?:Address|Mailing address|Home address)\s*:\s*([^\n]+)/gi,
    group: 1,
  },
  {
    kind: "address",
    pattern: new RegExp(
      `\\b\\d{1,6}(?:-\\d{1,6})? (?:[A-Z][A-Za-z'’]+\\.? ){1,4}${STREET_TYPE}\\b\\.?(?: (?:East|West|North|South|E|W|N|S)\\b)?(?:,? (?:Unit|Apt|Apartment|Suite|#) ?\\w+)?`,
      "g",
    ),
  },
  {
    kind: "address",
    pattern: /\b(?:P\.?O\.? Box|Box) \d+\b/gi,
  },
  {
    kind: "address",
    pattern: new RegExp(
      `\\b[A-Z][a-zà-ÿ]+(?:[ -][A-Z][a-zà-ÿ]+)*, ${PROVINCES}\\b`,
      "g",
    ),
  },
  {
    kind: "clinic",
    pattern: new RegExp(
      `\\b(?:[A-Z][A-Za-zà-ÿ'’]+ ){1,5}${CLINIC_WORDS}\\b(?: (?:of|de) (?:[A-Z][A-Za-zà-ÿ'’]+ ?){1,3})?|\\b(?:Hôpital|Clinique|Centre hospitalier)(?: [A-Za-zà-ÿ'’]+){1,5}`,
      "g",
    ),
  },
  {
    kind: "doctor",
    pattern: new RegExp(`\\b(?:Dr|Doctor)\\.? (${CAPITALIZED_NAME})`, "g"),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `\\b(?:Mr|Mrs|Ms|Miss|Mx|Prof)\\.? (${CAPITALIZED_NAME})`,
      "g",
    ),
    group: 1,
  },
  {
    kind: "name",
    pattern: new RegExp(
      `\\b(?:Patient(?: name)?|Name|Re|Next of kin|Emergency contact|Contact|Spouse|Parent|Guardian)\\s*:\\s*(${LABELLED_NAME})`,
      "g",
    ),
    group: 1,
  },
  {
    kind: "doctor",
    pattern: new RegExp(
      `\\b(?:Referred by|Referring physician|Physician|Provider|Ordering provider|Attending|Signed|Electronically signed by|Reported by|Family doctor|cc|Copy to)\\s*:\\s*(?:Dr\\.? )?(${CAPITALIZED_NAME})`,
      "gi",
    ),
    group: 1,
  },
  // A closing, then the name on the next non-empty line.
  {
    kind: "name",
    pattern: new RegExp(
      `\\b(?:Sincerely|Yours truly|Regards|Best regards|Kind regards),\\s*\\n(?:\\s*\\n)*\\s*(?:Dr\\.? )?(${CAPITALIZED_NAME})`,
      "g",
    ),
    group: 1,
  },
  { kind: "date", pattern: new RegExp(DATE, "gi") },
];

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function find(text: string, options: DeidentifyOptions): Finding[] {
  const found: Finding[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const detail = rule.group ? match[rule.group] : match[0];
      if (!detail) continue;
      const offset = rule.group ? match[0].indexOf(detail) : 0;
      const start = match.index + offset;
      // A label's value may run past the detail into trailing spaces.
      const trimmed = detail.replace(/[\s,;.]+$/, "");
      found.push({ kind: rule.kind, start, end: start + trimmed.length });
    }
  }
  // Every word of a known name, wherever it stands alone, as that person;
  // and the whole name first, even across a line break, so that it is one
  // placeholder.
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
    const words = name
      .split(/[^\p{L}'’-]+/u)
      .filter((word) => word.length >= 3);
    for (const word of words) {
      const pattern = new RegExp(
        `(?<![\\p{L}])${escapeRegExp(word)}(?![\\p{L}])`,
        "giu",
      );
      for (const match of text.matchAll(pattern))
        found.push({
          kind: "name",
          start: match.index,
          end: match.index + match[0].length,
          person,
        });
    }
  }
  return found;
}

/** Keeps the findings that win where they overlap: the higher priority, then
 * the longer. */
function resolve(findings: Finding[]): Finding[] {
  const ranked = [...findings].sort(
    (a, b) =>
      PRIORITY[a.kind] - PRIORITY[b.kind] ||
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

function parseDate(text: string, dayFirst: boolean): Date | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return utc(+iso[1], +iso[2], +iso[3]);
  const numeric = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (numeric) {
    let [day, month] = [+numeric[1], +numeric[2]];
    // One of them over 12 settles it; otherwise the option does.
    if (day <= 12 && (month > 12 || !dayFirst)) [day, month] = [month, day];
    return utc(+numeric[3], month, day);
  }
  const words = text
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const monthIndex = (word: string) =>
    MONTHS.findIndex((month) => month.startsWith(word.slice(0, 3)));
  if (words.length !== 3) return null;
  const [a, b, c] = words;
  if (/^\d+$/.test(a)) return utc(+c, monthIndex(b) + 1, +a);
  return utc(+c, monthIndex(a) + 1, +b);
}

function utc(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? date : null;
}

const pad = (value: number) => String(value).padStart(2, "0");
const MONTH_NAMES = MONTHS.map(
  (month) => month[0].toUpperCase() + month.slice(1),
);

/** The shifted date, written as the original was. */
function formatLike(original: string, date: Date, dayFirst: boolean): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (/^\d{4}-\d{2}-\d{2}$/.test(original))
    return `${year}-${pad(month)}-${pad(day)}`;
  const numeric = /^(\d{1,2})([/.])(\d{1,2})[/.]\d{4}$/.exec(original);
  if (numeric) {
    const separator = numeric[2];
    const first = +numeric[1];
    const second = +numeric[3];
    const wasDayFirst = first > 12 || (second <= 12 && dayFirst);
    return wasDayFirst
      ? `${pad(day)}${separator}${pad(month)}${separator}${year}`
      : `${pad(month)}${separator}${pad(day)}${separator}${year}`;
  }
  const name = MONTH_NAMES[month - 1];
  // Abbreviated if the original was, with its full stop if it had one.
  const word = /[A-Za-z]+/.exec(original)?.[0] ?? "";
  const abbreviated =
    word.length <= 4 &&
    word.toLowerCase() !== "june" &&
    word.toLowerCase() !== "july";
  const monthText = abbreviated
    ? name.slice(0, 3) + (/[A-Za-z]{3}\./.test(original) ? "." : "")
    : name;
  if (/^\d/.test(original)) {
    const separator = original.includes("-") ? "-" : " ";
    return `${day}${separator}${monthText}${separator}${year}`;
  }
  return `${monthText} ${day}${original.includes(",") ? "," : ""} ${year}`;
}

function randomShift(): number {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  const days = 30 + (values[0] % 336);
  return values[1] % 2 ? days : -days;
}

/** Takes identifying details out of `text` (#72). */
export function deidentify(
  text: string,
  options: DeidentifyOptions,
): Deidentified {
  const dateShiftDays = options.dateShiftDays ?? randomShift();
  return build(
    text,
    resolve(find(text, options)),
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
  const people = findings.filter((finding) => finding.person);
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
  for (const finding of findings) {
    const original = source.slice(finding.start, finding.end);
    let replacement: string;
    if (finding.replacement !== undefined) {
      replacement = finding.replacement;
    } else if (finding.kind === "date") {
      const date = parseDate(original, dayFirst);
      if (!date) continue;
      const shifted = new Date(date.getTime() + dateShiftDays * 86_400_000);
      replacement = formatLike(original, shifted, dayFirst);
    } else {
      const person =
        finding.kind === "name" || finding.kind === "doctor"
          ? (finding.person ?? personOf(original))
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
  return { text, removed, dateShiftDays, source };
}

/**
 * The patient removes more from the preview (#72): the part of the text to
 * send from `sentStart` to `sentEnd`, which must lie outside every
 * placeholder and shifted date already there. It becomes "[REMOVED n]".
 */
export function removeMore(
  result: Deidentified,
  sentStart: number,
  sentEnd: number,
): Deidentified {
  // Map the range back to the document, through what came before it.
  let shift = 0;
  for (const part of result.removed) {
    if (part.sentEnd <= sentStart) {
      shift += part.end - part.start - (part.sentEnd - part.sentStart);
      continue;
    }
    if (part.sentStart < sentEnd)
      throw new RangeError("overlaps a part already removed");
  }
  const start = sentStart + shift;
  const end = sentEnd + shift;
  if (start < 0 || end > result.source.length || end <= start)
    throw new RangeError("outside the text");
  const manual = result.removed.filter((part) => part.kind === "manual");
  // Everything already decided stays as it was; only the new part is new.
  const findings: Finding[] = [
    ...result.removed.map((part) => ({
      kind: part.kind,
      start: part.start,
      end: part.end,
      replacement: part.replacement,
    })),
    {
      kind: "manual" as const,
      start,
      end,
      replacement: `[REMOVED ${manual.length + 1}]`,
    },
  ].sort((a, b) => a.start - b.start);
  return build(result.source, findings, result.dateShiftDays, true);
}

/**
 * Puts the details back into an answer that came back with the placeholders
 * (#72), on the device: each placeholder becomes what it stood for, and each
 * shifted date the date it was. A date the answer wrote some other way is
 * left shifted.
 */
export function restore(answer: string, result: Deidentified): string {
  const back = new Map<string, string>();
  for (const part of result.removed)
    if (!back.has(part.replacement)) back.set(part.replacement, part.original);
  // Longest first, so that "[NAME 1]" never stands inside "[NAME 10]"'s place.
  const keys = [...back.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return answer;
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "g");
  return answer.replace(pattern, (found) => back.get(found) ?? found);
}
