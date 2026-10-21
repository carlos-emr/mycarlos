import { describe, expect, it, afterEach, vi } from "vitest";
import {
  getDefaultNormalizer,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  LOCALES,
  setLocaleOverride,
  translate,
  withElements,
  type Locale,
} from "./index";
import { SecuritySettings } from "../native/SecuritySettings";
import { RecoveryKeySetup } from "../native/RecoveryKeySetup";
import { AutoLockSetting } from "../native/AutoLockSetting";
import { ProfileChoice } from "../native/ProfileChoice";
import { readTypedZoom } from "../native/zoom";
import { ComfortSetup } from "../native/ComfortSetup";
import { LockWarning } from "../native/LockWarning";
import { PreferencesSettings } from "../native/PreferencesSettings";
import { PhotoViewer } from "../native/PhotoViewer";
import { AppearanceProvider } from "../AppearanceProvider";
import { startAppearance } from "../appearance";

const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";

afterEach(() => setLocaleOverride(null));

/** The text around a `{label}` placeholder, as the page shows it. */
const around = (locale: Locale, key: Parameters<typeof translate>[1]) =>
  translate(locale, key, { date: "DATE" }).split("{label}");

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
      onReset={vi.fn().mockResolvedValue(undefined)}
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
  it("puts elements where their placeholders are and keeps the rest as text", () => {
    const { container } = render(
      <p>
        {withElements("Label <b>{label}</b> and {missing}.", {
          label: <strong>BEAD</strong>,
        })}
      </p>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("BEAD");
    // Markup in the text stays text, and an unknown placeholder stays visible.
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toBe("Label <b>BEAD</b> and {missing}.");
  });
});

describe("Settings > Security in each language", () => {
  for (const locale of LOCALES) {
    it(`shows the Security screen in ${locale}`, () => {
      setLocaleOverride(locale);
      renderSecurity();

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
      expect(sentence.textContent).toContain(before);
      expect(sentence.textContent).toContain("B E A D");
      expect(sentence.textContent?.trimEnd()).toContain(
        after.replace("DATE", "").split(" ").slice(0, 4).join(" "),
      );
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
      return text;
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

describe("the patient buttons in each language", () => {
  for (const locale of LOCALES) {
    it(`names the choice of patient in ${locale}`, () => {
      setLocaleOverride(locale);
      render(
        <ProfileChoice
          profiles={[
            { id: "p1", displayName: "FAKE Avery", createdAtMs: 1 },
            { id: "p2", displayName: "FAKE Blake", createdAtMs: 2 },
          ]}
          profileId="p1"
          onChoose={vi.fn()}
        />,
      );
      const group = screen.getByRole("group", {
        name: translate(locale, "sidebar.patient"),
      });
      expect(
        within(group)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["FAKE Avery", "FAKE Blake"]);
      expect(group).toHaveTextContent(translate(locale, "sidebar.patient"));
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
      const [before] = around(locale, "recoveryKey.label");
      expect(label.closest("p")?.textContent).toContain(before);
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
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Wpisano 3 litery lub cyfry.",
    );

    await user.clear(field);
    await user.type(field, "ABCDE");
    await user.click(checkAndSave);
    expect(screen.getByRole("alert")).toHaveTextContent(
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
    expect("note" in between && between.note).toMatch(/^117% está entre/);
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
    expect(translate("pl", "lockWarning.left", { count: 10 })).toBe(
      "Zostało 10 sekund.",
    );
    expect(translate("pl", "lockWarning.title", { count: 2 })).toBe(
      "myCarlos zablokuje się za 2 sekundy, aby chronić prywatność dokumentów.",
    );
    expect(translate("fr", "photo.zoomed", { percent: 200 })).toBe(
      "Agrandie à 200\u00a0%.",
    );
  });
});
