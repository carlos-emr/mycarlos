import {
  act,
  fireEvent,
  render,
  screen,
  within,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { LOCALES, setLocaleOverride, translate, type Locale } from "./index";
import VaultApp from "../VaultApp";
import { VaultLibrary } from "../native/VaultLibrary";
import { DocumentReader } from "../native/DocumentReader";
import { RecordDetails } from "../native/RecordDetails";
import { HiddenDocuments } from "../native/HiddenDocuments";
import type { VaultBridge, VaultRecord, VaultSnapshot } from "../vault";
import { printedDate } from "../native/KeyLabel";
import { setDeviceLocale } from "../test/deviceLocale";

const record: VaultRecord = {
  id: "record",
  profileId: "person",
  folderIds: [],
  displayName: "FAKE {name} Hidden.pdf",
  sourceLabel: "Manual import — unverified",
  sourceKind: "manual",
  mediaType: "application/pdf",
  plaintextSize: 1234567,
  importedAtMs: Date.UTC(2026, 9, 23, 12),
  available: true,
};
const snapshot: VaultSnapshot = {
  profiles: [
    { id: "person", displayName: "FAKE {name} Avery", createdAtMs: 1 },
    { id: "shared", displayName: "Shared with me", createdAtMs: 1 },
  ],
  sharedProfileId: "shared",
  recovery: null,
  recoveryKeySetAtMs: 1,
  folders: [
    {
      id: "folder",
      profileId: "person",
      parentId: null,
      name: "Hidden",
      createdAtMs: record.importedAtMs,
    },
  ],
  records: [record],
};
function bridge() {
  return {
    native: true,
    status: vi.fn().mockResolvedValue("unlocked"),
    snapshot: vi.fn().mockResolvedValue(snapshot),
    platform: vi.fn().mockResolvedValue("windows"),
    listReceived: vi.fn().mockResolvedValue({
      files: [],
      notice: { dropped: 0, refusedShares: 0 },
    }),
    acceptReceived: vi
      .fn()
      .mockResolvedValue({ imported: [], skippedDuplicates: [], notPdf: [] }),
    setAutoLock: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
    lock: vi.fn().mockResolvedValue(undefined),
    isLockedPdf: vi.fn().mockResolvedValue(false),
    isPhoto: vi.fn().mockResolvedValue(false),
    pickImportFiles: vi.fn().mockResolvedValue(null),
  } as unknown as VaultBridge;
}
function library() {
  return render(
    <VaultLibrary
      bridge={bridge()}
      snapshot={snapshot}
      busy={false}
      notice=""
      setNotice={vi.fn()}
      run={async (operation) => operation()}
      refresh={async () => snapshot}
      onLock={vi.fn().mockResolvedValue(undefined)}
      autoLockMinutes={5}
      onAutoLockMinutes={vi.fn()}
      sharedNew={22}
    />,
  );
}
const changeLanguage = (locale: Locale) => act(() => setLocaleOverride(locale));
afterEach(async () => {
  cleanup();
  setLocaleOverride(null);
  await page.viewport(1100, 760);
});

describe("the installed interface in the selected language", () => {
  it("updates Lock, Hidden, built-in folders and existing form drafts without remounting", () => {
    setLocaleOverride("en");
    library();
    const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "FAKE {count}" } });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const draft = screen.getByLabelText("Folder name");
    fireEvent.change(draft, {
      target: { value: "FAKE {name} Shared with me" },
    });
    changeLanguage("fr");
    expect(
      screen.getByRole("button", {
        name: "Déverrouillé · Verrouiller maintenant",
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /^Masqués/ })).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: (name) =>
          name.replace(/[\u2068\u2069]/g, "").startsWith("Partagés avec moi, "),
      }),
    ).toBeVisible();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(search).toHaveValue("FAKE {count}");
    expect(screen.getByLabelText(translate("fr", "rename.label.folder"))).toBe(
      draft,
    );
    expect(draft).toHaveValue("FAKE {name} Shared with me");
    changeLanguage("pl");
    expect(
      screen.getByRole("button", { name: "Odblokowany · Zablokuj teraz" }),
    ).toBeVisible();
    expect(screen.getByRole("searchbox")).toBe(search);
    expect(draft).toHaveValue("FAKE {name} Shared with me");
  });

  it("keeps an action result reactive after it has already been shown", async () => {
    setLocaleOverride("en");
    const native = bridge();
    render(<VaultApp bridge={native} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "New",
        description: "Choose files to import",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No files selected. Nothing changed.",
      ),
    );
    changeLanguage("fr");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Aucun fichier sélectionné. Rien n’a changé.",
    );
    changeLanguage("pl");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nie wybrano plików. Nic się nie zmieniło.",
    );
    expect(native.pickImportFiles).toHaveBeenCalledTimes(1);
  });

  it("updates a native error and its destination warning without repeating the operation", async () => {
    setLocaleOverride("en");
    const native = bridge();
    vi.mocked(native.pickImportFiles).mockRejectedValue({
      code: "storage",
      message:
        "The backup could not be saved there. No backup was saved. Keep your older backups.",
      messageKey: "native.error.03",
      note: "FAKE legacy note",
      noteKey: "native.backup.noteEmptied",
    });
    render(<VaultApp bridge={native} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "New",
        description: "Choose files to import",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "The backup could not be saved there.",
      ),
    );
    changeLanguage("fr");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(translate("fr", "native.error.03"));
    expect(status).toHaveTextContent(
      translate("fr", "native.backup.noteEmptied"),
    );
    expect(status).not.toHaveTextContent("FAKE legacy note");
    expect(native.pickImportFiles).toHaveBeenCalledTimes(1);
  });

  it("updates the reader password form without losing the typed password or restarting the reader", async () => {
    setLocaleOverride("en");
    const viewPage = vi
      .fn()
      .mockRejectedValue({ code: "pdf_locked", message: "FAKE locked" });
    render(
      <DocumentReader record={record} viewPage={viewPage} onClose={vi.fn()} />,
    );
    const input = await screen.findByLabelText("Document password");
    fireEvent.change(input, { target: { value: "FAKE {page} à" } });
    const calls = viewPage.mock.calls.length;
    changeLanguage("fr");
    expect(screen.getByLabelText("Mot de passe du document")).toBe(input);
    expect(input).toHaveValue("FAKE {page} à");
    expect(screen.getByRole("button", { name: "Fermer" })).toBeVisible();
    expect(viewPage).toHaveBeenCalledTimes(calls);
  });

  for (const locale of LOCALES) {
    it(`localizes document details, hidden counts, sizes and accessibility labels in ${locale}, with dates as the computer writes them`, () => {
      // Ben, 21 Oct, kept 28 Oct: dates keep the computer's format, whatever
      // language myCarlos uses. A Canadian computer writes 2026-10-23.
      setDeviceLocale("en-CA");
      setLocaleOverride(locale);
      const details = render(
        <RecordDetails
          record={record}
          folders={[]}
          busy={false}
          readOnly={false}
          unreadable={false}
          notice=""
          onClose={vi.fn()}
          onRename={vi.fn()}
          onMove={vi.fn()}
          onHide={vi.fn()}
          onExport={vi.fn()}
          onRead={vi.fn()}
        />,
      );
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByRole("button", {
          name: translate(
            locale,
            "interface.RecordDetails.closeDocumentDetails",
          ),
        }),
      ).toBeVisible();
      expect(dialog).toHaveTextContent(record.displayName);
      expect(dialog).toHaveTextContent(
        translate(locale, "record.source.manual"),
      );
      const size = `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(record.plaintextSize / (1024 * 1024))} MB`;
      expect(dialog).toHaveTextContent(size);
      expect(dialog).toHaveTextContent(
        new Date(record.importedAtMs).toLocaleString(),
      );
      expect(dialog).toHaveTextContent("2026-10-23, ");
      details.unmount();
      render(
        <HiddenDocuments
          records={[
            {
              ...record,
              hidden: { atMs: record.importedAtMs, reason: "patient" },
            },
          ]}
          folderNameById={new Map()}
          busy={false}
          readOnly={false}
          notice=""
          onRestore={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: translate(locale, "interface.hidden.restore", {
            name: record.displayName,
          }),
        }),
      ).toBeVisible();
      expect(
        screen.getByLabelText(
          translate(locale, "interface.count.hidden", { count: 1 }),
        ),
      ).toHaveTextContent(record.displayName);
      expect(screen.getByText("2026-10-23")).toBeVisible();
      cleanup();
      library();
      // The folder's and the document's date added, in the library list.
      expect(screen.getAllByText("2026-10-23")).toHaveLength(2);
      // The recovery kit and Settings > Security print the month in words.
      expect(printedDate(new Date(record.importedAtMs))).toBe(
        "October 23, 2026",
      );
      expect(document.documentElement.lang).toBe(locale);
    });
  }

  for (const locale of ["fr", "pl"] as const) {
    it(`keeps the translated phone controls within a 320px viewport in ${locale}`, async () => {
      await page.viewport(320, 640);
      setLocaleOverride(locale);
      library();
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>("button,input,select"),
      ).filter((element) => element.checkVisibility());
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        expect(
          box.left,
          control.textContent ?? control.tagName,
        ).toBeGreaterThanOrEqual(-1);
        expect(
          box.right,
          control.textContent ?? control.tagName,
        ).toBeLessThanOrEqual(321);
        if (control.tagName === "BUTTON")
          expect(
            control.scrollWidth,
            control.textContent ?? "",
          ).toBeLessThanOrEqual(control.clientWidth + 1);
      }
      await page.screenshot({
        path: `../../test-results/component-tests/interface-${locale}-320.png`,
      });
    });
  }
});
