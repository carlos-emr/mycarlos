// Names of Canadian health facilities and municipalities, matched on the device (#72). Public
// data, Open Government Licence – Canada (see LICENSE_NOTES.md); no text leaves the computer.
// Also the given names and Chinese surnames that gate one rule of the anonymizer (see
// `isKnownGivenName` and `startsWithKnownSurname`), from public statistics built by
// `scripts/build-given-names.py`, each source and licence in LICENSE_NOTES.md.
import { matchingCopy } from "./textCleaning";
import facilities from "./gazetteers/healthcare-facilities.json";
import municipalities from "./gazetteers/municipalities.json";
import givenNamesEn from "./gazetteers/given-names-en.json";
import givenNamesFr from "./gazetteers/given-names-fr.json";
import givenNamesPl from "./gazetteers/given-names-pl.json";
import givenNamesEs from "./gazetteers/given-names-es.json";
import surnamesZh from "./gazetteers/surnames-zh.json";

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
// Small words that stay in lower case inside a place's name: "Saint-Jean-sur-Richelieu".
const LINKING_WORDS = new Set([
  "de",
  "du",
  "des",
  "la",
  "le",
  "les",
  "sur",
  "en",
  "aux",
  "au",
  "a",
  "d",
  "l",
  "of",
  "the",
  "and",
  "et",
]);
// Words of geography, direction, colour, number and size. A town whose words are all such
// words is also an everyday phrase ("West End", "North Shore", "Three Rivers", "Red Rock"):
// only that town is read as written or after a place word; every other town, in any case.
const EVERYDAY_PLACE_WORDS = new Set([
  "north",
  "south",
  "east",
  "west",
  "northern",
  "southern",
  "eastern",
  "western",
  "upper",
  "lower",
  "middle",
  "new",
  "old",
  "big",
  "little",
  "great",
  "grand",
  "red",
  "white",
  "black",
  "blue",
  "green",
  "silver",
  "golden",
  "gold",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "twin",
  "rivers",
  "river",
  "rock",
  "rocks",
  "end",
  "shore",
  "shores",
  "view",
  "views",
  "island",
  "islands",
  "lake",
  "lakes",
  "bay",
  "falls",
  "hill",
  "hills",
  "park",
  "point",
  "harbour",
  "harbor",
  "valley",
  "creek",
  "springs",
  "spring",
  "beach",
  "bridge",
  "mountain",
  "mount",
  "field",
  "fields",
  "forest",
  "grove",
  "ridge",
  "plains",
  "plain",
  "landing",
  "crossing",
  "centre",
  "center",
  "junction",
  "cove",
  "heights",
  "meadow",
  "meadows",
  "pond",
  "rapids",
  "narrows",
  "head",
  "mills",
  "mill",
  "brook",
  "glen",
  "wood",
  "woods",
  "sound",
  "inlet",
  "bend",
  "lakeside",
  "riverside",
  "seaside",
  "hillside",
  "bayside",
  "cliff",
  "cliffs",
  "corner",
  "corners",
  "flat",
  "flats",
  "prairie",
  "pines",
  "pine",
  "oak",
  "oaks",
  "maple",
  "maples",
  "cedar",
  "cedars",
  "birch",
  "elm",
  "willow",
  "willows",
  "long",
  "short",
  "high",
  "low",
  "deep",
  "clear",
  "fort",
  "port",
  "bluff",
  "bluffs",
  "side",
  "sands",
  "sand",
  "stone",
  "stones",
  "bank",
  "banks",
  "run",
  "vista",
  "fall",
  "waters",
  "water",
  "city",
  "town",
  "village",
  "county",
  "riviere",
  "lac",
  "baie",
  "ile",
  "mont",
  "pointe",
  "grande",
  "petite",
  "petit",
  "haut",
  "haute",
  "bas",
  "basse",
  "nord",
  "sud",
  "est",
  "ouest",
]);
const isEverydayPhrase = (words: string[]) => {
  const core = words.filter((word) => !LINKING_WORDS.has(word));
  return (
    core.length > 0 && core.every((word) => EVERYDAY_PLACE_WORDS.has(word))
  );
};
// A place word right before a town written in lower case: "grew up in west end".
const PLACE_BEFORE =
  /(?:^|[^\p{L}])(?:in|from|to|at|near|à|a|de|en|em|w|z|na)[ \t]+$/iu;
/** `asWrittenFor`: names that must stand as written (each word, but a linking word, starts with
 * a capital) or right after a place word, so "the west end" is not the town of West End
 * (#239 review). */
