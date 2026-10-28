import { humanText } from "../test/humanText";
import { StrictMode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../AppearanceProvider";
import { APPEARANCE_STORAGE_KEY, startAppearance } from "../appearance";
import { PreferencesSettings } from "./PreferencesSettings";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
  delete document.documentElement.dataset.theme;
});

describe("Appearance in Preferences", () => {
  it("offers all four choices beside Text size even without desktop zoom", async () => {
    const user = userEvent.setup();
    const appearance = startAppearance();
    render(
      <AppearanceProvider appearance={appearance}>
        <PreferencesSettings />
      </AppearanceProvider>,
    );
    // Four radio buttons, all in view, instead of a dropdown (#67).
    const group = screen.getByRole("group", { name: humanText("Appearance") });
    expect(
      screen.queryByRole("combobox", { name: humanText("Appearance") }),
    ).toBeNull();
    const choices = within(group).getAllByRole("radio");
    expect(choices.map((choice) => choice.getAttribute("value"))).toEqual([
      "system",
      "light",
      "dark",
      "high-contrast",
    ]);
    expect(
      choices.map(
        (choice) => (choice.closest("label") as HTMLElement).textContent,
      ),
    ).toEqual(["System", "Light", "Dark", "High contrast"]);
    expect(
      within(group).getByRole("radio", { name: humanText("System") }),
    ).toBeChecked();
    expect(
      screen.getByText(humanText(/Here, text size follows your device/)),
    ).toBeVisible();
    const dark = within(group).getByRole("radio", { name: humanText("Dark") });
    await user.click(dark);
    expect(dark).toBeChecked();
    expect(dark).toHaveFocus();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(group).toHaveHumanAccessibleDescription(
      /System follows your device/,
    );
    const highContrast = within(group).getByRole("radio", {
      name: humanText("High contrast"),
    });
    await user.click(highContrast);
    expect(highContrast).toBeChecked();
    expect(highContrast).toHaveFocus();
    expect(document.documentElement.dataset.theme).toBe("high-contrast");
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(
      "high-contrast",
    );
    // Each choice's whole row is a 44px target.
    for (const choice of choices)
      expect(
        (choice.closest("label") as HTMLElement).getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(44);
  });

  it("tells a failed save without replacing the usable selection", async () => {
    const user = userEvent.setup();
    const appearance = startAppearance();
    render(
      <AppearanceProvider appearance={appearance}>
        <PreferencesSettings />
      </AppearanceProvider>,
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const group = screen.getByRole("group", { name: humanText("Appearance") });
    const light = within(group).getByRole("radio", {
      name: humanText("Light"),
    });
    await user.click(light);
    expect(light).toBeChecked();
    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "could not be remembered",
    );
    expect(group).toHaveHumanAccessibleDescription(/could not be remembered/);
  });

  it("keeps System live on screens without Preferences and cleans up StrictMode mounts", () => {
    let dark = false;
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal("matchMedia", (query: string) => {
      const callbacks = listeners.get(query) ?? new Set<() => void>();
      listeners.set(query, callbacks);
      return {
        get matches() {
          return query.includes("prefers-color-scheme") && dark;
        },
        addEventListener: (_: string, callback: () => void) =>
          callbacks.add(callback),
        removeEventListener: (_: string, callback: () => void) =>
          callbacks.delete(callback),
      };
    });
    const appearance = startAppearance();
    const view = render(
      <StrictMode>
        <AppearanceProvider appearance={appearance}>
          <p>FAKE locked screen</p>
        </AppearanceProvider>
      </StrictMode>,
    );
    expect([...listeners.values()].map((callbacks) => callbacks.size)).toEqual([
      1, 1,
    ]);
    act(() => {
      dark = true;
      listeners
        .get("(prefers-color-scheme: dark)")!
        .forEach((callback) => callback());
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    view.unmount();
    expect([...listeners.values()].map((callbacks) => callbacks.size)).toEqual([
      0, 0,
    ]);
  });
});
