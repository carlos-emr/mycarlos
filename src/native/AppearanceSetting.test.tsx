import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
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
  it("offers all three choices beside Text size even without desktop zoom", async () => {
    const user = userEvent.setup();
    const appearance = startAppearance();
    render(
      <AppearanceProvider appearance={appearance}>
        <PreferencesSettings />
      </AppearanceProvider>,
    );
    const choice = screen.getByRole("combobox", { name: "Appearance" });
    expect(choice).toHaveValue("system");
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["System", "Light", "Dark"]);
    expect(
      screen.getByText(/Here, text size follows your device/),
    ).toBeVisible();
    await user.selectOptions(choice, "dark");
    expect(choice).toHaveFocus();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(choice).toHaveAccessibleDescription(/System follows your device/);
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
    const choice = screen.getByRole("combobox", { name: "Appearance" });
    await user.selectOptions(choice, "light");
    expect(choice).toHaveValue("light");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "could not be remembered",
    );
    expect(choice).toHaveAccessibleDescription(/could not be remembered/);
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