function spansOf(
  text: string,
  index: Index,
  asWrittenFor?: (words: string[]) => boolean,
): Span[] {
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
      // Not "at the north shore": "The North Shore" is a town only as written.
      const asWritten = asWrittenFor?.(words) ?? false;
      const afterPlaceWord =
        asWritten &&
        !LINKING_WORDS.has(words[0]) &&
        PLACE_BEFORE.test(
          text.slice(Math.max(0, tokens[at].start - 8), tokens[at].start),
        );
      let all = true;
      for (let k = 0; k < words.length && all; k++) {
        if (tokens[at + k].word !== words[k]) all = false;
        else if (
          asWritten &&
          !afterPlaceWord &&
          !LINKING_WORDS.has(words[k]) &&
          !/^\p{Lu}/u.test(text.slice(tokens[at + k].start, tokens[at + k].end))
        )
          all = false;
        else if (
          k > 0 &&
          // "Mental Health & Addiction Services" (#239 review).
          !/^[ \t.,'’&-]{1,3}$/u.test(
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
  spansOf(text, MUNICIPALITIES, isEverydayPhrase);

const ALL_MUNICIPALITIES = new Set(
  municipalities.names.map((name) => wordsOf(name).join(" ")),
);
/** A municipality alone between brackets: "(Rouyn-Noranda)". The span is the name, not the brackets. */
export function bracketedMunicipalities(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/\(([^()\n]{2,40})\)/gu)) {
    const inner = match[1].trim();
    if (!ALL_MUNICIPALITIES.has(wordsOf(inner).join(" "))) continue;
    const start = match.index + 1 + match[1].indexOf(inner);
    spans.push({ start, end: start + inner.length });
  }
  return spans;
}

// Given names (English, French, Polish and Spanish lists together) in the matching copy's folding: lower
// case, accents removed. The lists keep names that are also ordinary words (Rose, May, Faith) on
// purpose: the gate only widens one rule that still needs its own shape, and a missed name is the
// worse mistake.
const GIVEN_NAMES = new Set(
  [givenNamesEn, givenNamesFr, givenNamesPl, givenNamesEs].flatMap((list) =>
    list.names.map((name) => fold(name).replace(/’/gu, "'")),
  ),
);

/**
 * Whether `word` is a given name found in public statistics for the app's Latin-script
 * languages. A hyphenated name ("Jean-Philippe") counts when the whole or its first part is.
 */
export function isKnownGivenName(word: string): boolean {
  const folded = fold(word).replace(/’/gu, "'");
  if (GIVEN_NAMES.has(folded)) return true;
  const hyphen = folded.indexOf("-");
  return hyphen > 1 && GIVEN_NAMES.has(folded.slice(0, hyphen));
}

const SURNAMES_ZH = new Set(surnamesZh.names);

// Care words and topics that begin with a character that is also a surname (高血压 "high blood
// pressure", 白内障 "cataract", 康复 "rehabilitation", 居家 "at home", 常规 "routine"). A header such
// as "居家护理计划 为高血压" is a topic, not a person. Checked as a prefix, simplified and
// traditional forms. Not complete: a Han name is only taken when it also has the length of a
// surname and a given name (see `isLikelyHanName`), so a long topic never reaches this list.
const HAN_TOPIC_PREFIXES = [
  ...[
    "高血压",
    "高血壓",
    "高血脂",
    "高血糖",
    "高龄",
    "高齡",
    "白内障",
    "白內障",
    "白血病",
  ],
  ...[
    "白癜风",
    "白癜風",
    "黄疸",
    "黃疸",
    "黄斑",
    "黃斑",
    "康复",
    "康復",
    "家庭",
    "家人",
  ],
  ...[
    "家属",
    "家屬",
    "居家",
    "常规",
    "常規",
    "成人",
    "成年",
    "阳性",
    "陽性",
    "阴性",
    "陰性",
  ],
  ...[
    "严重",
    "嚴重",
    "危重",
    "危险",
    "危險",
    "麻醉",
    "干预",
    "干預",
    "宣教",
    "包扎",
    "包紮",
  ],
  ...[
    "滑倒",
    "焦虑",
    "焦慮",
    "暴力",
    "怀孕",
    "懷孕",
    "全身",
    "全面",
    "全科",
    "全程",
    "宫颈",
  ],
  ...[
    "宮頸",
    "阴道",
    "陰道",
    "梅毒",
    "霍乱",
    "霍亂",
    "艾滋",
    "房颤",
    "房顫",
    "步态",
    "步態",
  ],
  ...[
    "步行",
    "关节",
    "關節",
    "后续",
    "後續",
    "后期",
    "後期",
    "养老",
    "養老",
    "支气管",
  ],
  ...[
    "支氣管",
    "支持",
    "管理",
    "能力",
    "舒适",
    "舒適",
    "路径",
    "路徑",
    "安宁",
    "安寧",
  ],
  ...[
    "安全",
    "平衡",
    "单侧",
    "單側",
    "双侧",
    "雙側",
    "左侧",
    "左側",
    "石膏",
    "金属",
    "金屬",
  ],
  ...[
    "周围",
    "周圍",
    "温度",
    "溫度",
    "连续",
    "連續",
    "空腹",
    "简易",
    "簡易",
    "通常",
  ],
  ...[
    "红肿",
    "紅腫",
    "冷冻",
    "冷凍",
    "毛细",
    "毛細",
    "季节",
    "季節",
    "田间",
    "常见",
    "常見",
  ],
];

/**
 * Whether Han text looks like a person's name: a known surname (the Hundred Family Surnames and
 * Taiwan's register) of one character and a given name of one or two, or a surname of two
 * characters and a given name of one or two, and not a care topic that merely begins with a
 * surname character. A Han given name is one or two ordinary characters, so the surname, not a
 * given-name list, is the gate for Chinese.
 */
export function isLikelyHanName(text: string): boolean {
  const characters = [...text];
  const one =
    characters.length >= 2 &&
    characters.length <= 3 &&
    SURNAMES_ZH.has(characters[0]);
  const two =
    characters.length >= 3 &&
    characters.length <= 4 &&
    SURNAMES_ZH.has(characters.slice(0, 2).join(""));
  return (
    (one || two) && !HAN_TOPIC_PREFIXES.some((word) => text.startsWith(word))
  );
}
