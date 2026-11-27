import allowList from "../deidentify/eponymAllowList.json";
import type { Removed, RemovedKind } from "../deidentify/deidentify";

/**
 * Helpers for the preview of the text prepared for an AI (AnonymizePreview.tsx). They only read
 * a de-identification result; they find nothing new to remove, and they are not part of the
 * rules in src/deidentify.
 */

/** How many details of each kind were taken out, in the order each kind first appears in the
 * document. The input is the automatic result's list plus every removal the patient made, so
 * the counts follow the preview as it changes. */
export function removalCounts(
  removed: readonly Removed[],
): { kind: RemovedKind | "date"; count: number }[] {
  const counts = new Map<RemovedKind | "date", number>();
  for (const part of removed)
    counts.set(part.kind, (counts.get(part.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

// ---- Words still in the text that may identify someone ----------------------------------

/** A word or number left in the text to send that the patient should look at. */
export interface WordToCheck {
  /** Where it is in the text to send (the same offsets `removeMore` takes). */
  start: number;
  end: number;
  word: string;
}

/**
 * Capitalised words in the text of public medical terms, never worth a "check this": the
 * eponym and drug lists the name rules already use (read, not changed), a title before a name,
 * and the days and months. The match is by the lower-cased word.
 */
const KNOWN_WORDS: ReadonlySet<string> = (() => {
  const words = new Set<string>();
  for (const eponym of allowList.eponyms)
    for (const token of eponym.tokens) words.add(token.toLowerCase());
  for (const drug of allowList.drugs) words.add(drug.toLowerCase());
  for (const word of [
    // Titles.
    "dr",
    "dre",
    "mr",
    "mrs",
    "ms",
    "miss",
    "mme",
    "mlle",
    "prof",
    "pr",
    "sr",
    "sra",
    // Weekdays in English, French and Spanish, and months in English and French (the other
    // languages' months are not listed, so a name such as "Junio" is flagged).
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
    "lundi",
    "mardi",
    "mercredi",
    "jeudi",
    "vendredi",
    "samedi",
    "dimanche",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado",
    "domingo",
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
  ])
    words.add(word);
  return words;
})();

const WORD = /\p{L}[\p{L}\p{M}]*(?:-\p{L}[\p{L}\p{M}]*)*/gu;
const LONG_NUMBER = /(?<![\p{L}\p{N}])\d{3,}(?![\p{L}\p{N}])/gu;
const TITLE_BEFORE_STOP = /\b(?:Dr|Dre|Mr|Mrs|Ms|Mme|Mlle|Prof|Pr|St|Ste)\.$/i;

/** Whether the word at `index` starts a sentence or a line (a list bullet and a number before
 * it do not count): a capital there is only grammar. A colon is not a sentence end, so a word
 * after a label ("Referred by: Patel") is still looked at; neither is "Dr." a sentence end. */
function startsASentence(text: string, index: number): boolean {
  let at = index - 1;
  while (at >= 0 && /[ \t"'“‘«(\[]/.test(text[at])) at -= 1;
  if (at < 0) return true;
  const before = text[at];
  if (before === "\n" || before === "\r") return true;
  if (/[.!?…]/.test(before))
    return !TITLE_BEFORE_STOP.test(text.slice(Math.max(0, at - 5), at + 1));
  const lineStart = text.lastIndexOf("\n", at) + 1;
  return /^[\s\-–—•*·\d.)]*$/.test(text.slice(lineStart, index));
}

/**
 * Every word that starts with a capital letter and does not start a sentence, unless it is a
 * known medical or eponym word, and every number of three or more digits, that is still in the
 * text to send. Placeholders and marked removals (`removed`) and the words already offered as
 * possible names (`taken`) are left out. The result is only a list to look at: nothing is
 * removed or decided here, and the rules that find names live in src/deidentify.
 */
export function wordsToCheck(
  toSend: string,
  removed: readonly Removed[],
  taken: readonly { sentStart: number; sentEnd: number }[] = [],
): WordToCheck[] {
  const covered = (start: number, end: number) =>
    removed.some((part) => start < part.sentEnd && end > part.sentStart) ||
    taken.some((part) => start < part.sentEnd && end > part.sentStart);
  const found: WordToCheck[] = [];
  for (const match of toSend.matchAll(WORD)) {
    const word = match[0];
    const start = match.index;
    const end = start + word.length;
    if (!/^\p{Lu}/u.test(word) || !/\p{Ll}/u.test(word) || word.length < 2)
      continue;
    if (covered(start, end) || startsASentence(toSend, start)) continue;
    if (word.split("-").some((part) => KNOWN_WORDS.has(part.toLowerCase())))
      continue;
    found.push({ start, end, word });
  }
  for (const match of toSend.matchAll(LONG_NUMBER)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!covered(start, end)) found.push({ start, end, word: match[0] });
  }
  return found.sort((a, b) => a.start - b.start);
}
