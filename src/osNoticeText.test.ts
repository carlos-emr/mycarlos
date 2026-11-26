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
      // A blank line can sit inside a multi-line message (the kit's text): it ends nothing.
      if (key) messages.set(key, `${messages.get(key)}\n`);
    } else if (/^\S/.test(line)) {
      // A comment or anything else at the left edge ends the message.
      key = null;
    }
  }
  return messages;
}

/** A Rust file's production code: the text up to its test module (`#[cfg(test)]` followed by a
 * `mod`). Not the first bare `#[cfg(test)]`: the notification runtime puts that attribute on
 * production members before the calls this reads, so cutting there would drop them. */
function productionOf(text: string): string {
  return text.split(/#\[cfg\(test\)\]\s*(?:pub(?:\([a-z]+\))?\s+)?mod \w+/)[0];
}

/** The text between the opening bracket at `open` and its match. */
function bracketedBy(
  text: string,
  open: number,
  begin: string,
  end: string,
): string {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === begin) depth += 1;
    else if (text[index] === end && --depth === 0)
      return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}
const bracketed = (text: string, open: number) =>
  bracketedBy(text, open, "{", "}");

/** A call's arguments, split at the commas that are not inside any bracket. */
function splitArguments(inside: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of inside) {
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
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
        expect(value!.trim(), `${locale} ${key} is one line`).not.toContain(
          "\n",
        );
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

  it("is handed to the system's notification call from three places in all, each given a catalogue sentence", () => {
    // `Backend::accept(text, still_current)` is the one call that reaches a toast, a freedesktop
    // notice or a macOS notification. Every native source is read (a new backend or a new caller
    // in another file is seen), not only the runtime's; the two-argument form is that call (the
    // other `accept`s are a socket's and a grammar's).
    const calls: string[] = [];
    for (const [path, source] of Object.entries(nativeSources)) {
      const text = productionOf(source);
      for (const match of text.matchAll(/\.accept\(/g)) {
        // The arguments with brackets matched, so a built string (`&format!(…)`) is one argument.
        const args = splitArguments(
          bracketedBy(text, match.index! + match[0].length - 1, "(", ")"),
        );
        if (args.length === 2)
          calls.push(`${path.replace("/src-tauri/src/", "")} ${args[0]}`);
      }
    }
    expect(calls).toEqual([
      "document_notification_runtime.rs &body",
      "document_notification_runtime.rs &body",
      // The tray poller's Windows toast for "a document is waiting" while locked.
      "tray_poller.rs text",
    ]);
    // That `text` is only ever what `act_on` shows: the waiting sentence of the catalogue.
    const shows: string[] = [];
    for (const [path, text] of Object.entries(nativeSources))
      if (path.endsWith("/tray_poller.rs"))
        for (const match of productionOf(text).matchAll(
          /\bnotify\.show\(([^;]+)\);/g,
        ))
          shows.push(match[1].trim());
    expect(shows).toEqual(["&waiting_notice_text(locale)"]);
    // And `body` is built from the two catalogue helpers, not from arrival data.
    const runtime = productionOf(
      nativeSources["/src-tauri/src/document_notification_runtime.rs"],
    );
    expect(runtime).toMatch(
      /fn arrival_notice\(locale: Option<UiLocale>\) -> Option<String>/,
    );
    expect(runtime).toMatch(
      /fn test_notice_text\(locale: Option<UiLocale>\) -> Option<String>/,
    );
  });

  it("gives the tray's menu and tooltip only the words its own helper returns", () => {
    const tray = productionOf(
      nativeSources["/src-tauri/src/desktop_background.rs"],
    );
    // Every call that puts text on the tray, with the name it is given.
    const given = [
      ...tray.matchAll(
        /MenuItem::with_id\(\s*[^,]+,\s*"[a-z]+",\s*([a-z_]+),/g,
      ),
    ]
      .map((match) => `MenuItem::with_id ${match[1]}`)
      .concat(
        [...tray.matchAll(/\.set_text\(([a-z_]+)\)/g)].map(
          (match) => `set_text ${match[1]}`,
        ),
        [...tray.matchAll(/\.tooltip\(([a-z_]+)\)/g)].map(
          (match) => `tooltip ${match[1]}`,
        ),
        [...tray.matchAll(/\.set_tooltip\(Some\(([a-z_]+)\)\)/g)].map(
          (match) => `set_tooltip ${match[1]}`,
        ),
      )
      .sort();
    expect(given).toEqual([
      "MenuItem::with_id open_text",
      "MenuItem::with_id quit_text",
      "set_text open_text",
      "set_text quit_text",
      "set_tooltip tooltip",
      "set_tooltip tooltip",
      "tooltip tooltip",
    ]);
    // Any other tray text call (a new menu item, another tooltip) is not in the list above:
    expect([
      ...tray.matchAll(/MenuItem::(?:new|with_id|with_id_and)\(/g),
    ]).toHaveLength(2);
    // Those names come from one place: `words`, and the tooltip's own two-way choice.
    const words = /fn words\(&self, locale: Option<UiLocale>\)[^{]*\{/.exec(
      tray,
    );
    expect(words).not.toBeNull();
    const body = bracketed(tray, words!.index + words![0].length - 1);
    // Nothing in it but the catalogue helpers and the choice between them: no string literal, no
    // formatting, no data.
    expect(body).not.toMatch(/"|format!|\+\s|\.name|\.title/);
    expect([
      ...body.matchAll(/\b(tray_text|waiting_notice_text)\(/g),
    ]).toHaveLength(4);
    const definitions = [
      ...tray.matchAll(/let \(open_text, quit_text, tooltip\) = ([^;]+);/g),
    ].map((match) => match[1].trim());
    expect(definitions).toEqual(["self.words(locale)", "self.words(locale)"]);
    expect(tray).toMatch(
      /let tooltip = if waiting \{\s*crate::tray_poller::waiting_notice_text\(locale\)\s*\} else \{\s*tray_text\(locale, MessageId::NativeTrayTooltip\)\s*\};/,
    );
  });

  // Every `MessageId::Native…` the native code asks for outside the id list (the native
  // confirmation dialogs, file filters, the notices and the tray). The notice and tray ones are
  // pinned above; a new one of any kind has to be placed here.
  const NATIVE_IDS_USED = [
    "NativeCancel",
    "NativeFilterBackups",
    "NativeFilterModels",
    "NativeFilterPdf",
    "NativeKitText",
    "NativeNoticeArrival",
    "NativeNoticeTest",
    "NativeRecoveryKeep",
    "NativeRecoveryReplace",
    "NativeRecoveryTitle",
    "NativeRecoveryWarning",
    "NativeResetPhrase",
    "NativeRestoreChanged",
    "NativeRestoreOther",
    "NativeRestoreReplace",
    "NativeRestoreSame",
    "NativeRestoreTitle",
    "NativeRestoreUnreadable",
    "NativeSetAsideConfirm",
    "NativeSetAsideDesktop",
    "NativeSetAsideKept",
    "NativeSetAsideMobile",
    "NativeSetAsideTitle",
    "NativeSetAsideWarning",
    "NativeTrayOpen",
    "NativeTrayQuit",
    "NativeTrayTooltip",
    "NativeTrayWaiting",
    "NativeVaultKeep",
  ];
  /** The only native messages that take a parameter, and which: counts and a sentence of the
   * dialog's own, never a name. */
  const NATIVE_PARAMETERS: Record<string, string[]> = {
    // The restore confirmation: `documents` is a count phrase and `kept` the dialog's own
    // sentence about the set-aside vault (lib.rs builds both from the catalogue, not from a name).
    "native-restore-changed": ["documents", "kept"],
    "native-restore-other": ["documents", "kept"],
    "native-restore-same": ["documents", "kept"],
    "native-restore-unreadable": ["documents", "kept"],
    // The recovery kit's own text file (the patient saves it; it holds the key on purpose and
    // is never a notice).
    "native-kit-text": ["date", "key", "label"],
    // The set-aside confirmation: `folder` is where the set-aside vault is kept (a path on this
    // computer, shown in a native dialog the patient opens; not a name from a record), and
    // `kept` / `removal` are the dialog's own sentences.
    "native-setAside-desktop": ["folder"],
    "native-setAside-warning": ["kept", "removal"],
  };

  it("pins every native message id the native code asks for, and which of them take a parameter", () => {
    const used = new Set<string>();
    for (const [path, text] of Object.entries(nativeSources)) {
      if (path.endsWith("/ui_text_ids.rs")) continue;
      for (const match of text.matchAll(/MessageId::(Native\w+)/g))
        used.add(match[1]);
    }
    expect([...used].sort()).toEqual(NATIVE_IDS_USED);
    // Each id's catalogue key, as `ui_text_ids.rs` maps it.
    const keyOf = new Map<string, string>();
    for (const match of nativeSources["/src-tauri/src/ui_text_ids.rs"].matchAll(
      /Self::(Native\w+) => "([^"]+)"/g,
    ))
      keyOf.set(match[1], match[2]);
    // Their catalogue messages, in every language: the parameters are exactly the pinned ones.
    for (const locale of LOCALES) {
      const messages = byLocale(locale);
      const actual: Record<string, string[]> = {};
      for (const id of NATIVE_IDS_USED) {
        const key = keyOf.get(id);
        expect(key, `${id} has a catalogue key`).toBeTypeOf("string");
        const value = messages.get(key!);
        expect(value, `${locale} ${key} exists`).toBeTypeOf("string");
        const parameters = [...value!.matchAll(/\{\s*\$([A-Za-z0-9_]+)/g)]
          .map((match) => match[1])
          .filter((name, index, all) => all.indexOf(name) === index)
          .sort();
        if (parameters.length) actual[key!] = parameters;
      }
      expect(actual, locale).toEqual(NATIVE_PARAMETERS);
    }
  });
});
