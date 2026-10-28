import { fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride, translate, type Locale } from "../i18n";
import type { VaultBridge, VaultRecord, VaultSnapshot } from "../vault";
import { DocumentReader } from "./DocumentReader";
import { MANUAL_IMPORT_LABEL } from "./RecordSource";
import vaultRs from "../../src-tauri/src/vault.rs?raw";
import { VaultLibrary } from "./VaultLibrary";

// #135: a document's status, Verified or Unverified, comes before its source,
// so that a long source cannot push the status out of view. FAKE data only.
const LONG_CLINIC =
  "FAKE Northern Riverside Family Health Team and Community Wellness Clinic of the Upper Valley";

const record = (
  id: string,
  displayName: string,
  extra: Partial<VaultRecord> = {},
): VaultRecord => ({
  id,
  profileId: "profile-1",
  folderIds: [],
  displayName,
  // What the vault stores on every document, clinic deliveries included.
  sourceLabel: MANUAL_IMPORT_LABEL,
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
  ...extra,
});
const VERIFIED = record("verified", "FAKE clinic letter.pdf", {
  verifiedClinicName: LONG_CLINIC,
  clinicServiceDate: "2026-10-01",
});
const MANUAL = record("manual", "FAKE scanned note.pdf");
/** A source text that says Verified is still only text: no clinic was
 * checked, so the document is Unverified. */
const CLAIMS = record("claims", "FAKE forwarded letter.pdf", {
  sourceLabel: "FAKE Clinic · Verified",
});

const snapshot: VaultSnapshot = {
  profiles: [{ id: "profile-1", displayName: "FAKE Avery", createdAtMs: 1 }],
  // A folder, so that the last column holds a Rename as well as Details.
  folders: [
    {
      id: "folder-1",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Letters",
      createdAtMs: 1,
    },
  ],
  records: [VERIFIED, MANUAL, CLAIMS],
  recovery: null,
  recoveryKeySetAtMs: 1,
};

function renderLibrary() {
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    snapshot: vi.fn().mockResolvedValue(snapshot),
    isLockedPdf: vi.fn().mockResolvedValue(false),
  } as unknown as VaultBridge;
  return render(
    <VaultLibrary
      bridge={bridge}
      snapshot={snapshot}
      busy={false}
      notice=""
      setNotice={vi.fn()}
      run={async (operation) => operation()}
      refresh={async () => snapshot}
      onLock={vi.fn().mockResolvedValue(undefined)}
      autoLockMinutes={5}
      onAutoLockMinutes={vi.fn()}
    />,
  );
}

afterEach(async () => {
  document.documentElement.style.fontSize = "";
  document.getElementById("wide-font")?.remove();
  await page.viewport(1100, 760);
});

/** A wide font that every machine has one of (DejaVu Sans on Linux, CI
 * included; Verdana on Windows and macOS), as targetSize.test.tsx uses: a
 * status that only fits in a narrower font such as Roboto fails everywhere. */
function useWideFont() {
  const style = document.createElement("style");
  style.id = "wide-font";
  style.textContent =
    ':root { font-family: "DejaVu Sans", Verdana, sans-serif !important; }';
  document.head.append(style);
}
const FONTS = ["the default font", "a wide font"] as const;
const setFont = (font: (typeof FONTS)[number]) => {
  if (font === "a wide font") useWideFont();
};

/** What each document shows: its status, then its source. */
const expected = (locale: Locale) => {
  const tr = (key: Parameters<typeof translate>[1], params?: object) =>
    translate(locale, key, params as Record<string, string>);
  return [
    [
      VERIFIED,
      tr("library.status.verified"),
      tr("library.source.clinic", { clinic: LONG_CLINIC }),
    ],
    [
      MANUAL,
      tr("library.status.unverified"),
      tr("library.source.manualImport"),
    ],
    [CLAIMS, tr("library.status.unverified"), CLAIMS.sourceLabel],
  ] as const;
};

const row = (locale: Locale, shownRecord: VaultRecord) =>
  screen.getByRole("article", {
    name: translate(locale, "library.document.label", {
      name: shownRecord.displayName,
    }),
  });

/** The status and the source, each found by its own words. */
function parts(where: HTMLElement, status: string, source: string) {
  const shown = within(where).getByText(status, { exact: true });
  const from = within(where).getByText(source, { exact: true });
  return { shown, from };
}

/** The status is first in reading order and on screen: on the source's line
 * to its left, or on a line above it. */
