import { fireEvent, render, screen, within } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride, translate, type Locale } from "../i18n";
import type { VaultBridge, VaultRecord, VaultSnapshot } from "../vault";
import { MANUAL_IMPORT_LABEL } from "./RecordSource";
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
  folders: [],
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
  await page.viewport(1100, 760);
});

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

/** All of the status is on screen: not cut short, and not hidden by anything
 * that clips the column, the list or the dialog. Nothing is scrolled first: a
 * box that hides what overflows it can still be scrolled by a script, which
 * would bring a cut-off status into view. The windows are tall enough. */
function expectWholeStatus(shown: HTMLElement) {
  expect(shown.checkVisibility()).toBe(true);
  expect(shown.scrollWidth).toBeLessThanOrEqual(shown.clientWidth);
  const status = shown.getBoundingClientRect();
  for (
    let box = shown.parentElement;
    box && box !== document.body;
    box = box.parentElement
  ) {
    const style = getComputedStyle(box);
    if (style.overflowX === "visible" && style.overflowY === "visible")
      continue;
    const edges = box.getBoundingClientRect();
    expect(status.left, box.className).toBeGreaterThanOrEqual(edges.left - 0.5);
    expect(status.right, box.className).toBeLessThanOrEqual(edges.right + 0.5);
    expect(status.top, box.className).toBeGreaterThanOrEqual(edges.top - 0.5);
    expect(status.bottom, box.className).toBeLessThanOrEqual(
      edges.bottom + 0.5,
    );
  }
  expect(status.right).toBeLessThanOrEqual(window.innerWidth);
}

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

  // Desktop widths at which the Source column is shown: the widest, the
  // narrowest (the column at its least), and larger text in a wide window.
  for (const [width, text] of [
    [1100, "16px"],
    [960, "16px"],
    [1400, "24px"],
  ] as const)
    it(`keeps the whole status in view beside a long source at ${width}px and ${text} text, in every language`, async () => {
      await page.viewport(width, 1400);
      document.documentElement.style.fontSize = text;
      for (const locale of LOCALES) {
        setLocaleOverride(locale);
        const view = renderLibrary();
        for (const [shownRecord, status, source] of expected(locale)) {
          const { shown, from } = parts(
            row(locale, shownRecord),
            status,
            source,
          );
          expectWholeStatus(shown);
          expectStatusFirst(shown, from);
          // A long source is what gives way: cut short after the status.
          if (shownRecord === VERIFIED)
            expect(from.scrollWidth).toBeGreaterThan(from.clientWidth);
        }
        view.unmount();
      }
    });

  // Phones, narrow windows and larger text, where the list has no Source
  // column: the status goes under the document's name, and a grid tile shows
  // it under its caption. 32px is the reader's 200% text.
  for (const [width, text] of [
    [800, "16px"],
    [360, "16px"],
    [360, "32px"],
    [320, "16px"],
  ] as const)
    it(`keeps the whole status in view in the list and the grid at ${width}px and ${text} text, in every language`, async () => {
      await page.viewport(width, 3200);
      document.documentElement.style.fontSize = text;
      for (const locale of LOCALES) {
        setLocaleOverride(locale);
        const view = renderLibrary();
        for (const layout of ["list", "grid"]) {
          if (layout === "grid")
            fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
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
        }
        view.unmount();
      }
    });

  it("shows the whole source after the status in Details", async () => {
    for (const width of [1100, 360]) {
      await page.viewport(width, 1600);
      const view = renderLibrary();
      fireEvent.click(
        screen.getByRole("button", {
          name: "Details for FAKE clinic letter.pdf",
        }),
      );
      const details = screen.getByRole("dialog");
      const sourceRow = within(details).getByText("Source", {
        exact: true,
      }).parentElement!;
      const { shown, from } = parts(
        sourceRow,
        "Verified",
        `From ${LONG_CLINIC}`,
      );
      expectWholeStatus(shown);
      expectStatusFirst(shown, from);
      // Nothing of the source is cut off: it wraps.
      expect(from.checkVisibility()).toBe(true);
      expect(from.scrollWidth).toBeLessThanOrEqual(from.clientWidth);
      expectWholeStatus(from);
      view.unmount();
    }
  });
});
