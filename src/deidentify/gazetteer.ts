// Names of Canadian health facilities and municipalities, matched on the device (#72). Public
// data, Open Government Licence – Canada (see LICENSE_NOTES.md); no text leaves the computer.
import { matchingCopy } from "./textCleaning";
import facilities from "./gazetteers/healthcare-facilities.json";
import municipalities from "./gazetteers/municipalities.json";

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
const fold = (value: string) => matchingCopy(value).copy.toLowerCase();
const wordsOf = (value: string) =>
  [...fold(value).matchAll(WORD)].map((match) => match[0].replace(/’/gu, "'"));

/** Names by their first word, each as its words, longest name first. */
type Index = Map<string, string[][]>;
function indexOf(names: string[], minWords: number): Index {
  const index: Index = new Map();
  for (const name of names) {
    const words = wordsOf(name);
    if (words.length < minWords) continue;
    const list = index.get(words[0]) ?? [];
    list.push(words);
    index.set(words[0], list);
  }
  for (const list of index.values()) list.sort((a, b) => b.length - a.length);
  return index;
}
const FACILITIES = indexOf(facilities.names, 2);
// A municipality of one word is too often an ordinary word or a surname: the address and
// province rules read it when a street or a province stands beside it.
const MUNICIPALITIES = indexOf(municipalities.names, 2);

export interface Span {
  start: number;
  end: number;
}

/**
 * Where a name of `index` stands in `text` (the matching copy): whole words, in any case,
 * the words separated by no more than a space or a bit of punctuation on one line. The longest
 * name at a place wins.
 */
function spansOf(text: string, index: Index): Span[] {
  const tokens = [...text.matchAll(WORD)].map((match) => ({
    word: match[0].toLowerCase().replace(/’/gu, "'"),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const spans: Span[] = [];
  for (let at = 0; at < tokens.length; at++) {
    const candidates = index.get(tokens[at].word);
    if (!candidates) continue;
    for (const words of candidates) {
      if (at + words.length > tokens.length) continue;
      let all = true;
      for (let k = 0; k < words.length && all; k++) {
        if (tokens[at + k].word !== words[k]) all = false;
        else if (
          k > 0 &&
          !/^[ \t.,'’-]{1,3}$/u.test(
            text.slice(tokens[at + k - 1].end, tokens[at + k].start),
          )
        )
          all = false;
      }
      if (!all) continue;
      spans.push({
        start: tokens[at].start,
        end: tokens[at + words.length - 1].end,
      });
      at += words.length - 1;
      break;
    }
  }
  return spans;
}

/** Health facility names standing in `text`. */
export const facilitySpans = (text: string) => spansOf(text, FACILITIES);
/** Municipality names of two or more words standing in `text`. */
export const municipalitySpans = (text: string) =>
  spansOf(text, MUNICIPALITIES);
