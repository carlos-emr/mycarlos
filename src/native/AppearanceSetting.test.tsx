import { humanText } from "../test/humanText";
import { StrictMode } from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppearanceProvider } from "../AppearanceProvider";
import { APPEARANCE_STORAGE_KEY, startAppearance } from "../appearance";
import { LOCALES, setLocaleOverride } from "../i18n";
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
    const minimum = window.matchMedia(
      "(pointer: fine) and (not (any-pointer: coarse))",
    ).matches
      ? 36
      : 44;
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
    const narrow = renderIn(400);
    const rows = tops(narrow.labels);
    expect(rows[0]).toBe(rows[1]);
    expect(rows[2]).toBe(rows[3]);
    expect(rows[2]).toBeGreaterThan(rows[0]);
    // Nothing runs out sideways, and no button is crushed.
    for (const label of narrow.labels) {
      const box = label.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(410);
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
    }
  });

  it("is 36px tall with a mouse and 44px otherwise", () => {
    const { labels } = renderIn(700);
    const fine = window.matchMedia(
      "(pointer: fine) and (not (any-pointer: coarse))",
    ).matches;
    for (const label of labels)
      expect(Math.round(label.getBoundingClientRect().height)).toBe(
        fine ? 36 : 44,
      );
  });
});

// The two groups of buttons sit inside .setting-list, which hides what runs past
// its edge, in rows with 2px of padding. A focus ring drawn outside a button
// would be cut on the outermost buttons, and on every button in one column.
describe("Preferences choices keep their focus ring and their words whole", () => {
  function renderIn(width: number) {
    const appearance = startAppearance();
    render(
      <div style={{ width }}>
        <AppearanceProvider appearance={appearance}>
          <PreferencesSettings />
        </AppearanceProvider>
      </div>,
    );
  }

  /** The first ancestor that clips the focus ring of `radio`, or null. */
  function clippedBy(radio: HTMLElement) {
    const style = getComputedStyle(radio);
    // The ring is drawn from `offset` outside the box, `width` thick.
    const grow =
      parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const box = radio.getBoundingClientRect();
    const ring = {
      left: box.left - grow,
      right: box.right + grow,
      top: box.top - grow,
      bottom: box.bottom + grow,
    };
    for (let at = radio.parentElement; at; at = at.parentElement) {
      const cs = getComputedStyle(at);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const edge = at.getBoundingClientRect();
      if (
        ring.left < edge.left - 0.5 ||
        ring.right > edge.right + 0.5 ||
        ring.top < edge.top - 0.5 ||
        ring.bottom > edge.bottom + 0.5
      )
        return at.className || at.tagName;
    }
    return null;
  }

  for (const width of [900, 300]) {
    it(`never cuts the focus ring of any Appearance or Language button, in a ${width}px space`, async () => {
      const user = userEvent.setup();
      renderIn(width);
      const radios = [
        ...document.querySelectorAll<HTMLInputElement>(
          ".choice-segmented input, .choice-grid input",
        ),
      ];
      expect(radios).toHaveLength(12);
      for (const radio of radios) {
        // A key press first, so that focus shows as it does to a keyboard user.
        await user.keyboard("{Shift}");
        radio.focus();
        expect(radio.matches(":focus-visible")).toBe(true);
        const style = getComputedStyle(radio);
        expect(style.outlineStyle).toBe("solid");
        expect(parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(3);
        expect(
          clippedBy(radio),
          radio.closest("label")!.textContent!,
        ).toBeNull();
      }
    });
  }

  // A word may wrap to the next line but not break in the middle (Contraste
  // élevé, Português): checked in every language, at widths from a phone to a
  // wide window, and with text enlarged to 200%.
  for (const locale of LOCALES.filter((locale) => !locale.startsWith("zh"))) {
    it(`never breaks a word of the choices mid-word in ${locale}`, () => {
      setLocaleOverride(locale);
      try {
        for (const size of ["", "200%"]) {
          document.documentElement.style.fontSize = size;
          for (const width of [320, 360, 480, 700, 900]) {
            renderIn(width);
            const split: string[] = [];
            for (const label of document.querySelectorAll(
              ".choice-segmented label, .choice-grid label",
            )) {
              const walker = document.createTreeWalker(
                label,
                NodeFilter.SHOW_TEXT,
              );
              for (
                let node = walker.nextNode();
                node;
                node = walker.nextNode()
              ) {
                for (const word of node.textContent!.matchAll(/[\p{L}]+/gu)) {
                  const range = document.createRange();
                  range.setStart(node, word.index!);
                  range.setEnd(node, word.index! + word[0].length);
                  if (range.getClientRects().length < 2) continue;
                  // Split. That is only a fault when the word would have fitted
                  // on a line of its own: a word wider than the whole button
                  // (a long Spanish word at 200% in a 320px window) cannot.
                  const text = label.querySelector("svg")!.nextElementSibling!;
                  const probe = document.createElement("span");
                  probe.style.cssText =
                    "position:absolute;visibility:hidden;white-space:nowrap";
                  probe.textContent = word[0];
                  node.parentElement!.append(probe);
                  const needed = probe.getBoundingClientRect().width;
                  probe.remove();
                  if (needed <= text.getBoundingClientRect().width + 1)
                    split.push(`${word[0]} at ${width}px ${size || "100%"}`);
                }
              }
            }
            expect(split).toEqual([]);
            cleanup();
          }
        }
      } finally {
        document.documentElement.style.fontSize = "";
        setLocaleOverride(null);
      }
    });
  }
});
