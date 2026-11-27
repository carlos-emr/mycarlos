import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { LanguagePreference } from "./LanguagePreference";

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
  window.localStorage.clear();
});

describe("Preferences > Language: the unlock screen's dialog, behind one button", () => {
  it("shows the language in use on a button whose name starts with its visible words, and no list of its own", () => {
    setLocaleOverride("en");
    render(<LanguagePreference />);
    expect(screen.getByRole("heading", { name: "Language" })).toBeVisible();
    const button = screen.getByRole("button", { name: "English (Language)" });
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    // The visible words ("English") lead the name (WCAG 2.5.3, voice control).
    expect(button.textContent?.trim().startsWith("English")).toBe(true);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("group", { name: "Language" })).toBeNull();
  });

  it("opens the dialog with System default and one real radio for each language, each named by its visible words", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    render(<LanguagePreference />);
    await user.click(
      screen.getByRole("button", { name: "English (Language)" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Language" });
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(LOCALES.length + 1);
    expect(radios[0]).toHaveAccessibleName("System default");
    for (const radio of radios) {
      // The name is what the label shows: nothing hidden leads it.
      const shown = radio.closest("label")!.textContent!.replace(/\s+/g, " ");
      expect(radio).toHaveAccessibleName(shown.trim());
    }
  });

  it("changes the language from the dialog, keeps the dialog's keys, and gives the focus back to the button on Close", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    render(<LanguagePreference />);
    const opener = screen.getByRole("button", { name: "English (Language)" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Language" });
    await user.click(within(dialog).getByRole("radio", { name: "Français" }));
    expect(document.documentElement.lang).toBe("fr");
    expect(
      screen.getByRole("dialog", { name: translate("fr", "language.title") }),
    ).toBeVisible();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: translate("fr", "interface.AnonymizePreview.close"),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The button is named in the new language and has the focus again.
    expect(
      screen.getByRole("button", {
        name: `Français (${translate("fr", "language.title")})`,
      }),
    ).toHaveFocus();
  });

  it("closes with Escape and returns the focus to the button", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    render(<LanguagePreference />);
    const opener = screen.getByRole("button", { name: "English (Language)" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Language" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside the dialog, wrapping from the last control to the first and back", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    render(<LanguagePreference />);
    await user.click(
      screen.getByRole("button", { name: "English (Language)" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Language" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    // A radio group is one Tab stop: the chosen language.
    const first = within(dialog).getByRole("radio", { checked: true });
    close.focus();
    await user.tab();
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    // Neither key ever leaves the dialog.
    for (let step = 0; step < 14; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