function expectStatusFirst(shown: HTMLElement, from: HTMLElement) {
  expect(
    shown.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const status = shown.getBoundingClientRect();
  const source = from.getBoundingClientRect();
  const sameLine = status.top < source.bottom && source.top < status.bottom;
  if (sameLine) expect(status.right).toBeLessThanOrEqual(source.left + 0.5);
  else expect(status.bottom).toBeLessThanOrEqual(source.top + 0.5);
}

/** The status's words that are drawn over more than one line: the status may
 * wrap between its words ("Nie" / "zweryfikowano"), never inside one. */
function splitWords(shown: HTMLElement) {
  const text = shown.firstChild as Text;
  const split: string[] = [];
  let at = 0;
  for (const word of text.data.split(" ")) {
    const range = document.createRange();
    range.setStart(text, at);
    range.setEnd(text, at + word.length);
    const lines = new Set(
      Array.from(range.getClientRects(), (box) => Math.round(box.top)),
    );
    if (lines.size > 1) split.push(word);
    at += word.length + 1;
  }
  return split;
}

/** All of the status is on screen, and none of its words is split. */
function expectWholeStatus(shown: HTMLElement) {
  expect(splitWords(shown), "a status word split over two lines").toEqual([]);
  expectInView(shown);
}

/** All of an element is on screen: not cut short inside itself, and not
 * hidden by anything that clips the column, the list or the dialog. Nothing is
 * scrolled first: a box that hides what overflows it can still be scrolled by
 * a script, which would bring a cut-off element into view. The windows are
 * tall enough. */
function expectInView(element: HTMLElement) {
  expect(element.checkVisibility()).toBe(true);
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  const shown = element.getBoundingClientRect();
  for (
    let box = element.parentElement;
    box && box !== document.body;
    box = box.parentElement
  ) {
    const style = getComputedStyle(box);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const edges = box.getBoundingClientRect();
      expect(shown.left, box.className).toBeGreaterThanOrEqual(
        edges.left - 0.5,
      );
      expect(shown.right, box.className).toBeLessThanOrEqual(edges.right + 0.5);
      expect(shown.top, box.className).toBeGreaterThanOrEqual(edges.top - 0.5);
      expect(shown.bottom, box.className).toBeLessThanOrEqual(
        edges.bottom + 0.5,
      );
    }
    // A fixed box, such as a dialog's backdrop, is not clipped by the boxes
    // around it.
    if (style.position === "fixed") break;
  }
  expect(shown.right).toBeLessThanOrEqual(window.innerWidth);
}

describe("the source the vault stores (#135)", () => {
  it("matches vault.rs's MANUAL_IMPORT_LABEL byte for byte", () => {
    // The page swaps this one stored text for a translated name, so the two
    // copies must not drift apart: if vault.rs changes it, this fails.
    const stored = /const MANUAL_IMPORT_LABEL: &str = "([^"\\]*)";/.exec(
      vaultRs,
    );
    expect(stored?.[1]).toBe(MANUAL_IMPORT_LABEL);
    const bytes = (text: string) => Array.from(new TextEncoder().encode(text));
    expect(bytes(stored![1])).toEqual(bytes(MANUAL_IMPORT_LABEL));
  });
});

