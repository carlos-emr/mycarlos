import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLanguagePreference,
  getLocale,
  initLocale,
  LANGUAGE_STORAGE_KEY,
  LOCALES,
  rememberLocale,
  setLocaleOverride,
  subscribeLocale,
  translate,
} from "../i18n";
import { LanguageSetting } from "./LanguageSetting";
import { PreferencesSettings } from "./PreferencesSettings";
import { CreateVault } from "./VaultAuth";
import { MIN_PASSPHRASE_CHARS } from "./PassphraseChecklist";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  setLocaleOverride(null);
});

describe("saved app language", () => {
  it("changes System and English selection even when the resolved language stays English", async () => {
    const user = userEvent.setup();
    render(<LanguageSetting />);
    const english = screen.getByRole("radio", { name: "English" });
    await user.click(english);
    expect(english).toBeChecked();
    expect(english).toHaveFocus();
    expect(getLanguagePreference().choice).toBe("en");
    await user.click(screen.getByRole("radio", { name: "System default" }));
    expect(screen.getByRole("radio", { name: "System default" })).toBeChecked();
    expect(getLanguagePreference().choice).toBeNull();
    expect(getLocale()).toBe("en");
  });

  for (const locale of LOCALES) {
    it(`switches Preferences immediately and restores ${locale} before rendering`, () => {
      render(<PreferencesSettings />);
      const choice = document.querySelector<HTMLInputElement>(
        `.language-choice input[value="${locale}"]`,
      )!;
      fireEvent.click(choice);
      expect(choice).toBeChecked();
      expect(
        screen.getByRole("heading", {
          name: translate(locale, "sidebar.preferences"),
          level: 1,
        }),
      ).toBeVisible();
      expect(document.documentElement.lang).toBe(locale);
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe(locale);
      act(() => setLocaleOverride(null));
      act(() => initLocale());
      expect(getLocale()).toBe(locale);
      expect(document.documentElement.lang).toBe(locale);
    });

    it(`translates setup labels and validation into ${locale} without clearing typed drafts`, () => {
      const { container } = render(
        <CreateVault
          busy={false}
          notice=""
          onCreate={vi.fn()}
          restoreBridge={{} as never}
          onRestored={vi.fn()}
        />,
      );
      const form = within(container.querySelector("form")!);
      const name = form.getByRole("textbox", {
        name: "Whose records will you keep here?",
      });
      const password = form.getByLabelText("Passphrase", { exact: true });
      fireEvent.change(name, { target: { value: "FAKE Language Patient" } });
      fireEvent.change(password, { target: { value: "FAKE draft" } });
      const languageChoice = container.querySelector<HTMLInputElement>(
        `.language-choice input[value="${locale}"]`,
      )!;
      fireEvent.click(languageChoice);
      expect(
        screen.getByRole("heading", {
          name: translate(locale, "create.title"),
          level: 1,
        }),
      ).toBeVisible();
      expect(
        form.getByRole("textbox", {
          name: translate(locale, "create.profile.label"),
        }),
      ).toBe(name);
      expect(name).toHaveValue("FAKE Language Patient");
      expect(
        form.getByLabelText(translate(locale, "passphrase.label"), {
          exact: true,
        }),
      ).toBe(password);
      expect(password).toHaveValue("FAKE draft");
      expect(
        container.querySelector("#passphrase-too-short"),
      ).toHaveTextContent(
        translate(locale, "passphrase.tooShort", { min: MIN_PASSPHRASE_CHARS }),
      );
    });
  }

  it("clears a remembered choice for System and ignores unsupported stored values", () => {
    rememberLocale("fr");
    rememberLocale(null);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "unsupported");
    initLocale();
    expect(getLanguagePreference().choice).toBeNull();
    expect(getLocale()).toBe("en");
  });

  it("keeps the session language and reports a failed device save in that language", async () => {
    const user = userEvent.setup();
    render(<LanguageSetting />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await user.click(screen.getByRole("radio", { name: "Français" }));
    expect(screen.getByRole("radio", { name: "Français" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      translate("fr", "language.error.notRemembered"),
    );
    expect(document.documentElement.lang).toBe("fr");
  });

  it("shows an unreadable saved preference while keeping System usable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    initLocale();
    render(<LanguageSetting compact />);
    expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
    expect(screen.getByRole("radio", { name: "System default" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      translate("en", "language.error.unreadable"),
    );
  });

  it("reports a failed English save even when the choice and effective language stay English", () => {
    rememberLocale("en");
    render(<LanguageSetting />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => rememberLocale("en"));
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(
      translate("en", "language.error.notRemembered"),
    );
    expect(document.documentElement.lang).toBe("en");
  });

  it("follows a live device language change only for System", () => {
    const languages = vi
      .spyOn(navigator, "languages", "get")
      .mockReturnValue(["en"]);
    const stop = subscribeLocale(() => {});
    try {
      languages.mockReturnValue(["pl"]);
      window.dispatchEvent(new Event("languagechange"));
      expect(document.documentElement.lang).toBe("pl");
      rememberLocale("fr");
      languages.mockReturnValue(["es"]);
      window.dispatchEvent(new Event("languagechange"));
      expect(document.documentElement.lang).toBe("fr");
    } finally {
      stop();
    }
  });
});
