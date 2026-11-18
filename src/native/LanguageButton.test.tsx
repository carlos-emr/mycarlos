import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  getLanguagePreference,
  LANGUAGE_STORAGE_KEY,
  LOCALES,
  setLocaleOverride,
  translate,
} from "../i18n";
import { LanguageButton } from "./LanguageButton";
import { languageName } from "./LanguageSetting";
import { VaultAuthFrame } from "./VaultAuth";

afterEach(() => {
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  setLocaleOverride(null);
});

describe("the language button on the unlock and set-up screens", () => {
  it.each(LOCALES)(
    "shows a globe and the language's own name, named by both, in %s",
    (locale) => {
      setLocaleOverride(locale);
      render(<LanguageButton />);
      const own = languageName(locale);
      const button = screen.getByRole("button", {
        name: `${translate(locale, "language.title")}: ${own}`,
      });
      // What a person who cannot read the screen sees: the globe and the name.
      expect(button.querySelector("svg")).not.toBeNull();
      expect(within(button).getByText(own)).toHaveAttribute("lang", locale);
      expect(button).toHaveAttribute("aria-haspopup", "dialog");
    },
  );

  it("opens the language list in a dialog, changes the language, and returns focus", async () => {
    const user = userEvent.setup();
    render(<LanguageButton />);
    const button = screen.getByRole("button", { name: /Language: English/ });
    await user.click(button);
    const dialog = screen.getByRole("dialog", { name: "Language" });
    await user.click(within(dialog).getByRole("radio", { name: "Français" }));
    expect(getLanguagePreference().choice).toBe("fr");
    // The dialog and the button now speak French; the list is the Settings one.
    expect(
      screen.getByRole("dialog", { name: translate("fr", "language.title") }),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: translate("fr", "interface.AnonymizePreview.close"),
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: `${translate("fr", "language.title")}: Français`,
      }),
    ).toHaveFocus();
  });

  it("closes with Escape without changing the language", async () => {
    const user = userEvent.setup();
    render(<LanguageButton />);
    await user.click(screen.getByRole("button", { name: /Language/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getLanguagePreference().choice).toBeNull();
  });

  it("is on the unlock and set-up frames only when asked for, above the card", () => {
    const { rerender } = render(
      <VaultAuthFrame state="Locked" language>
        <p>card</p>
      </VaultAuthFrame>,
    );
    const main = screen.getByRole("main");
    expect(main.firstElementChild).toHaveClass("language-corner");
    rerender(
      <VaultAuthFrame state="Locked">
        <p>card</p>
      </VaultAuthFrame>,
    );
    expect(screen.queryByRole("button", { name: /Language/ })).toBeNull();
  });

  it("follows a language chosen elsewhere", () => {
    render(<LanguageButton />);
    act(() => setLocaleOverride("pl"));
    expect(
      screen.getByRole("button", {
        name: `${translate("pl", "language.title")}: Polski`,
      }),
    ).toBeInTheDocument();
  });
});
