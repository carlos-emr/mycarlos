import { describe, expect, it, afterEach, vi } from "vitest";
import {
  act,
  getDefaultNormalizer,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LOCALES,
  formatDate,
  setLocaleOverride,
  translate,
  withElements,
  type Locale,
} from "./index";
import { SecuritySettings } from "../native/SecuritySettings";
import { RecoveryKeySetup } from "../native/RecoveryKeySetup";
import { AutoLockSetting } from "../native/AutoLockSetting";
import { LibrarySidebar } from "../native/LibrarySidebar";
import { readTypedZoom } from "../native/zoom";
import { ComfortSetup } from "../native/ComfortSetup";
import { LockWarning } from "../native/LockWarning";
import { PreferencesSettings } from "../native/PreferencesSettings";
import { PhotoViewer } from "../native/PhotoViewer";
import { AppearanceProvider } from "../AppearanceProvider";
import { startAppearance } from "../appearance";
import { LibraryItems } from "../native/LibraryItems";
import type { VaultDragDrop } from "../native/useVaultDragDrop";
import { setDeviceLocale } from "../test/deviceLocale";
import type { VaultFolder, VaultRecord } from "../vault";

const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";

afterEach(() => setLocaleOverride(null));

/** Semantic copy checks ignore only the formatter's FSI/PDI boundaries.
 * Dedicated formatter tests separately require those boundaries for RTL text. */
const visibleText = (text: string) => text.replace(/[\u2068\u2069]/g, "");
const visibleTranslation = (...args: Parameters<typeof translate>) =>
  visibleText(translate(...args));
const around = (locale: Locale, key: Parameters<typeof translate>[1]) =>
  visibleTranslation(locale, key, {
    label: "LABEL_MARKER",
    date: formatDate(Date.UTC(2026, 9, 1), { dateStyle: "long" }),
  }).split("LABEL_MARKER");

function renderSecurity() {
  render(
    <SecuritySettings
      busy={false}
      readOnly={false}
      notice=""
      autoLockMinutes={5}
      onAutoLockMinutes={vi.fn()}
      onLock={vi.fn().mockResolvedValue(undefined)}
      onChangePassphrase={vi.fn().mockResolvedValue(undefined)}
      onCreateProfile={vi.fn().mockResolvedValue(true)}
      hiddenCount={0}
      hiddenScopeName="FAKE Avery"
      onOpenHidden={vi.fn()}
      onOpenAuditHistory={vi.fn()}
      recoveryKeySetAtMs={Date.UTC(2026, 9, 1)}
      recoveryKeyLabel="BEAD"
      onSetUpRecoveryKey={vi.fn()}
      onSaveBackup={vi.fn().mockResolvedValue(undefined)}
      onSpeedTest={vi.fn()}
    />,
  );
}

function renderRecoverySetup() {
  render(
    <RecoveryKeySetup
      bridge={{
        beginRecoveryKey: vi.fn().mockResolvedValue(KEY),
        confirmRecoveryKey: vi.fn(),
        saveRecoveryKit: vi.fn().mockResolvedValue(true),
        recoveryKeyLabel: vi.fn().mockResolvedValue("7F3A"),
        cancelRecoveryKey: vi.fn().mockResolvedValue(undefined),
      }}
      initialKey={KEY}
      replacing={false}
      canPrint={false}
      onDone={vi.fn()}
      onClose={vi.fn()}
      onLocked={vi.fn()}
      onLockAndLeave={vi.fn()}
    />,
  );
}

