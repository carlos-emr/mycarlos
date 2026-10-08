import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { NativeZoom } from "./nativeZoom";
import { PreferencesSettings } from "./PreferencesSettings";
import { NativeZoomProvider, TextSizeSetting } from "./TextSizeSetting";
import { startZoom } from "./zoom";

function show(kept?: string, mac = false) {
  if (kept) window.localStorage.setItem("mycarlos.zoom.v1", kept);
  const setZoom = vi.fn().mockResolvedValue(undefined);
  const zoom = startZoom(setZoom, mac);
  onTestFinished(zoom.stop);
  // Inside the provider, which tells every change of size.
  render(
    <NativeZoomProvider
      initial={{ zoom, mac }}
      installed={Promise.resolve(null)}
    >
      <TextSizeSetting zoom={zoom} mac={mac} />
    </NativeZoomProvider>,
  );
  return { setZoom, zoom };
}

const box = () => screen.getByRole("textbox", { name: "Text size in percent" });

describe("TextSizeSetting", () => {
  beforeEach(() => window.localStorage.clear());
  // Other test files share this storage.
  afterEach(() => window.localStorage.removeItem("mycarlos.zoom.v1"));

  it("shows the size and the way to change it without a keyboard", async () => {
    const user = userEvent.setup();
    const { setZoom } = show();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Text size 100%");
    expect(box()).toHaveValue("100");
    // Nothing to go back to at the ordinary size.
    expect(
      screen.queryByRole("button", { name: "Back to normal size" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/hold Ctrl and press plus/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Larger text" }));
    expect(status).toHaveTextContent("Text size 110%");
    expect(box()).toHaveValue("110");
    expect(setZoom).toHaveBeenLastCalledWith(1.1);

    await user.click(
      screen.getByRole("button", { name: "Back to normal size" }),
    );
    expect(status).toHaveTextContent("Text size 100%");
    expect(setZoom).toHaveBeenLastCalledWith(1);
  });

  it("shows a size that was set with the keys, or kept from last time", () => {
    show("2.5");
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Text size 250%");
    expect(box()).toHaveValue("250");
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "-", ctrlKey: true }),
      );
    });
    expect(status).toHaveTextContent("Text size 200%");
    expect(box()).toHaveValue("200");
  });

  it("stops at each end, and keeps the focus there", async () => {
    const user = userEvent.setup();
    const { setZoom } = show("3");
    const larger = screen.getByRole("button", { name: "Larger text" });
    await user.click(larger);
    expect(larger).toHaveAttribute("aria-disabled", "true");
    expect(larger).toHaveFocus();
    await user.click(larger);
    expect(setZoom).toHaveBeenLastCalledWith(4);
    expect(
      screen.getByRole("button", { name: "Smaller text" }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("puts the focus on Larger text after going back to normal size", async () => {
    const user = userEvent.setup();
    show("1.5");
    await user.click(
      screen.getByRole("button", { name: "Back to normal size" }),
    );
    expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
  });

  it("keeps the focus when Ctrl+0 removes Back to normal size", async () => {
    const user = userEvent.setup();
    show("1.5");
    await user.click(
      screen.getByRole("button", { name: "Back to normal size" }),
    );
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    const back = screen.getByRole("button", { name: "Back to normal size" });
    back.focus();
    await user.keyboard("{Control>}0{/Control}");
    expect(back).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
  });

  it.each([
    [
      "Ctrl+minus",
      "1.1",
      () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "-", ctrlKey: true }),
        ),
    ],
    [
      "Ctrl+plus",
      "0.9",
      () =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "+", ctrlKey: true }),
        ),
    ],
    [
      "Ctrl with the wheel",
      "0.9",
      () =>
        window.dispatchEvent(
          new WheelEvent("wheel", {
            // One notch, in the page's pixels at 90%.
            deltaY: -100 / 0.9,
            ctrlKey: true,
            cancelable: true,
          }),
        ),
    ],
  ])(
    "keeps the focus when %s removes Back to normal size",
    (_how, kept, press) => {
      show(kept);
      const back = screen.getByRole("button", { name: "Back to normal size" });
      back.focus();
      act(press);
      expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
      expect(back).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
    },
  );

  it("does not take the focus behind an open dialog", () => {
    show("1.5");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    onTestFinished(() => dialog.remove());
    const back = screen.getByRole("button", { name: "Back to normal size" });
    back.focus();
    // By a key, not a click, so that only the focus says Back was in use.
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "0", ctrlKey: true }),
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
    expect(back).not.toBeInTheDocument();
    // The dialog's own focus handling takes it back; this setting does not.
    expect(
      screen.getByRole("button", { name: "Larger text" }),
    ).not.toHaveFocus();
  });

  it("leaves the focus in an open dialog when its buttons are pressed", async () => {
    show("1.5");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const inside = document.createElement("button");
    inside.textContent = "FAKE dialog button";
    dialog.append(inside);
    document.body.append(dialog);
    onTestFinished(() => dialog.remove());
    inside.focus();
    // As a screen reader presses it: without moving the focus first.
    await act(async () =>
      screen.getByRole("button", { name: "Back to normal size" }).click(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
    expect(inside).toHaveFocus();
  });

  it("tells a change once, from one status for the whole app", async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Larger text" }));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Text size 110%");
  });

  it("names the key a Mac has", () => {
    show("1.5", true);
    expect(screen.getByText(/hold Command and press plus/)).toBeVisible();
  });

  describe("the box", () => {
    it("is labelled and described for a screen reader", () => {
      show();
      expect(box()).toHaveAccessibleDescription(/from 80% to 400%/);
    });

    it.each([
      ["150", 1.5, "150"],
      ["125%", 1.25, "125"],
      [" 200 % ", 2, "200"],
    ])("applies %j with Enter", async (typed, level, shown) => {
      const user = userEvent.setup();
      const { setZoom } = show();
      await user.clear(box());
      await user.type(box(), `${typed}{Enter}`);
      expect(setZoom).toHaveBeenLastCalledWith(level);
      expect(screen.getByRole("status")).toHaveTextContent(
        `Text size ${shown}%`,
      );
      expect(box()).toHaveValue(shown);
      expect(box()).toHaveFocus();
      expect(box()).not.toHaveAttribute("aria-invalid");
    });

    it.each([
      ["130", 1.25, "130% is between sizes, so it is 125%."],
      ["500", 4, "The largest size is 400%."],
      ["50", 0.8, "The smallest size is 80%."],
    ])(
      "goes to the nearest size there is for %s, and says so",
      async (typed, level, note) => {
        const user = userEvent.setup();
        const { setZoom } = show();
        await user.clear(box());
        await user.type(box(), `${typed}{Enter}`);
        expect(setZoom).toHaveBeenLastCalledWith(level);
        expect(box()).toHaveAccessibleDescription(new RegExp(`^${note}`));
        expect(screen.getByText(note)).toBeVisible();
      },
    );

    it.each(["abc", "", "1e3", "-120", "12,5"])(
      "refuses %j without changing the size",
      async (typed) => {
        const user = userEvent.setup();
        const { setZoom } = show("1.5");
        setZoom.mockClear();
        await user.clear(box());
        if (typed) await user.type(box(), typed);
        await user.keyboard("{Enter}");
        expect(setZoom).not.toHaveBeenCalled();
        expect(screen.getByRole("status")).toHaveTextContent("Text size 150%");
        expect(box()).toHaveAttribute("aria-invalid", "true");
        expect(box()).toHaveAccessibleDescription(
          /^Type a number from 80 to 400\./,
        );
        // Kept to be corrected, where the focus already is.
        expect(box()).toHaveValue(typed);
        expect(box()).toHaveFocus();

        // Correcting it takes the refusal away.
        await user.clear(box());
        await user.type(box(), "200");
        expect(box()).not.toHaveAttribute("aria-invalid");
        await user.keyboard("{Enter}");
        expect(setZoom).toHaveBeenLastCalledWith(2);
      },
    );

    it("gives up what was typed with Escape", async () => {
      const user = userEvent.setup();
      const { setZoom } = show();
      await user.clear(box());
      await user.type(box(), "300{Escape}");
      expect(box()).toHaveValue("100");
      expect(setZoom).not.toHaveBeenCalled();
    });

    it("applies what was typed when it is left", async () => {
      const user = userEvent.setup();
      const { setZoom } = show();
      await user.clear(box());
      await user.type(box(), "175");
      await user.tab();
      expect(setZoom).toHaveBeenLastCalledWith(1.75);
      expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
    });

    it("changes nothing when the size typed is the size shown", async () => {
      const user = userEvent.setup();
      const { setZoom } = show("1.25");
      setZoom.mockClear();
      await user.clear(box());
      await user.type(box(), "125{Enter}");
      expect(setZoom).not.toHaveBeenCalled();
      expect(box()).toHaveValue("125");
    });

    it("forgets what was typed when the size changes another way", async () => {
      const user = userEvent.setup();
      const { setZoom } = show("1.5");
      await user.clear(box());
      await user.type(box(), "200");
      // Ctrl+0 means the ordinary size, whatever is half typed.
      await user.keyboard("{Control>}0{/Control}");
      expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
      expect(box()).toHaveValue("100");
      await user.tab();
      expect(setZoom).toHaveBeenLastCalledWith(1);
      expect(setZoom).not.toHaveBeenCalledWith(2);
    });

    it("drops a note about a typed size once the size changes another way", async () => {
      const user = userEvent.setup();
      show();
      await user.clear(box());
      await user.type(box(), "130{Enter}");
      const note = "130% is between sizes, so it is 125%.";
      expect(screen.getByText(note)).toBeVisible();
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "+", ctrlKey: true }),
        );
      });
      expect(screen.getByRole("status")).toHaveTextContent("Text size 150%");
      expect(screen.queryByText(note)).not.toBeInTheDocument();
    });

    it("waits when the window, not the box, loses the focus", async () => {
      const user = userEvent.setup();
      const { setZoom } = show();
      await user.clear(box());
      await user.type(box(), "2");
      // Another app comes forward: the box keeps the focus in this window.
      act(() => {
        box().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      });
      expect(box()).toHaveFocus();
      expect(setZoom).not.toHaveBeenCalled();
      expect(box()).toHaveValue("2");
      await user.type(box(), "00{Enter}");
      expect(setZoom).toHaveBeenLastCalledWith(2);
    });

    it("keeps the focus when the box is left for Back to normal size with 100 typed", async () => {
      const user = userEvent.setup();
      show("1.5");
      await user.clear(box());
      await user.type(box(), "100");
      await user.click(
        screen.getByRole("button", { name: "Back to normal size" }),
      );
      expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
      expect(
        screen.queryByRole("button", { name: "Back to normal size" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Larger text" })).toHaveFocus();
    });

    it("is kept for the next launch", async () => {
      const user = userEvent.setup();
      show();
      await user.clear(box());
      await user.type(box(), "250{Enter}");
      await vi.waitFor(() =>
        expect(window.localStorage.getItem("mycarlos.zoom.v1")).toBe("2.5"),
      );
    });
  });
});

