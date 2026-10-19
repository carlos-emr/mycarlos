import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultBridge, VaultSnapshot } from "../vault";
import { VaultLibrary } from "./VaultLibrary";

// #67: every pressable target is at least 44px, and no text is under 14px.
const vault = {
  profiles: [
    { id: "p1", displayName: "FAKE Avery", createdAtMs: 1 },
    { id: "p2", displayName: "FAKE Blake", createdAtMs: 2 },
  ],
  folders: [
    {
      id: "f1",
      profileId: "p1",
      parentId: null,
      name: "FAKE Letters",
      createdAtMs: 1,
    },
  ],
  records: [
    {
      id: "r1",
      profileId: "p1",
      folderIds: [],
      displayName: "FAKE Results.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    },
  ],
  recovery: null,
  recoveryKeySetAtMs: 1,
} as VaultSnapshot;

function renderLibrary() {
  const bridge = {
    snapshot: vi.fn().mockResolvedValue(vault),
  } as unknown as VaultBridge;
  render(
    <VaultLibrary
      bridge={bridge}
      snapshot={vault}
      busy={false}
      notice=""
      setNotice={vi.fn()}
      run={async (operation) => operation()}
      refresh={async () => vault}
      onLock={vi.fn().mockResolvedValue(undefined)}
      autoLockMinutes={5}
      onAutoLockMinutes={vi.fn()}
    />,
  );
}

function visibleControls() {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>(
      "button, a[href], input, select, textarea, summary",
    ),
  ).filter((control) => control.checkVisibility());
}

const describeControl = (control: HTMLElement) =>
  `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim()}"`;

/** Visible controls smaller than 44px. A radio or tick box is pressed
 * through its label, so the label is what is measured. */
function undersized() {
  const found: string[] = [];
  for (const control of visibleControls()) {
    const target =
      control.matches("input[type=radio], input[type=checkbox]") &&
      control.closest("label")
        ? control.closest("label")!
        : control;
    const box = target.getBoundingClientRect();
    if (box.width < 44 || box.height < 44)
      found.push(
        `${describeControl(control)} ${Math.round(box.width)}x${Math.round(box.height)}`,
      );
  }
  return found;
}

/** Text kept for screen readers only: clipped, or a box of at most 1px. */
function visuallyHidden(element: HTMLElement) {
  const style = getComputedStyle(element);
  return (
    element.clientWidth <= 1 ||
    style.clip !== "auto" ||
    style.clipPath !== "none"
  );
}

/** Visible controls whose words spill out of them, or that are partly cut
 * off by a box that hides what overflows it: on a phone, List and Grid were
 * squeezed inside their segment. */
function clipped() {
  const found: string[] = [];
  for (const control of visibleControls()) {
    // Words wider than a button that has shrunk spill out of it.
    if (
      !control.matches("input, select, textarea") &&
      (control.scrollWidth > control.clientWidth + 1 ||
        control.scrollHeight > control.clientHeight + 1)
    ) {
      found.push(`${describeControl(control)} overflows its own box`);
      continue;
    }
    // Words cut short inside it, such as a folder's name in its Open button.
    // Words only a screen reader reads (.sr-only) are clipped on purpose.
    const cut = Array.from(control.querySelectorAll<HTMLElement>("*")).find(
      (inner) =>
        inner.checkVisibility() &&
        !visuallyHidden(inner) &&
        inner.scrollWidth > inner.clientWidth + 1,
    );
    if (cut) {
      found.push(
        `${describeControl(control)} cuts off "${cut.textContent!.trim()}"`,
      );
      continue;
    }
    const box = control.getBoundingClientRect();
    // A fixed dialog is not clipped by the boxes it sits in.
    for (
      let inner: HTMLElement = control, outer = control.parentElement;
      outer && getComputedStyle(inner).position !== "fixed";
      inner = outer, outer = outer.parentElement
    ) {
      const style = getComputedStyle(outer);
      const hides = (overflow: string) =>
        overflow === "hidden" || overflow === "clip";
      const edge = outer.getBoundingClientRect();
      if (
        (hides(style.overflowX) &&
          (box.left < edge.left - 1 || box.right > edge.right + 1)) ||
        (hides(style.overflowY) &&
          (box.top < edge.top - 1 || box.bottom > edge.bottom + 1))
      ) {
        found.push(
          `${describeControl(control)} cut off by .${outer.className}`,
        );
        break;
      }
    }
  }
  return found;
}