describe("withElements", () => {
  it("keeps untrusted argument braces and markup as text, never catalogue slots", () => {
    setLocaleOverride("en");
    const hostile = "FAKE <b>{label}</b> {$label}";
    const { container } = render(
      <p>
        {withElements(
          "security.recoveryKey.current",
          {
            label: <strong>BEAD</strong>,
          },
          { date: hostile },
        )}
      </p>,
    );
    expect(container.querySelectorAll("strong")).toHaveLength(1);
    expect(container.querySelector("strong")?.textContent).toBe("BEAD");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain(hostile);
  });
  it("shows a recoverable formatting failure when a required slot is missing", () => {
    setLocaleOverride("en");
    render(<p>{withElements("recoveryKey.label", {})}</p>);
    expect(
      screen.getByText(translate("en", "language.error.formatting")),
    ).toBeVisible();
  });
  it("reports invalid rich-message keys and empty required slots without crashing", () => {
    setLocaleOverride("en");
    expect(withElements("__proto__" as never, {})).toBe(
      translate("en", "language.error.formatting"),
    );
    expect(withElements("recoveryKey.label", { label: null })).toBe(
      translate("en", "language.error.formatting"),
    );
  });
});

describe("Settings > Security in each language", () => {
  for (const locale of LOCALES) {
    it(`shows the Security screen in ${locale}`, () => {
      setLocaleOverride(locale);
      renderSecurity();
      // Set-aside replaces destructive reset; Settings has no erase control.
      expect(
        screen.queryByRole("heading", {
          name: translate(locale, "security.erase.title"),
        }),
      ).toBeNull();

      expect(document.documentElement.lang).toBe(locale);
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: translate(locale, "security.title"),
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          translate(locale, "security.autoLock.minutes", { count: 5 }),
          { selector: ".state-pill" },
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: translate(locale, "security.recoveryKey.replace"),
        }),
      ).toBeInTheDocument();
      // The key's label sits inside the translated sentence, spelled out for
      // screen readers, with the sentence's own words around it.
      const [before, after] = around(locale, "security.recoveryKey.current");
      const label = screen.getByText("BEAD").closest("strong")!;
      const sentence = label.closest("p")!;
      expect(sentence.textContent?.startsWith(before)).toBe(true);
      expect(sentence.textContent).toContain("B E A D");
      expect(sentence.textContent?.endsWith(after)).toBe(true);
      // The delay's minus and plus (#67), named in the same language.
      expect(
        screen.getByText(translate(locale, "security.autoLock.body")),
      ).toBeInTheDocument();
      const delay = screen.getByRole("group", {
        name: translate(locale, "security.autoLock.label"),
      });
      for (const key of [
        "security.autoLock.shorter",
        "security.autoLock.longer",
      ] as const)
        expect(
          within(delay).getByRole("button", { name: translate(locale, key) }),
        ).toBeInTheDocument();
      expect(
        within(delay).getByText(
          translate(locale, "security.autoLock.minutes", { count: 5 }),
        ),
      ).toBeInTheDocument();
      if (locale !== "en") {
        expect(screen.queryByText("Encrypted backup")).toBeNull();
        expect(screen.queryByText("Lock now")).toBeNull();
      }
    });
  }

  it("gives each automatic lock delay its Polish plural", () => {
    setLocaleOverride("pl");
    const shown = (minutes: number) => {
      const { container, unmount } = render(
        <AutoLockSetting minutes={minutes} onMinutes={vi.fn()} />,
      );
      const text = container.querySelector(".auto-lock-value")?.textContent;
      unmount();
      return visibleText(text ?? "");
    };
    expect([1, 2, 5, 12, 14].map(shown)).toEqual([
      "1 minuta",
      "2 minuty",
      "5 minut",
      "12 minut",
      "14 minut",
    ]);
  });
});