describe("a document's status before its source (#135)", () => {
  it("decides Verified from the vault's check, never from the source text", () => {
    renderLibrary();
    for (const [shownRecord, status, source] of expected("en")) {
      const { shown, from } = parts(row("en", shownRecord), status, source);
      expectStatusFirst(shown, from);
    }
    // The stored text is shown by a translated name, not as "Manual import — unverified".
    expect(screen.queryByText(MANUAL_IMPORT_LABEL)).not.toBeInTheDocument();
    expect(
      within(row("en", CLAIMS)).queryByText("Verified", { exact: true }),
    ).not.toBeInTheDocument();
  });

  // Desktop widths at which the Source column is shown: the widest; 1017px,
  // the narrowest (the five columns fit whole from 63.5em, 1016px, up, with
  // the Source column at its least); and larger text in a wide window.
  for (const [width, text] of [
    [1100, "16px"],
    [1017, "16px"],
    [1400, "24px"],
  ] as const)
    for (const font of FONTS)
      it(`keeps the whole status in view beside a long source at ${width}px and ${text} text in ${font}, in every language`, async () => {
        await page.viewport(width, 1400);
        document.documentElement.style.fontSize = text;
        setFont(font);
        for (const locale of LOCALES) {
          setLocaleOverride(locale);
          const view = renderLibrary();
          for (const [shownRecord, status, source] of expected(locale)) {
            const { shown, from } = parts(
              row(locale, shownRecord),
              status,
              source,
            );
            // Beside the name, in the Source column, not on a line under it.
            expect(
              getComputedStyle(shown.closest(".record-source")!).gridRowStart,
            ).toBe("auto");
            expectWholeStatus(shown);
            expectStatusFirst(shown, from);
            // A long source is what gives way: cut short after the status.
            if (shownRecord === VERIFIED)
              expect(from.scrollWidth).toBeGreaterThan(from.clientWidth);
          }
          // The header's Source and Date added stay over their columns. Only
          // in English in the default font: elsewhere Details is wider than
          // 4.5rem, which already moved the rows' columns from the header's
          // before #135 (each row sizes its own last column).
          if (locale === "en" && font === "the default font") {
            const head = document.querySelectorAll<HTMLElement>(
              ".native-filelist .file-head > .column",
            );
            const cells = row(locale, VERIFIED).querySelectorAll<HTMLElement>(
              ":scope > .column",
            );
            expect(head).toHaveLength(2);
            head.forEach((label, index) =>
              expect(
                Math.abs(
                  label.getBoundingClientRect().left -
                    cells[index].getBoundingClientRect().left,
                ),
              ).toBeLessThanOrEqual(3),
            );
          }
          // Nor does the wider Source column squeeze Rename or Details,
          // the last column, out of the row in any language.
          for (const last of document.querySelectorAll<HTMLElement>(
            ".native-filelist .file-row > :last-child",
          ))
            expectInView(last);
          view.unmount();
        }
      });

  // Phones, narrow windows and larger text, where the list has no Source
  // column: the status goes under the document's name, and a grid tile shows
  // it under its caption. 1016px, 960px and 905px are desktop windows, with
  // the sidebar, too narrow for the five columns. 32px is the reader's 200% text;
  // it is set on the page here, so the em breakpoints still read 16px, and only
  // the 320px case takes the narrowest layout that a real 200% text gives at
  // 360px too. The wide font is checked where that layout matches.
  for (const [width, text, fonts] of [
    [1016, "16px", FONTS],
    [960, "16px", FONTS],
    [905, "16px", FONTS],
    [800, "16px", FONTS],
    [360, "16px", FONTS],
    [360, "32px", FONTS.slice(0, 1)],
    [320, "32px", FONTS],
    [320, "16px", FONTS],
  ] as const)
    for (const font of fonts)
      it(`keeps the whole status in view in the list and the grid at ${width}px and ${text} text in ${font}, in every language`, async () => {
        await page.viewport(width, 3200);
        document.documentElement.style.fontSize = text;
        setFont(font);
        for (const locale of LOCALES) {
          setLocaleOverride(locale);
          const view = renderLibrary();
          for (const layout of ["list", "grid"]) {
            if (layout === "grid")
              fireEvent.click(
                screen.getByRole("button", { name: "Grid view" }),
              );
            for (const [shownRecord, status, source] of expected(locale)) {
              const item = row(locale, shownRecord);
              const { shown, from } = parts(item, status, source);
              expectWholeStatus(shown);
              expectStatusFirst(shown, from);
              // Under the name, not beside it or over it.
              const name = within(item)
                .getAllByText(shownRecord.displayName, { exact: true })
                .at(-1)!;
              expect(shown.getBoundingClientRect().top).toBeGreaterThanOrEqual(
                name.getBoundingClientRect().bottom - 0.5,
              );
            }
            // Rename and Details stay whole here too.
            if (layout === "list")
              for (const last of document.querySelectorAll<HTMLElement>(
                ".native-filelist .file-row > :last-child",
              ))
                expectInView(last);
          }
          view.unmount();
        }
      });

  for (const [width, text, fonts] of [
    [1100, "16px", FONTS],
    [360, "16px", FONTS],
    [360, "32px", FONTS],
    [320, "32px", FONTS],
  ] as const)
    for (const font of fonts)
      it(`shows the whole status, then all of the source, in Details and the reader at ${width}px and ${text} text in ${font}, in every language`, async () => {
        await page.viewport(width, 2400);
        document.documentElement.style.fontSize = text;
        setFont(font);
        for (const locale of LOCALES) {
          setLocaleOverride(locale);
          for (const [shownRecord, status, source] of expected(locale).slice(
            0,
            2,
          )) {
            const library = renderLibrary();
            fireEvent.click(
              screen.getByRole("button", {
                name: translate(locale, "library.document.details", {
                  name: shownRecord.displayName,
                }),
              }),
            );
            const sourceRow = within(screen.getByRole("dialog")).getByText(
              "Source",
              { exact: true },
            ).parentElement!;
            expectWholeSource(sourceRow, status, source);
            library.unmount();

            const reader = renderReader(shownRecord);
            expectWholeSource(
              document.getElementById("reader-trust")!,
              status,
              source,
            );
            await screen.findByRole("img", { name: /^Page 1 of 1/ });
            reader.unmount();
          }
        }
      });
});

/** In Details and the reader: the whole status first, then all of the source,
 * wrapped, nothing of it cut off. */
function expectWholeSource(where: HTMLElement, status: string, source: string) {
  const { shown, from } = parts(where, status, source);
  expectWholeStatus(shown);
  expectStatusFirst(shown, from);
  expect(from.checkVisibility()).toBe(true);
  expect(from.scrollWidth).toBeLessThanOrEqual(from.clientWidth);
}

/** A one-page document in the reader; the page is a FAKE blank picture. */
function renderReader(shownRecord: VaultRecord) {
  const blank =
    "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1035"/>',
    );
  return render(
    <DocumentReader
      record={shownRecord}
      viewPage={async () => ({
        pageCount: 1,
        width: 800,
        height: 1035,
        image: blank,
        text: "FAKE page text",
      })}
      onClose={vi.fn()}
    />,
  );
}
