import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

  it("labels Simplified Chinese as Mandarin, with the English word marked as English", async () => {
    const user = userEvent.setup();
    render(<LanguageSetting />);
    const simplified = screen.getByRole("radio", {
      name: "简体中文 (Mandarin)",
    });
    const label = simplified.closest("label")!;
    expect(label.querySelector('[lang="zh-CN"]')).toHaveTextContent(
      /^简体中文$/,
    );
    expect(label.querySelector('[lang="en"]')).toHaveTextContent(
      /^\(Mandarin\)$/,
    );
    expect(screen.getByRole("radio", { name: "繁體中文" })).toBeInTheDocument();
    await user.click(simplified);
    expect(getLanguagePreference().choice).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  for (const locale of LOCALES) {
    it(`switches Preferences immediately and restores ${locale} before rendering`, () => {
      render(<PreferencesSettings />);
      // The list is the language dialog's, opened from the Language button in Preferences.
      fireEvent.click(document.querySelector(".language-preference button")!);
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
      // The set-up screen has no language list of its own (the comfort screen
      // before it and Preferences have); a language chosen there reaches it
      // as the app language, with what was typed kept.
      expect(container.querySelector(".language-choice")).toBeNull();
      act(() => setLocaleOverride(locale));
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

  it("shows its own title in the compact list, unless the screen already has one", () => {
    const { container, rerender } = render(<LanguageSetting compact />);
    expect(container.querySelector(".language-title")).toHaveTextContent(
      "Language",
    );
    rerender(<LanguageSetting compact showTitle={false} />);
    expect(container.querySelector(".language-title")).toBeNull();
    // Either way the options are one group named for a screen reader.
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();
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

// The list is a grid of real radio buttons: one, two or three columns by the
// room it has, each name in its own script, the chosen one marked by a fill and
// a check mark.
describe("Language drawn as a grid of buttons", () => {
  function renderIn(width: number, compact = false) {
    render(
      <div style={{ width }}>
        <LanguageSetting compact={compact} />
      </div>,
    );
    const group = screen.getByRole("group", { name: "Language" });
    const labels = within(group)
      .getAllByRole("radio")
      .map((radio) => radio.closest("label") as HTMLElement);
    return { group, labels };
  }
  const columns = (labels: HTMLElement[]) =>
    new Set(
      labels.map((label) => Math.round(label.getBoundingClientRect().left)),
    ).size;

  it("is real radio buttons in one named group, System default first, one checked", () => {
    const { group, labels } = renderIn(700);
    expect(group.tagName).toBe("FIELDSET");
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(8);
    expect(radios[0]).toHaveAccessibleName("System default");
    expect(
      radios.filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
    expect(radios[0]).toBeChecked();
    // Each name stays in its own script, and the check mark is for the eye only.
    expect(labels[2].querySelector('[lang="fr"]')).toHaveTextContent(
      "Français",
    );
    for (const label of labels)
      expect(label.querySelector(".choice-check")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
  });

  it("puts a hint on a smaller second line and keeps it in the name", () => {
    const { labels } = renderIn(700);
    const mandarin = screen.getByRole("radio", { name: "简体中文 (Mandarin)" });
    const label = mandarin.closest("label")!;
    expect(labels).toContain(label);
    const hint = label.querySelector<HTMLElement>(".choice-hint")!;
    expect(getComputedStyle(hint).display).toBe("block");
    const name = label.querySelector<HTMLElement>('[lang="zh-CN"]')!;
    expect(hint.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      name.getBoundingClientRect().bottom - 1,
    );
    expect(parseFloat(getComputedStyle(hint).fontSize)).toBeLessThan(
      parseFloat(getComputedStyle(name).fontSize),
    );
    expect(parseFloat(getComputedStyle(hint).fontSize)).toBeGreaterThanOrEqual(
      14,
    );
  });

  it("has three columns when wide, two when medium and one when narrow", () => {
    const wide = renderIn(760);
    expect(columns(wide.labels)).toBe(3);
    cleanup();
    const medium = renderIn(480);
    expect(columns(medium.labels)).toBe(2);
    cleanup();
    const narrow = renderIn(300);
    expect(columns(narrow.labels)).toBe(1);
    for (const label of narrow.labels) {
      expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(310);
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
    }
  });

  it("goes to one column when the text is enlarged, as at 200% zoom", () => {
    document.documentElement.style.fontSize = "200%";
    try {
      const { labels } = renderIn(480);
      expect(columns(labels)).toBe(1);
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });

  it("uses the same grid in the compact list of the first screen and the dialog", () => {
    const { labels } = renderIn(480, true);
    expect(columns(labels)).toBe(2);
    cleanup();
    expect(columns(renderIn(300, true).labels)).toBe(1);
  });

  it("marks the chosen language with a check mark and moves with the arrow keys", async () => {
    const user = userEvent.setup();
    const { group, labels } = renderIn(760);
    const visible = () =>
      labels.map(
        (label) =>
          getComputedStyle(label.querySelector(".choice-check")!).visibility,
      );
    expect(visible()).toEqual(["visible", ...Array(7).fill("hidden")]);
    within(group).getByRole("radio", { name: "English" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(
      within(group).getByRole("radio", { name: "Français" }),
    ).toBeChecked();
    expect(visible()[2]).toBe("visible");
    expect(visible().filter((value) => value === "visible")).toHaveLength(1);
  });

  it("is 36px tall with a mouse and 44px otherwise", () => {
    const { labels } = renderIn(760);
    const fine = window.matchMedia(
      "(pointer: fine) and (not (any-pointer: coarse))",
    ).matches;
    for (const label of labels)
      expect(
        Math.round(label.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(fine ? 36 : 44);
  });
});