describe("the person-folder sidebar in each language", () => {
  for (const locale of LOCALES) {
    it(`keeps the person tree and translates its vault totals in ${locale}`, async () => {
      setLocaleOverride(locale);
      const user = userEvent.setup();
      const people = [
        { id: "p1", displayName: "FAKE Avery", createdAtMs: 1 },
        { id: "p2", displayName: "FAKE Blake", createdAtMs: 2 },
      ];
      const folders: VaultFolder[] = people.map((person) => ({
        id: `folder-${person.id}`,
        profileId: person.id,
        parentId: null,
        name: "FAKE Results",
        createdAtMs: 1,
      }));
      const records: VaultRecord[] = ["p1", "p1", "p2"].map(
        (profileId, index) => ({
          id: `record-${index}`,
          profileId,
          folderIds: [],
          displayName: "FAKE Scan.pdf",
          sourceLabel: "FAKE source",
          mediaType: "application/pdf",
          plaintextSize: 1,
          importedAtMs: 1,
          available: true,
        }),
      );
      const props = {
        profileName: "Private vault",
        people,
        profileId: "p1",
        section: "shared" as const,
        sharedNew: 2,
        onOpenShared: vi.fn(),
        vaultTotals: { documents: 5, folders: 2 },
        currentFolderId: null,
        folders,
        records,
        disabled: false,
        drag: {
          startDrag: vi.fn(),
          dragOver: vi.fn(),
          dropInto: vi.fn(),
          dragEnd: vi.fn(),
          dragClass: (base: string) => base,
          dropClass: (base: string) => base,
        } as unknown as VaultDragDrop,
        onOpenPerson: vi.fn(),
        onOpenFolder: vi.fn(),
        onOpenSecurity: vi.fn(),
        onOpenPreferences: vi.fn(),
      };
      const tr = (
        key: Parameters<typeof translate>[1],
        params?: Parameters<typeof translate>[2],
      ) => translate(locale, key, params);
      const shown = render(<LibrarySidebar {...props} />);
      const nav = screen.getByRole("navigation", { name: tr("sidebar.label") });
      expect(
        within(nav).getByRole("button", {
          name: tr("interface.sidebar.sharedNew", {
            shared: tr("interface.LibrarySidebar.sharedWithMe"),
            new: tr("interface.count.new", { count: 2 }),
          }),
        }),
      ).toHaveAttribute("aria-current", "page");
      const folder = within(nav).getByRole("button", {
        name: `FAKE Results (FAKE Blake) ${tr("sidebar.documents", { count: 0 })}`,
      });
      expect(folder).not.toHaveAttribute("draggable", "true");
      await user.click(folder);
      expect(props.onOpenFolder).toHaveBeenCalledWith("p2", "folder-p2");
      await user.click(
        within(nav).getByRole("button", {
          name: `FAKE Blake ${tr("sidebar.documents", { count: 1 })}`,
        }),
      );
      expect(props.onOpenPerson).toHaveBeenCalledWith("p2");
      expect(screen.getByText(tr("sidebar.settings"))).toBeVisible();
      expect(screen.getByText(tr("sidebar.storage"))).toBeVisible();
      expect(shown.container.querySelector(".storage small")).toHaveTextContent(
        `${tr("sidebar.documents", { count: 5 })} · ${tr("sidebar.folderCount", { count: 2 })}`,
      );

      // The one-person label stays translated and the footer now counts just
      // that person's records, rather than the whole vault or all input rows.
      shown.rerender(
        <LibrarySidebar
          {...props}
          people={[people[0]]}
          section="records"
          profileName="FAKE Avery"
        />,
      );
      expect(
        screen.getByRole("button", {
          name: `${tr("sidebar.myRecords")} ${tr("sidebar.documents", { count: 2 })}`,
        }),
      ).toHaveAttribute("aria-current", "page");
      expect(shown.container.querySelector(".storage small")).toHaveTextContent(
        `${tr("sidebar.documents", { count: 2 })} · ${tr("sidebar.folderCount", { count: 1 })}`,
      );
    });
  }
});

