/**
 * Two copies of a document's text for the AI helper (#72 part B, threat
 * model AI-01).
 *
 * `cleanText` makes the text the saved file holds: the original, never
 * NFKC-normalised (which would turn "10⁹/L" into "109/L"), with every
 * default-ignorable code point and bidirectional control dropped, each run
 * of private-use, unassigned or surrogate code points replaced by one U+FFFD
 * (symbol fonts map visible signs such as µ, ≥ and ± to private use; the
 * preview marks and counts them), every other space folded to U+0020 (tabs
 * stay) and the line and paragraph separators folded to a line break. The
 * ranges come from one generated table (`unicodeCleaningTable.ts`), pinned
 * to one Unicode version, which native code shares.
 *
 * `matchingCopy` makes the copy the remover's rules run on: each code point
 * of the cleaned text on its own as its compatibility form (full-width
 * digits and letters folded), accents removed, Ł Ø Đ ß and common
 * look-alike letters from other scripts folded to their Latin letters, and
 * format characters dropped, with a map back to the cleaned text, so that a
 * removal always covers whole original characters. Nothing here touches the
 * network.
 */
import { LINE_BREAKS, REMOVED, REPLACED, SPACES } from "./unicodeCleaningTable";

export interface CleanedText {
  /** The text the file will hold, before any removal. */
  text: string;
  /** Runs of private-use, unassigned or surrogate code points, each now one
   * U+FFFD. */
  replacedRuns: number;
  /** Default-ignorable code points dropped. */
  droppedCodePoints: number;
}

const inRanges = (
  ranges: readonly (readonly [number, number])[],
  codePoint: number,
) => {
  // Binary search: the tables are sorted and disjoint.
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
};

/** A lone surrogate, which no file can hold as UTF-8. */
const isLoneSurrogate = (text: string, index: number) => {
  const unit = text.charCodeAt(index);
  if (unit < 0xd800 || unit > 0xdfff) return false;
  if (unit <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    return !(next >= 0xdc00 && next <= 0xdfff);
  }
  return true;
};

/** The text the saved file holds, before any removal. Idempotent. */
export function cleanText(raw: string): CleanedText {
  let text = "";
  let replacedRuns = 0;
  let droppedCodePoints = 0;
  let inReplacedRun = false;
  for (let index = 0; index < raw.length; ) {
    const lone = isLoneSurrogate(raw, index);
    const codePoint = lone ? 0xfffd : (raw.codePointAt(index) as number);
    const length = lone ? 1 : codePoint > 0xffff ? 2 : 1;
    if (!lone && inRanges(REMOVED, codePoint)) {
      droppedCodePoints += 1;
    } else if (lone || inRanges(REPLACED, codePoint)) {
      if (!inReplacedRun) {
        text += "�";
        replacedRuns += 1;
        inReplacedRun = true;
      }
      index += length;
      continue;
    } else if (inRanges(SPACES, codePoint)) {
      text += " ";
    } else if (inRanges(LINE_BREAKS, codePoint)) {
      text += "\n";
    } else {
      text += raw.slice(index, index + length);
    }
    inReplacedRun = false;
    index += length;
  }
  return { text, replacedRuns, droppedCodePoints };
}

/** The copy the rules run on, and the way back to the cleaned text. */
export interface MatchingCopy {
  copy: string;
  /** For each index of `copy` (and one past its end): the index in the
   * cleaned text of the code point it came from. */
  toSource: Uint32Array;
  /** For each index of `copy`: the index in the cleaned text just after the
   * code point it came from. */
  sourceEnd: Uint32Array;
}

/** Letters from other scripts that look like Latin letters (a small part of
 * UTS #39's confusables), and Latin letters whose accent is no combining
 * mark, so that NFD leaves them alone. */
const FOLDS: Record<string, string> = {
  ł: "l",
  Ł: "L",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ı: "i",
  ħ: "h",
  Ħ: "H",
  ŧ: "t",
  Ŧ: "T",
  // Cyrillic
  а: "a",
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ѕ: "s",
  ј: "j",
  һ: "h",
  ԁ: "d",
  ԛ: "q",
  ѡ: "w",
  ҽ: "e",
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  Х: "X",
  І: "I",
  Ѕ: "S",
  Ј: "J",
  // Greek
  α: "a",
  ο: "o",
  ν: "v",
  ι: "i",
  κ: "k",
  ρ: "p",
  τ: "t",
  υ: "u",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
};

const COMBINING = /\p{M}/gu;
const FORMAT = /\p{Cf}/gu;

/** One code point of the cleaned text, folded for matching: zero or more
 * characters. */
function foldCodePoint(character: string): string {
  const compatible = character.normalize("NFKC");
  let folded = "";
  for (const part of compatible) {
    const direct = FOLDS[part];
    if (direct !== undefined) {
      folded += direct;
      continue;
    }
    folded += part.normalize("NFD").replace(COMBINING, "").replace(FORMAT, "");
  }
  return folded;
}

/** The copy the remover's rules run on. */
export function matchingCopy(source: string): MatchingCopy {
  let copy = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < source.length; ) {
    const codePoint = source.codePointAt(index) as number;
    const length = codePoint > 0xffff ? 2 : 1;
    const character = source.slice(index, index + length);
    const folded = /^[\x00-\x7f]$/.test(character)
      ? character
      : foldCodePoint(character);
    for (let unit = 0; unit < folded.length; unit += 1) {
      starts.push(index);
      ends.push(index + length);
    }
    copy += folded;
    index += length;
  }
  starts.push(source.length);
  return {
    copy,
    toSource: Uint32Array.from(starts),
    sourceEnd: Uint32Array.from(ends),
  };
}

/** A range of the copy, as the range of the cleaned text it came from, which
 * always covers whole code points. */
export function toSourceRange(
  matching: MatchingCopy,
  start: number,
  end: number,
): [number, number] {
  if (end <= start) {
    const at = matching.toSource[Math.min(start, matching.copy.length)];
    return [at, at];
  }
  return [matching.toSource[start], matching.sourceEnd[end - 1]];
}
