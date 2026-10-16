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

/** Visible controls smaller than 44px. A radio or tick box is pressed
 * through its label, so the label is what is measured. */
function undersized() {
  const found: string[] = [];
  for (const control of document.body.querySelectorAll<HTMLElement>(
    "button, a[href], input, select, textarea, summary",
  )) {
    if (!control.checkVisibility()) continue;
    const target =
      control.matches("input[type=radio], input[type=checkbox]") &&
      control.closest("label")
        ? control.closest("label")!
        : control;
    const box = target.getBoundingClientRect();
    if (box.width < 44 || box.height < 44)
      found.push(
        `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim()}" ${Math.round(box.width)}x${Math.round(box.height)}`,
      );
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
  expect(undersized(), `${where}: targets under 44px`).toEqual([]);
  expect(tinyText(), `${where}: text under 14px`).toEqual([]);
}

afterEach(async () => {
  cleanup();
  await page.viewport(1100, 760);
});

describe("targets and text sizes in the app (#67)", () => {
  for (const [label, width, height] of [
    ["desktop", 1100, 760],
    ["phone", 390, 844],
  ] as const) {
    it(`are comfortable on ${label}: library, grid, details, Security and Preferences`, async () => {
      await page.viewport(width, height);
      renderLibrary();
      expectComfortable("library");
      fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
      expectComfortable("grid");
      fireEvent.click(screen.getByRole("button", { name: "List view" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Details for FAKE Results.pdf" }),
      );
      expectComfortable("details");
      fireEvent.click(
        screen.getByRole("button", { name: "Close document details" }),
      );
      const open = (name: string) =>
        fireEvent.click(
          label === "phone"
            ? screen.getByRole("button", { name })
            : screen.getByRole("button", { name: new RegExp(`^${name}`) }),
        );
      open("Security");
      expectComfortable("Security");
      open("Preferences");
      expectComfortable("Preferences");
    });
  }

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