describe("recovery key setup in each language", () => {
  for (const locale of LOCALES) {
    it(`shows the key and its label in ${locale}`, async () => {
      setLocaleOverride(locale);
      renderRecoverySetup();

      expect(
        screen.getByRole("heading", {
          name: translate(locale, "recoveryKey.title.key"),
        }),
      ).toBeInTheDocument();
      const groups = screen.getByRole("list", {
        name: translate(locale, "recover.key.label"),
      });
      expect(groups).toHaveTextContent(
        translate(locale, "recoveryKey.group", {
          number: 1,
          characters: "A B C D",
        }),
      );
      const label = await screen.findByText("7F3A");
      const [before, after] = around(locale, "recoveryKey.label");
      expect(label.closest("p")?.textContent?.startsWith(before)).toBe(true);
      expect(label.closest("p")?.textContent?.endsWith(after)).toBe(true);
      expect(
        screen.getByRole("button", {
          name: translate(locale, "recoveryKey.next"),
        }),
      ).toBeInTheDocument();
    });
  }

  it("counts what was typed with the Polish plural forms", async () => {
    setLocaleOverride("pl");
    const user = userEvent.setup();
    renderRecoverySetup();
    await user.click(
      screen.getByRole("button", { name: translate("pl", "recoveryKey.next") }),
    );
    const field = screen.getByLabelText(
      translate("pl", "recoveryKey.check.label"),
    );
    const checkAndSave = screen.getByRole("button", {
      name: translate("pl", "recoveryKey.checkAndSave"),
    });

    await user.type(field, "ABC");
    await user.click(checkAndSave);
    expect(visibleText(screen.getByRole("alert").textContent ?? "")).toContain(
      "Wpisano 3 litery lub cyfry.",
    );

    await user.clear(field);
    await user.type(field, "ABCDE");
    await user.click(checkAndSave);
    expect(visibleText(screen.getByRole("alert").textContent ?? "")).toContain(
      "Wpisano 5 liter lub cyfr.",
    );
  });
});

describe("text size messages", () => {
  it("explains a typed size in the language in use", () => {
    setLocaleOverride("fr");
    expect(readTypedZoom("abc")).toEqual({
      error: translate("fr", "textSize.notNumber", { min: 80, max: 400 }),
    });
    setLocaleOverride("es");
    const between = readTypedZoom("117");
    expect("note" in between && visibleText(between.note)).toMatch(
      /^117% está entre/,
    );
  });
});

describe("the first setup's comfort screen in each language", () => {
  for (const locale of LOCALES) {
    it(`shows the comfort screen in ${locale}`, () => {
      setLocaleOverride(locale);
      const tr = (key: Parameters<typeof translate>[1]) =>
        translate(locale, key);
      // French puts a no-break space before a colon: keep it as it is.
      const exactly = {
        normalizer: getDefaultNormalizer({ collapseWhitespace: false }),
      };
      render(
        <ComfortSetup
          autoLockMinutes={5}
          onAutoLockMinutes={vi.fn()}
          onDone={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("heading", { level: 1, name: tr("comfort.title") }),
      ).toBeVisible();
      expect(screen.getByText(tr("comfort.intro"), exactly)).toBeVisible();
      expect(screen.getByText(tr("auth.kicker"), exactly)).toBeVisible();
      expect(
        screen.getByText(tr("frame.state.settingUp"), exactly),
      ).toBeVisible();
      // Outside the app, text size follows the device.
      expect(
        screen.getByRole("heading", { name: tr("textSize.title") }),
      ).toBeVisible();
      expect(
        screen.getByText(tr("textSize.followsDevice"), exactly),
      ).toBeVisible();
      expect(
        screen.getByRole("heading", { name: tr("security.autoLock.title") }),
      ).toBeVisible();
      expect(
        screen.getByText(tr("comfort.autoLock.body"), exactly),
      ).toBeVisible();
      // Where to change them later names the settings as the app does.
      expect(
        screen.getByText(
          translate(locale, "comfort.later", {
            settings: tr("sidebar.settings"),
            textSize: tr("textSize.title"),
            preferences: tr("sidebar.preferences"),
            autoLock: tr("security.autoLock.title"),
            security: tr("security.title"),
          }),
          exactly,
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: tr("comfort.continue") }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: tr("comfort.usual") }),
      ).toBeVisible();
      if (locale !== "en")
        expect(screen.queryByText(/comfortable for you/)).toBeNull();
    });
  }
});