/** Visible text in a font smaller than 14px. */
function tinyText() {
  const found: string[] = [];
  for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
    if (!element.checkVisibility()) continue;
    const ownText = Array.from(element.childNodes).some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
    );
    const size = parseFloat(getComputedStyle(element).fontSize);
    if (ownText && size < 14)
      found.push(
        `${element.tagName.toLowerCase()} "${element.textContent!.trim().slice(0, 30)}" ${size}px`,
      );
  }
  return found;
}

function expectComfortable(where: string) {
  // Closed disclosures hide forms that are measured too.
  for (const disclosure of document.querySelectorAll("details"))
    disclosure.open = true;
  expect(undersized(), `${where}: targets under 44px`).toEqual([]);
  expect(clipped(), `${where}: controls cut off`).toEqual([]);
  expect(tinyText(), `${where}: text under 14px`).toEqual([]);
}

const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

afterEach(async () => {
  cleanup();
  document.getElementById("wide-font")?.remove();
  await page.viewport(1100, 760);
});

/** A wide font that every machine has one of (DejaVu Sans on Linux, CI
 * included; Verdana on Windows and macOS), so a layout that only fits in a
 * narrower font such as Roboto fails everywhere, not only where it is
 * missing. */
function useWideFont() {
  const style = document.createElement("style");
  style.id = "wide-font";
  style.textContent =
    ':root { font-family: "DejaVu Sans", Verdana, sans-serif !important; }';
  document.head.append(style);
}

describe("targets and text sizes in the app (#67)", () => {
  for (const [label, width, height] of [
    ["desktop", 1100, 760],
    ["phone", 390, 844],
    // The narrowest width content must reflow to (WCAG 1.4.10), and the room a
    // wider phone font leaves: the section tabs and document names must still fit.
    ["narrow phone", 320, 640],
  ] as const) {
    for (const wide of [false, true])
      it(`are comfortable on ${label}${wide ? " in a wide font" : ""}: library, grid, details, Security and Preferences`, async () => {
        if (wide) useWideFont();
        await page.viewport(width, height);
        renderLibrary();
        expectComfortable("library");
        press("Select FAKE Results.pdf");
        expectComfortable("selected, with the bulk bar");
        press("Clear");
        press(/^New folder/);
        expectComfortable("new folder form");
        press("Cancel");
        press("Rename folder FAKE Letters");
        expectComfortable("rename folder");
        press("Cancel");
        press("Grid view");
        expectComfortable("grid");
        press("List view");
        press("Details for FAKE Results.pdf");
        expectComfortable("details");
        press("Rename document");
        expectComfortable("rename document");
        press("Cancel");
        press("Permanently delete");
        expectComfortable("confirm delete");
        press("Cancel");
        press("Save a copy to this computer");
        expectComfortable("confirm save a copy");
        press("Cancel");
        press("Close document details");
        const open = (name: string) =>
          press(label === "desktop" ? new RegExp(`^${name}`) : name);
        open("Security");
        expectComfortable("Security");
        open("Preferences");
        expectComfortable("Preferences");
      });
  }

  it("keeps the disclosure triangle on taller summaries", () => {
    const expectTriangles = () => {
      const summaries = document.querySelectorAll("summary");
      expect(summaries).not.toHaveLength(0);
      for (const summary of summaries)
        expect(getComputedStyle(summary).display, summary.textContent!).toBe(
          "list-item",
        );
    };
    renderLibrary();
    expectTriangles();
    press(/^Security/);
    expectTriangles();
  });

  it("does not count words kept for screen readers as cut off", () => {
    render(
      <button type="button" style={{ width: 120 }}>
        Rename
        <span className="sr-only"> FAKE Results with a long name.pdf</span>
      </button>,
    );
    expect(clipped()).toEqual([]);
  });

  it("shows body text at 16px", () => {
    renderLibrary();
    for (const element of [
      screen.getByRole("button", { name: "FAKE Results.pdf" }),
      screen.getByRole("button", { name: "Details for FAKE Results.pdf" }),
      screen.getByText(/Hold and drag a document or folder/),
    ])
      expect(getComputedStyle(element).fontSize).toBe("16px");
  });
});
