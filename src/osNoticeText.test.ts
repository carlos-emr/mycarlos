import { describe, expect, it } from "vitest";
import { LOCALES } from "./i18n";

// Everything the app can put outside its own window (a system notification, the tray icon's
// menu and tooltip) is a fixed sentence from the message catalogue: no name, document, clinic or
// file, and no parameter that could carry one. This reads the catalogue in every language and the
// native sources, so that a new text of this kind, or one given a parameter, has to be reviewed
// here before it ships.
//
// What this covers: the catalogue's own text, and which native code asks for it. What it cannot
// cover: a push provider's payload (an iPhone alert is whatever the portal puts in the push; this
// repository has no text of its own for it).

const catalogues = import.meta.glob("/src/i18n/locales/fluent/*.ftl", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const nativeSources = import.meta.glob("/src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The messages that reach the operating system's own surfaces. */
const OS_KEYS = [
  "native-notice-arrival",
  "native-notice-test",
  "native-tray-open",
  "native-tray-quit",
  "native-tray-tooltip",
  "native-tray-waiting",
];

/** A catalogue's messages: key to its whole value (continuation lines joined). */
function messagesOf(source: string): Map<string, string> {
  const messages = new Map<string, string>();
  let key: string | null = null;
  for (const line of source.split("\n")) {
    const start = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s?(.*)$/.exec(line);
    if (start) {
      key = start[1];
      messages.set(key, start[2]);
    } else if (key && /^\s+\S/.test(line)) {
      messages.set(key, `${messages.get(key)}\n${line.trim()}`);
    } else if (!line.trim()) {
      key = null;
    }
  }
  return messages;
}

const byLocale = (locale: string) => {
  const path = `/src/i18n/locales/fluent/${locale}.ftl`;
  expect(catalogues[path], `${path} is read`).toBeTypeOf("string");
  return messagesOf(catalogues[path]);
};

describe("the text the operating system shows for myCarlos", () => {
  it("is exactly these catalogue messages: a new native notice or tray text has to be placed here", () => {
    const english = byLocale("en");
    const found = [...english.keys()]
      .filter((key) => /^native-(notice|tray)-/.test(key))
      .sort();
    expect(found).toEqual(OS_KEYS);
  });

  it.each(LOCALES)(
    "%s: each is one fixed sentence, with no placeholder, no selector and no line break",
    (locale) => {
      const messages = byLocale(locale);
      for (const key of OS_KEYS) {
        const value = messages.get(key);
        expect(value, `${locale} ${key} exists`).toBeTypeOf("string");
        // A parameter, a term, a function call or a selector would make it variable.
        expect(value, `${locale} ${key}`).not.toMatch(/[{}$]/);
        expect(value, `${locale} ${key} is one line`).not.toContain("\n");
        expect(value!.trim(), `${locale} ${key} is not empty`).not.toBe("");
      }
    },
  );

  it("is asked for by the native code through these message ids only (outside the id list itself)", () => {
    const used = new Set<string>();
    for (const [path, text] of Object.entries(nativeSources)) {
      if (path.endsWith("/ui_text_ids.rs")) continue;
      for (const match of text.matchAll(
        /MessageId::(Native(?:Notice|Tray)\w+)/g,
      ))
        used.add(match[1]);
    }
    expect([...used].sort()).toEqual([
      "NativeNoticeArrival",
      "NativeNoticeTest",
      "NativeTrayOpen",
      "NativeTrayQuit",
      "NativeTrayTooltip",
      "NativeTrayWaiting",
    ]);
  });

  it("is handed to the system's notification call from two places, both given the catalogue sentence", () => {
    // `Backend::accept(body)` is the one call that reaches a toast, a freedesktop notice or a
    // macOS notification: it is only ever given the sentence `arrival_notice` or the test
    // notice's text produced.
    const runtime =
      nativeSources["/src-tauri/src/document_notification_runtime.rs"];
    expect(runtime).toBeTypeOf("string");
    // Production code only: drop the test module (`#[cfg(test)] mod tests`).
    const production = runtime.split(/#\[cfg\(test\)\]\s*mod tests/)[0];
    const calls = [...production.matchAll(/\.accept\(([^,)]*)/g)].map((match) =>
      match[1].trim(),
    );
    expect(calls).toEqual(["&body", "&body"]);
    // And `body` is built from the two catalogue helpers, not from arrival data.
    expect(production).toMatch(
      /fn arrival_notice\(locale: Option<UiLocale>\) -> Option<String>/,
    );
    expect(production).toMatch(
      /fn test_notice_text\(locale: Option<UiLocale>\) -> Option<String>/,
    );
  });
});