describe("the lock warning, Preferences and the photo viewer in each language", () => {
  const exactly = {
    normalizer: getDefaultNormalizer({ collapseWhitespace: false }),
  };
  for (const locale of LOCALES) {
    it(`shows them in ${locale}`, () => {
      setLocaleOverride(locale);
      const tr = (
        key: Parameters<typeof translate>[1],
        params?: Parameters<typeof translate>[2],
      ) => translate(locale, key, params);

      const warning = render(<LockWarning seconds={30} onKeepOpen={vi.fn()} />);
      expect(
        screen.getByRole("alertdialog", {
          name: tr("lockWarning.title", { count: 30 }),
        }),
      ).toBeVisible();
      expect(
        screen.getByText(
          tr("lockWarning.help", { keepOpen: tr("lockWarning.keepOpen") }),
          exactly,
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: tr("lockWarning.keepOpen") }),
      ).toHaveFocus();
      warning.unmount();

      const preferences = render(
        <AppearanceProvider appearance={startAppearance()}>
          <PreferencesSettings />
        </AppearanceProvider>,
      );
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: tr("sidebar.preferences"),
        }),
      ).toBeVisible();
      expect(
        screen.getByText(tr("preferences.subtitle"), exactly),
      ).toBeVisible();
      const group = screen.getByRole("group", { name: tr("appearance.title") });
      expect(
        within(group)
          .getAllByRole("radio")
          .map((choice) => choice.closest("label")!.textContent),
      ).toEqual([
        tr("appearance.system"),
        tr("appearance.light"),
        tr("appearance.dark"),
        tr("appearance.highContrast"),
      ]);
      expect(
        screen.getByText(
          tr("appearance.help", { system: tr("appearance.system") }),
          exactly,
        ),
      ).toBeVisible();
      expect(
        screen.getByText(tr("textSize.followsDevice"), exactly),
      ).toBeVisible();
      preferences.unmount();

      render(
        <PhotoViewer
          name="FAKE photo.jpg"
          url="data:image/gif;base64,R0lGODlhAQABAAAAACw="
          onClose={vi.fn()}
        />,
      );
      expect(
        screen.getByRole("img", {
          name: tr("photo.alt", { name: "FAKE photo.jpg" }),
        }),
      ).toBeInTheDocument();
      expect(screen.getByText(tr("photo.fitted"), exactly)).toBeInTheDocument();
      for (const key of [
        "photo.zoomOut",
        "photo.zoomIn",
        "photo.close",
      ] as const)
        expect(screen.getByRole("button", { name: tr(key) })).toBeVisible();
      expect(
        screen.getByLabelText(tr("photo.area"), exactly),
      ).toBeInTheDocument();
    });
  }

  it("counts the last seconds and zooms with each language's forms", () => {
    expect(visibleTranslation("pl", "lockWarning.left", { count: 10 })).toBe(
      "Zostało 10 sekund.",
    );
    expect(visibleTranslation("pl", "lockWarning.title", { count: 2 })).toBe(
      "myCarlos zablokuje się za 2 sekundy, aby chronić prywatność dokumentów.",
    );
    expect(visibleTranslation("fr", "photo.zoomed", { percent: 200 })).toBe(
      "Agrandie à 200\u00a0%.",
    );
  });
});