describe("NativeZoomProvider", () => {
  afterEach(() => window.localStorage.removeItem("mycarlos.zoom.v1"));

  it("tells a change of size on any screen, not only Preferences", () => {
    const zoom = startZoom(vi.fn().mockResolvedValue(undefined), false);
    onTestFinished(zoom.stop);
    render(
      <NativeZoomProvider
        initial={{ zoom, mac: false }}
        installed={Promise.resolve(null)}
      >
        <p>FAKE records list</p>
      </NativeZoomProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "+", ctrlKey: true }),
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent("Text size 110%");
  });
});

describe("PreferencesSettings", () => {
  afterEach(() => window.localStorage.removeItem("mycarlos.zoom.v1"));

  it("offers the text size once the zoom is installed after the first render", async () => {
    let install!: (native: NativeZoom | null) => void;
    const installed = new Promise<NativeZoom | null>((resolve) => {
      install = resolve;
    });
    render(
      <NativeZoomProvider initial={null} installed={installed}>
        <PreferencesSettings />
      </NativeZoomProvider>,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Preferences" }),
    ).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const zoom = startZoom(vi.fn().mockResolvedValue(undefined), false);
    onTestFinished(zoom.stop);
    await act(async () => install({ zoom, mac: false }));
    expect(screen.getByRole("status")).toHaveTextContent("Text size 100%");
    expect(box()).toHaveValue("100");
  });

  it("says what sets the text size where there is no zoom", async () => {
    render(
      <NativeZoomProvider initial={null} installed={Promise.resolve(null)}>
        <PreferencesSettings />
      </NativeZoomProvider>,
    );
    await act(async () => undefined);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByText(/Here, text size follows your device/),
    ).toBeVisible();
  });
});
