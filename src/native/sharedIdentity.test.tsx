import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import type { VaultBridge, VaultSnapshot, FoundIdentity } from "../vault";
import { VaultLibrary } from "./VaultLibrary";
const people = [
  { id: "p1", displayName: "FAKE Mom", createdAtMs: 1 },
  { id: "p2", displayName: "FAKE Jamie Example", createdAtMs: 2 },
];
describe("shared PDF suggestions use explicit Move", () => {
  const shared = (id: string, name: string) => ({
    id,
    profileId: "shared",
    folderIds: [],
    displayName: name,
    sourceLabel: "Shared from another app — unverified",
    mediaType: "application/octet-stream",
    plaintextSize: 1000,
    importedAtMs: Date.UTC(2026, 9, 14),
    available: true,
  });
  const vault: VaultSnapshot = {
    profiles: [
      ...people,
      { id: "shared", displayName: "Shared with me", createdAtMs: 3 },
    ],
    folders: [],
    records: [
      shared("s1", "FAKE Referral letter.pdf"),
      shared("s2", "FAKE Pharmacy receipt.pdf"),
      shared("s3", "FAKE Twin letter.pdf"),
    ],
    recovery: null,
    sharedProfileId: "shared",
  };

  function renderLibrary(extra: Partial<VaultBridge>, shown = vault) {
    const bridge = {
      platform: vi.fn().mockResolvedValue("windows"),
      isPhoto: vi.fn().mockResolvedValue(false),
      isLockedPdf: vi.fn().mockResolvedValue(false),
      snapshot: vi.fn().mockResolvedValue(shown),
      moveToPerson: vi
        .fn()
        .mockResolvedValue({ moved: ["s1"], alreadyThere: [] }),
      ...extra,
    } as unknown as VaultBridge;
    const setNotice = vi.fn();
    const screenFor = (current: VaultSnapshot) => (
      <VaultLibrary
        bridge={bridge}
        snapshot={current}
        busy={false}
        notice=""
        setNotice={setNotice}
        run={async (operation) => operation()}
        refresh={async () => current}
        onLock={vi.fn().mockResolvedValue(undefined)}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
      />
    );
    const view = render(screenFor(shown));
    return {
      bridge,
      setNotice,
      rerenderSnapshot: (current: VaultSnapshot) =>
        view.rerender(screenFor(current)),
    };
  }

  it("uses current saved people for a cached document suggestion and its Move", async () => {
    const shown = { ...vault, records: [vault.records[0]] };
    const identity = vi.fn().mockResolvedValue({ name: "FAKE Jamie Example" });
    const { bridge, rerenderSnapshot } = renderLibrary(
      { sharedIdentity: identity },
      shown,
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    const groupName = humanText(
      "Suggested person for FAKE Referral letter.pdf",
    );
    expect(
      within(await screen.findByRole("group", { name: groupName })).getByRole(
        "button",
        {
          name: humanText(
            "Move FAKE Referral letter.pdf to FAKE Jamie Example's records",
          ),
        },
      ),
    ).toBeEnabled();

    // A refreshed profile's recorded full name supersedes its display label.
    const unmatched = {
      ...shown,
      profiles: shown.profiles.map((person) =>
        person.id === "p2"
          ? { ...person, fullName: "FAKE Robin Sample" }
          : person,
      ),
    };
    rerenderSnapshot(unmatched);
    expect(screen.queryByRole("group", { name: groupName })).toBeNull();
    expect(bridge.moveToPerson).not.toHaveBeenCalled();

    rerenderSnapshot({
      ...unmatched,
      profiles: unmatched.profiles.map((person) =>
        person.id === "p1"
          ? { ...person, fullName: "FAKE Jamie Example" }
          : person,
      ),
    });
    await userEvent.click(
      within(await screen.findByRole("group", { name: groupName })).getByRole(
        "button",
        {
          name: humanText(
            "Move FAKE Referral letter.pdf to FAKE Mom's records",
          ),
        },
      ),
    );
    expect(bridge.moveToPerson).toHaveBeenCalledExactlyOnceWith(
      ["s1"],
      "p1",
      [],
    );
    expect(identity).toHaveBeenCalledExactlyOnceWith("s1");
  });

  it("suggests the one person a shared document's name matches, and only moves on Move", async () => {
    const found: Record<string, FoundIdentity | null> = {
      s1: { name: "EXAMPLE, FAKE JAMIE" },
      s2: { name: "FAKE Robin Sample" },
    };
    const { bridge } = renderLibrary({
      sharedIdentity: async (id: string) => found[id] ?? null,
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    const suggestion = await screen.findByRole("group", {
      name: humanText("Suggested person for FAKE Referral letter.pdf"),
    });
    expect(
      screen.queryByRole("group", {
        name: humanText("Suggested person for FAKE Pharmacy receipt.pdf"),
      }),
    ).toBeNull();
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
    await userEvent.click(
      within(suggestion).getByRole("button", { name: /^Move / }),
    );
    expect(bridge.moveToPerson).toHaveBeenCalledWith(["s1"], "p2", []);
  });

  it("pauses queued identity reads in the reader and resumes them when it closes", async () => {
    let finish: ((identity: FoundIdentity) => void) | undefined;
    const identity = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<FoundIdentity>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ name: "FAKE Jamie Example" });
    const complete = async () => {
      const reply = finish;
      finish = undefined;
      if (reply) await act(async () => reply({ name: "FAKE Jamie Example" }));
    };
    const { bridge } = renderLibrary(
      {
        sharedIdentity: identity,
        viewPage: vi.fn().mockResolvedValue({
          pageCount: 1,
          width: 1,
          height: 1,
          image:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          text: "FAKE reader text",
        }),
        cancelView: vi.fn().mockResolvedValue(undefined),
      },
      { ...vault, records: vault.records.slice(0, 2) },
    );
    try {
      fireEvent.click(
        screen.getAllByRole("button", { name: /^Shared with me/ })[0],
      );
      await waitFor(() =>
        expect(identity).toHaveBeenCalledExactlyOnceWith("s1"),
      );
      fireEvent.click(screen.getByText(humanText("FAKE Referral letter.pdf")));
      await userEvent.click(screen.getByRole("button", { name: "Read" }));
      const reader = await screen.findByRole("dialog", {
        name: "FAKE Referral letter.pdf",
      });
      await within(reader).findByRole("img");
      expect(bridge.viewPage).toHaveBeenCalledWith(
        "s1",
        0,
        expect.any(Number),
        undefined,
      );
      await complete();
      expect(identity).toHaveBeenCalledExactlyOnceWith("s1");
      await userEvent.click(
        within(reader).getByRole("button", { name: "Close" }),
      );
      await screen.findByRole("group", {
        name: humanText("Suggested person for FAKE Pharmacy receipt.pdf"),
      });
      expect(identity.mock.calls).toEqual([["s1"], ["s2"]]);
      expect(bridge.moveToPerson).not.toHaveBeenCalled();
    } finally {
      await complete();
    }
  });

  it("hides a suggestion after Not this person, in the list and the details", async () => {
    renderLibrary({
      sharedIdentity: async (id: string) =>
        id === "s1" ? { name: "FAKE Jamie Example" } : null,
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Referral letter.pdf"),
      }),
    );
    const details = screen.getByRole("dialog", {
      name: "FAKE Referral letter.pdf",
    });
    await userEvent.click(
      await within(details).findByRole("button", {
        name: humanText("Not this person: FAKE Referral letter.pdf"),
      }),
    );
    expect(
      within(details).queryByRole("group", { name: /^Suggested person/ }),
    ).toBeNull();
    await userEvent.click(
      within(details).getByRole("button", { name: "Close document details" }),
    );
    expect(
      screen.queryByRole("group", { name: /^Suggested person/ }),
    ).toBeNull();
  });

  it("offers no action in recovery mode", async () => {
    const identity = vi.fn().mockResolvedValue({ name: "FAKE Jamie Example" });
    const { bridge } = renderLibrary(
      { sharedIdentity: identity },
      { ...vault, recovery: "lostObjects" },
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    expect(identity).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("group", { name: /Suggested person/ }),
    ).toBeNull();
    expect(bridge.moveToPerson).not.toHaveBeenCalled();
  });
  it("does not show a hint in the grid, but does in document details", async () => {
    renderLibrary({
      sharedIdentity: async (id) =>
        id === "s1" ? { name: "FAKE Jamie Example" } : null,
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Shared with me/ })[0],
    );
    await screen.findByRole("group", {
      name: humanText("Suggested person for FAKE Referral letter.pdf"),
    });
    fireEvent.click(screen.getByRole("button", { name: "Grid view" }));
    expect(
      screen.queryByRole("group", { name: /Suggested person/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText(/^FAKE Referral letter\.pdf /),
      }),
    );
    expect(
      within(
        screen.getByRole("dialog", { name: "FAKE Referral letter.pdf" }),
      ).getByRole("group", { name: /Suggested person/ }),
    ).toBeInTheDocument();
  });
  it("keeps profile instructions, creation, and saved people readable at wide and narrow widths", () => {
    renderLibrary({ updateProfileDetails: vi.fn() });
    fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]);
    const form = screen
      .getByRole("textbox", { name: "New profile name" })
      .closest("form")!;
    const section = form.parentElement!;
    const intro = section.firstElementChild!;
    const list = section.querySelector(".native-person-details-list")!;
    const overlaps = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    try {
      for (const fontSize of ["16px", "24px", "32px"]) {
        document.documentElement.style.fontSize = fontSize;
        for (const width of [760, 320]) {
          section.style.width = `${width}px`;
          section.style.maxWidth = "100%";
          const bounds = section.getBoundingClientRect();
          const boxes = [intro, form, list].map((element) =>
            element.getBoundingClientRect(),
          );
          expect(boxes[0].width).toBeGreaterThanOrEqual(
            Math.min(220, bounds.width - 4),
          );
          for (const box of boxes) {
            expect(box.left).toBeGreaterThanOrEqual(bounds.left - 1);
            expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
          }
          expect(overlaps(boxes[0], boxes[1])).toBe(false);
          expect(overlaps(boxes[0], boxes[2])).toBe(false);
          expect(overlaps(boxes[1], boxes[2])).toBe(false);
          expect(section.scrollWidth).toBeLessThanOrEqual(
            section.clientWidth + 1,
          );
          const unknown = section.querySelector<HTMLInputElement>(
            'input[type="checkbox"]',
          )!;
          const choice = unknown.closest("label")!.getBoundingClientRect();
          const control = unknown.getBoundingClientRect();
          expect(choice.height).toBeGreaterThanOrEqual(44);
          expect(control.left).toBeGreaterThanOrEqual(choice.left);
          expect(control.right).toBeLessThanOrEqual(choice.right);
          expect(control.right).toBeLessThanOrEqual(bounds.right);
        }
      }
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });

  it("keeps the unknown birth-date choice inside an enlarged edit form and toggles it by keyboard", async () => {
    renderLibrary({ updateProfileDetails: vi.fn() });
    fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]);
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Mom"),
      }),
    );
    const form = screen.getByRole("form", {
      name: humanText("Details for FAKE Mom"),
    });
    const unknown = within(form).getByRole("checkbox", {
      name: "I don't know this person's date of birth",
    });
    try {
      for (const fontSize of ["16px", "24px", "32px"]) {
        document.documentElement.style.fontSize = fontSize;
        for (const width of [760, 320]) {
          form.style.width = `${width}px`;
          form.style.maxWidth = "100%";
          const bounds = form.getBoundingClientRect();
          const choice = unknown.closest("label")!.getBoundingClientRect();
          const control = unknown.getBoundingClientRect();
          expect(choice.height).toBeGreaterThanOrEqual(44);
          expect(control.left).toBeGreaterThanOrEqual(bounds.left);
          expect(control.right).toBeLessThanOrEqual(bounds.right);
          expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth + 1);
        }
      }
      expect(unknown).toBeChecked();
      unknown.focus();
      await userEvent.keyboard(" ");
      expect(unknown).not.toBeChecked();
      expect(within(form).getByLabelText("Date of birth")).toBeEnabled();
      await userEvent.keyboard(" ");
      expect(unknown).toBeChecked();
      expect(within(form).getByLabelText("Date of birth")).toBeDisabled();
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });

  it("keeps the encrypted backup action inside its row with enlarged text and a wide fallback font", () => {
    renderLibrary({ updateProfileDetails: vi.fn() });
    fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]);
    const button = screen.getByRole("button", {
      name: "Save encrypted backup…",
    });
    const section = button.closest<HTMLElement>(".setting-row")!;
    section.style.fontFamily = "'DejaVu Sans', Verdana, sans-serif";
    try {
      for (const fontSize of ["16px", "24px", "32px"]) {
        document.documentElement.style.fontSize = fontSize;
        for (const width of [760, 320]) {
          section.style.width = `${width}px`;
          section.style.maxWidth = "100%";
          const row = section.getBoundingClientRect();
          const action = button.getBoundingClientRect();
          expect(action.left).toBeGreaterThanOrEqual(row.left - 1);
          expect(action.right).toBeLessThanOrEqual(row.right + 1);
          expect(button.scrollWidth).toBeLessThanOrEqual(
            button.clientWidth + 1,
          );
          expect(button.scrollHeight).toBeLessThanOrEqual(
            button.clientHeight + 1,
          );
          expect(section.scrollWidth).toBeLessThanOrEqual(
            section.clientWidth + 1,
          );
        }
      }
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });

  it("creates a profile with its required identity details in one native call", async () => {
    const createProfile = vi.fn().mockResolvedValue("p9");
    const updateProfileDetails = vi.fn().mockResolvedValue(undefined);
    renderLibrary({ createProfile, updateProfileDetails });
    fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]);
    fireEvent.change(
      screen.getByRole("textbox", { name: "New profile name" }),
      { target: { value: "FAKE Riley" } },
    );
    fireEvent.change(
      screen.getByLabelText("Full name, as on clinic documents"),
      { target: { value: " FAKE Riley Example " } },
    );
    fireEvent.change(screen.getByLabelText("Date of birth"), {
      target: { value: "2012-06-02" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    await vi.waitFor(() =>
      expect(createProfile).toHaveBeenCalledWith("FAKE Riley", {
        fullName: "FAKE Riley Example",
        birthDate: "2012-06-02",
      }),
    );
    expect(updateProfileDetails).not.toHaveBeenCalled();
  });

  it("requires an explicit unknown birth date and omits a previously entered date from creation", async () => {
    const createProfile = vi.fn().mockResolvedValue("p9");
    const updateProfileDetails = vi.fn();
    renderLibrary({ createProfile, updateProfileDetails });
    fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]);
    const add = screen.getByRole("button", { name: "Add profile" });
    fireEvent.change(screen.getByLabelText("New profile name"), {
      target: { value: "FAKE Riley" },
    });
    expect(add).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText("Full name, as on clinic documents"),
      { target: { value: " FAKE Riley Example " } },
    );
    expect(add).toBeDisabled();
    const date = screen.getByLabelText("Date of birth");
    fireEvent.change(date, { target: { value: "2012-06-02" } });
    const unknown = screen.getByRole("checkbox", {
      name: "I don't know this person's date of birth",
    });
    fireEvent.click(unknown);
    expect(date).toHaveValue("");
    expect(date).toBeDisabled();
    fireEvent.click(unknown);
    expect(add).toBeDisabled();
    expect(createProfile).not.toHaveBeenCalled();
    fireEvent.click(unknown);
    fireEvent.click(add);
    await vi.waitFor(() =>
      expect(createProfile).toHaveBeenCalledExactlyOnceWith("FAKE Riley", {
        fullName: "FAKE Riley Example",
      }),
    );
    expect(updateProfileDetails).not.toHaveBeenCalled();
  });
});