describe("the library list and grid in each language", () => {
  const added = Date.UTC(2026, 0, 15, 12);
  const folder: VaultFolder = {
    id: "folder-1",
    profileId: "person-1",
    parentId: null,
    name: "FAKE Labs",
    createdAtMs: added,
  };
  const record: VaultRecord = {
    id: "record-1",
    profileId: "person-1",
    folderIds: [],
    displayName: "FAKE_Scan.pdf",
    sourceLabel: "FAKE source",
    mediaType: "application/pdf",
    plaintextSize: 2048,
    importedAtMs: added,
    available: true,
  };
  const drag = {
    startDrag: vi.fn(),
    dragOver: vi.fn(),
    dropInto: vi.fn(),
    dragEnd: vi.fn(),
    dragClass: (base: string) => base,
    dropClass: (base: string) => base,
  } as unknown as VaultDragDrop;
  const renderItems = (
    view: "list" | "grid",
    items: { folders: VaultFolder[]; records: VaultRecord[] } = {
      folders: [folder],
      records: [record],
    },
    searching = false,
  ) =>
    render(
      <LibraryItems
        view={view}
        folders={items.folders}
        records={items.records}
        selectedIds={[]}
        disabled={false}
        searching={searching}
        folderLocation={
          searching ? () => "FAKE Avery / FAKE Parent" : undefined
        }
        recordLocation={
          searching ? () => "FAKE Avery / FAKE Parent / FAKE Labs" : undefined
        }
        unavailableLabel="FAKE unavailable"
        drag={drag}
        recordDragItem={(id) => ({ kind: "records", ids: [id] })}
        folderCount={() => 3}
        onOpenFolder={vi.fn()}
        onOpenRecord={vi.fn()}
        onRenameFolder={vi.fn()}
        onToggleSelected={vi.fn()}
      />,
    );

  for (const locale of LOCALES) {
    it(`shows the list, the grid and the empty states in ${locale}`, () => {
      setLocaleOverride(locale);
      const tr = (
        key: Parameters<typeof translate>[1],
        params?: Parameters<typeof translate>[2],
      ) => translate(locale, key, params);
      const name = folder.name;
      const file = record.displayName;

      const list = renderItems("list");
      expect(
        screen.getByLabelText(tr("library.items", { count: 2 })),
      ).toBeInTheDocument();
      for (const key of [
        "library.column.name",
        "library.column.source",
        "library.column.added",
      ] as const)
        expect(screen.getByText(tr(key))).toBeInTheDocument();
      expect(
        screen.getByRole("article", {
          name: tr("library.folder.label", { name }),
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: tr("library.folder.open", { name }),
        }),
      ).toHaveAccessibleDescription(tr("library.folder.items", { count: 3 }));
      expect(
        screen.getByRole("button", {
          name: tr("library.folder.rename", { name }),
        }),
      ).toHaveTextContent(tr("library.rename"));
      expect(
        screen.getByRole("article", {
          name: tr("library.document.label", { name: file }),
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: tr("library.document.details", { name: file }),
        }),
      ).toHaveTextContent(tr("library.details"));
      expect(
        screen.getByRole("button", {
          name: tr("library.select", { name: file }),
        }),
      ).toBeInTheDocument();
      list.unmount();

      const results = renderItems("list", undefined, true);
      expect(
        screen.getByRole("button", {
          name: tr("library.folder.open", { name }),
        }),
      ).toHaveAccessibleDescription(
        `${tr("library.folder.items", { count: 3 })} ${tr("interface.inLocation", { location: "FAKE Avery / FAKE Parent" })}`,
      );
      for (const buttonName of [file, tr("library.select", { name: file })])
        expect(
          screen.getByRole("button", { name: buttonName }),
        ).toHaveAccessibleDescription(
          tr("interface.inLocation", {
            location: "FAKE Avery / FAKE Parent / FAKE Labs",
          }),
        );
      expect(
        screen.getAllByText(new Date(added).toLocaleDateString()),
      ).toHaveLength(2);
      results.unmount();

      const grid = renderItems("grid", undefined, true);
      expect(
        screen.getByText(
          tr("interface.inLocation", { location: "FAKE Avery / FAKE Parent" }),
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", {
          name: tr("library.select", { name: file }),
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText(tr("library.items", { count: 2 })),
      ).toBeInTheDocument();
      expect(
        screen.getByText(tr("library.folder.items", { count: 3 })),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: tr("library.folder.rename", { name }),
        }),
      ).toHaveTextContent(tr("library.rename"));
      grid.unmount();

      const empty = renderItems("list", { folders: [], records: [] });
      expect(screen.getByText(tr("library.empty.title"))).toBeVisible();
      expect(screen.getByText(tr("library.empty.help"))).toBeVisible();
      empty.unmount();
      renderItems("grid", { folders: [], records: [] }, true);
      expect(screen.getByText(tr("library.noMatch.title"))).toBeVisible();
      expect(screen.getByText(tr("library.noMatch.help"))).toBeVisible();
    });
  }

  it("keeps the device's date format while the language follows the system", () => {
    // As the rest of the app does (Settings > Security, the recovery kit):
    // a Canadian device writes 2026-01-15 whatever language is shown (Ben,
    // 21 Oct, kept 28 Oct).
    setDeviceLocale("en-CA");
    for (const locale of LOCALES) {
      act(() => setLocaleOverride(locale));
      const list = renderItems("list");
      // The folder's date added and the document's.
      expect(screen.getAllByText("2026-01-15"), locale).toHaveLength(2);
      list.unmount();
      const grid = renderItems("grid");
      expect(screen.getAllByText("2026-01-15"), locale).toHaveLength(1);
      grid.unmount();
    }
  });

  it("counts items with each language's forms", () => {
    expect(visibleTranslation("en", "library.folder.items", { count: 1 })).toBe(
      "1 item",
    );
    expect(visibleTranslation("en", "library.items", { count: 1 })).toBe(
      "1 visible library item",
    );
    expect(visibleTranslation("pl", "library.folder.items", { count: 3 })).toBe(
      "3 elementy",
    );
    expect(visibleTranslation("pl", "library.folder.items", { count: 5 })).toBe(
      "5 elementów",
    );
    expect(visibleTranslation("pl", "library.items", { count: 22 })).toBe(
      "22 widoczne elementy biblioteki",
    );
    // French counts 0 as singular.
    expect(visibleTranslation("fr", "library.items", { count: 0 })).toBe(
      "0 élément visible dans la bibliothèque",
    );
    expect(
      visibleTranslation("es", "library.folder.items", { count: 1_000_000 }),
    ).toBe("1.000.000 de elementos");
  });
});

