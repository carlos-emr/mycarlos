import { humanText } from "../test/humanText";
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
    // Each choice is a button-sized target: 36px for a mouse, 44px otherwise.
    const minimum = window.matchMedia("(pointer: fine)").matches ? 36 : 44;
    for (const choice of choices)
      expect(
        (choice.closest("label") as HTMLElement).getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(minimum);
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

// The four choices are real radio buttons, drawn as a row of buttons that wraps
// to two by two. The component tests run in a real browser with the real
// stylesheet, so the layout is measured, not assumed.
describe("Appearance drawn as a row of buttons", () => {
  function renderIn(width: number) {
    const appearance = startAppearance();
    render(
      <div style={{ width }}>
        <AppearanceProvider appearance={appearance}>
          <PreferencesSettings />
        </AppearanceProvider>
      </div>,
    );
    const group = screen.getByRole("group", { name: humanText("Appearance") });
    const labels = within(group)
      .getAllByRole("radio")
      .map((radio) => radio.closest("label") as HTMLElement);
    return { group, labels };
  }

  it("keeps real radio buttons in one named group, with exactly one checked", () => {
    const { group } = renderIn(900);
    expect(group.tagName).toBe("FIELDSET");
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(4);
    for (const radio of radios) {
      expect(radio).toHaveAttribute("type", "radio");
      expect(radio).toHaveAttribute("name", radios[0].getAttribute("name"));
    }
    expect(
      radios.filter((radio) => (radio as HTMLInputElement).checked),
    ).toHaveLength(1);
    expect(
      within(group).getByRole("radio", { name: humanText("High contrast") }),
    ).not.toBeChecked();
  });

  it("marks the chosen button with a check mark as well as a fill, never by colour alone", async () => {
    const user = userEvent.setup();
    const { labels } = renderIn(900);
    const mark = (label: HTMLElement) =>
      label.querySelector<SVGElement>(".choice-check")!;
    // The mark is for the eye only: hidden from a screen reader, which hears "checked".
    for (const label of labels)
      expect(mark(label)).toHaveAttribute("aria-hidden", "true");
    const visible = () =>
      labels.map((label) => getComputedStyle(mark(label)).visibility);
    expect(visible()).toEqual(["visible", "hidden", "hidden", "hidden"]);
    await user.click(labels[2]);
    expect(visible()).toEqual(["hidden", "hidden", "visible", "hidden"]);
    // The fill: the chosen radio's own box differs from an unchosen one's.
    const fill = (label: HTMLElement) =>
      getComputedStyle(label.querySelector("input")!).backgroundColor;
    expect(fill(labels[2])).not.toBe(fill(labels[0]));
    // The check mark takes room whether shown or not, so choosing moves no words.
    const before = labels[1]
      .querySelector("span span:last-child")!
      .getBoundingClientRect().left;
    await user.click(labels[1]);
    expect(
      labels[1].querySelector("span span:last-child")!.getBoundingClientRect()
        .left,
    ).toBe(before);
  });

  it("is moved through with the arrow keys, choosing as it goes", async () => {
    const user = userEvent.setup();
    const { group } = renderIn(900);
    const system = within(group).getByRole("radio", {
      name: humanText("System"),
    });
    system.focus();
    await user.keyboard("{ArrowRight}");
    const light = within(group).getByRole("radio", {
      name: humanText("Light"),
    });
    expect(light).toHaveFocus();
    expect(light).toBeChecked();
    await user.keyboard("{ArrowDown}");
    expect(
      within(group).getByRole("radio", { name: humanText("Dark") }),
    ).toBeChecked();
  });

  it("shows a visible focus ring on the focused button", async () => {
    const user = userEvent.setup();
    const { group } = renderIn(900);
    // Moving by key is what makes the ring show (:focus-visible).
    within(group).getByRole("radio", { checked: true }).focus();
    await user.keyboard("{ArrowRight}");
    const focused = document.activeElement as HTMLElement;
    expect(group.contains(focused)).toBe(true);
    const style = getComputedStyle(focused);
    expect(style.outlineStyle).not.toBe("none");
    expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(3);
  });

  it("is one row of four in a wide space and two by two in a narrow one", () => {
    const wide = renderIn(900);
    const tops = (labels: HTMLElement[]) =>
      labels.map((label) => Math.round(label.getBoundingClientRect().top));
    expect(new Set(tops(wide.labels)).size).toBe(1);
    cleanup();
    const narrow = renderIn(300);
    const rows = tops(narrow.labels);
    expect(rows[0]).toBe(rows[1]);
    expect(rows[2]).toBe(rows[3]);
    expect(rows[2]).toBeGreaterThan(rows[0]);
    // Nothing runs out sideways, and no button is crushed.
    for (const label of narrow.labels) {
      const box = label.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(310);
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
    }
  });

  it("is 36px tall with a mouse and 44px otherwise", () => {
    const { labels } = renderIn(700);
    const fine = window.matchMedia("(pointer: fine)").matches;
    for (const label of labels)
      expect(Math.round(label.getBoundingClientRect().height)).toBe(
        fine ? 36 : 44,
      );
  });
});
