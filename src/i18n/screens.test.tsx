import { describe, expect, it, afterEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
import { readTypedZoom } from "../native/zoom";

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
      if (locale !== "en") {
        expect(screen.queryByText("Encrypted backup")).toBeNull();
        expect(screen.queryByText("Lock now")).toBeNull();
      }
    });
  }

  it("gives each automatic lock delay its Polish plural", () => {
    setLocaleOverride("pl");
    renderSecurity();
    const select = screen.getByLabelText(
      translate("pl", "security.autoLock.label"),
    );
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options[0]).toBe("1 minuta");
    expect(options[1]).toBe("2 minuty");
    expect(options[4]).toBe("5 minut");
    expect(options[11]).toBe("12 minut");
    expect(options[13]).toBe("14 minut");
  });
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
