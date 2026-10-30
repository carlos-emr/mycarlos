import { describe, expect, it } from "vitest";
import { cleanText, matchingCopy, toSourceRange } from "./textCleaning";
import {
  LINE_BREAKS,
  REMOVED,
  REPLACED,
  SPACES,
  UNICODE_VERSION,
} from "./unicodeCleaningTable";
import rustTable from "../../src-tauri/src/unicode_cleaning_table.rs?raw";

// #72 part B, threat model AI-01: the text the file holds, and the copy the
// rules run on. Synthetic text only.

describe("the saved text's cleaning", () => {
  it("drops default-ignorable code points and bidirectional controls", () => {
    const cleaned = cleanText("Av­ery​ Ex‮am‬ple﻿");
    expect(cleaned.text).toBe("Avery Example");
    expect(cleaned.droppedCodePoints).toBe(5);
    expect(cleaned.replacedRuns).toBe(0);
  });

  it("drops variation selectors and tag characters, which could hide text", () => {
    const tagged = "ok\u{e0041}\u{e0042}\u{e007f}";
    expect(cleanText(tagged).text).toBe("ok");
    expect(cleanText("1️︎2").text).toBe("12");
  });

  it("turns each run of private-use or unassigned code points into one U+FFFD", () => {
    // A Symbol-font µg, ≥ and ± as private-use code points: visible marks
    // stay, so "5 µg" never becomes "5 g".
    const cleaned = cleanText("5 g,  10\u{10ffff}");
    expect(cleaned.text).toBe("5 �g, � 10�");
    expect(cleaned.replacedRuns).toBe(3);
    // A lone surrogate too: no file can hold it.
    expect(cleanText("a\ud800b").text).toBe("a�b");
  });

  it("folds every other space to a space, keeps tabs, and folds line separators", () => {
    expect(cleanText("a b c\td e f").text).toBe("a b c\td\ne\nf");
  });

  it("never NFKC-normalises the text: lab notation stays", () => {
    expect(cleanText("10⁹/L and ½ tablet").text).toBe("10⁹/L and ½ tablet");
  });

  it("is idempotent", () => {
    const once = cleanText("x­ y z").text;
    expect(cleanText(once).text).toBe(once);
  });

  it("uses the same table as native code, pinned to one Unicode version", () => {
    expect(rustTable).toContain(`UNICODE_VERSION: &str = "${UNICODE_VERSION}"`);
    const rustRanges = (name: string) => {
      const block = new RegExp(
        `const ${name}: &\\[\\(u32, u32\\)\\] = &\\[([^;]*)\\];`,
      ).exec(rustTable);
      expect(block, name).not.toBeNull();
      return [...block![1].matchAll(/\(0x([0-9a-f]+), 0x([0-9a-f]+)\)/g)].map(
        (m) => [parseInt(m[1], 16), parseInt(m[2], 16)],
      );
    };
    for (const [name, table] of [
      ["REMOVED", REMOVED],
      ["REPLACED", REPLACED],
      ["SPACES", SPACES],
      ["LINE_BREAKS", LINE_BREAKS],
    ] as const)
      expect(rustRanges(name), name).toEqual(table.map((range) => [...range]));
  });
});

describe("the matching copy", () => {
  it("folds full-width digits and letters, accents and look-alike letters", () => {
    const { copy } = matchingCopy("Ｒenée Côté, Łukasz Øst, Ａvеry");
    // The last "Avery" has a Cyrillic е.
    expect(copy).toBe("Renee Cote, Lukasz Ost, Avery");
  });

  it("maps a range back to whole characters of the cleaned text", () => {
    const source = "Straße 5, Côté";
    const matching = matchingCopy(source);
    expect(matching.copy).toBe("Strasse 5, Cote");
    // "ss" came from one ß: a range ending inside it covers the whole ß.
    const [start, end] = toSourceRange(
      matching,
      0,
      matching.copy.indexOf("s") + 1,
    );
    expect(source.slice(start, end)).toBe("Straß");
    const cote = matching.copy.indexOf("Cote");
    expect(source.slice(...toSourceRange(matching, cote, cote + 4))).toBe(
      "Côté",
    );
    expect(
      toSourceRange(matching, matching.copy.length, matching.copy.length),
    ).toEqual([source.length, source.length]);
  });

  it("keeps characters outside the basic plane whole", () => {
    const source = "Dr 😀 Côté";
    const matching = matchingCopy(source);
    const at = matching.copy.indexOf("Cote");
    expect(source.slice(...toSourceRange(matching, at, at + 4))).toBe("Côté");
  });
});