describe("appearance problems in the language in use", () => {
  it("words a choice it could not remember, and rewords it when the language changes", async () => {
    setLocaleOverride("fr");
    const user = userEvent.setup();
    const appearance = startAppearance();
    render(
      <AppearanceProvider appearance={appearance}>
        <PreferencesSettings />
      </AppearanceProvider>,
    );
    const blocked = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    await user.click(screen.getByRole("radio", { name: "Sombre" }));
    blocked.mockRestore();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "L’apparence a changé pour cette session, mais n’a pas pu être mémorisée sur cet appareil.",
    );
    act(() => setLocaleOverride("es"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "La apariencia cambió para esta sesión, pero no se pudo recordar en este dispositivo.",
    );
  });

  it("names the System choice in its own language when the saved one cannot be read", () => {
    setLocaleOverride("pl");
    const unreadable = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const appearance = startAppearance();
    unreadable.mockRestore();
    render(
      <AppearanceProvider appearance={appearance}>
        <PreferencesSettings />
      </AppearanceProvider>,
    );
    expect(visibleText(screen.getByRole("alert").textContent ?? "")).toContain(
      "Nie udało się odczytać zapisanego wyglądu. W tej sesji używana jest opcja „Systemowy”.",
    );
  });

  it("words a window that could not follow the choice", () => {
    setLocaleOverride("pt-BR");
    const appearance = startAppearance();
    render(
      <AppearanceProvider appearance={appearance}>
        <PreferencesSettings />
      </AppearanceProvider>,
    );
    act(() => appearance.setNativeError("appearance.error.window"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A aparência da janela não pôde seguir esta escolha. Você pode continuar usando o myCarlos.",
    );
  });
});
