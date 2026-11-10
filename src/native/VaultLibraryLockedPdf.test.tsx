import { humanText } from "../test/humanText";
import { useTextState } from "../i18n";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  vaultErrorMessage,
  type VaultBridge,
  type VaultRecord,
  type VaultSnapshot,
} from "../vault";
import { VaultLibrary } from "./VaultLibrary";

// One fake native runtime: stamp and clone when data is captured, before delivery.
let snapshotSequence = 1;
function captureSnapshot(snapshot: VaultSnapshot): VaultSnapshot {
  return {
    ...structuredClone(snapshot),
    capture: {
      epoch: "00000000-0000-4000-8000-000000000185",
      sequence: ++snapshotSequence,
    },
  };
}

const record = (id: string, displayName: string) =>
  ({
    id,
    profileId: "profile-1",
    folderIds: [],
    displayName,
    sourceLabel: "Manual import — unverified",
    mediaType: "application/octet-stream",
    plaintextSize: 2048,
    importedAtMs: Date.UTC(2026, 9, 20, 19, 5),
    available: true,
  }) satisfies VaultRecord;

const base: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [{ id: "profile-1", displayName: "FAKE Patient", createdAtMs: 1 }],
  folders: [],
  records: [record("locked-1", "FAKE Letter.pdf")],
  recovery: null,
};

// The library as VaultApp shows it: the snapshot a refresh returns is the one
// shown next.
function renderLibrary(
  bridgeOverrides: Partial<VaultBridge> = {},
  computer = true,
  initial = base,
) {
  let current = initial;
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    isPhoto: vi.fn(async () => false),
    isLockedPdf: vi.fn(async (id: string) => id === "locked-1"),
    unlockPdf: vi.fn(async () => {
      current = {
        ...current,
        records: [
          record("locked-1", "FAKE Letter (locked original).pdf"),
          record("copy-1", "FAKE Letter.pdf"),
        ],
      };
      return {
        recordId: "copy-1",
        originalName: "FAKE Letter (locked original).pdf",
      };
    }),
    isPdf: vi.fn(async () => true),
    viewPage: vi.fn(async () => ({
      pageCount: 1,
      width: 1,
      height: 1,
      image:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      text: "FAKE unlocked page",
    })),
    cancelView: vi.fn().mockResolvedValue(undefined),
    hideRecord: vi.fn(async (id: string) => {
      current = {
        ...current,
        records: current.records.map((r) =>
          r.id === id
            ? { ...r, hidden: { atMs: 5, reason: "patient" as const } }
            : r,
        ),
      };
    }),
    unhideRecord: vi.fn(async (id: string) => {
      current = {
        ...current,
        records: current.records.map((r) =>
          r.id === id ? { ...r, hidden: null } : r,
        ),
      };
    }),
    snapshot: vi.fn(async () => captureSnapshot(current)),
    ...bridgeOverrides,
  } as unknown as VaultBridge;
  function Harness() {
    const [snapshot, setSnapshot] = useState(initial);
    const [notice, setNotice] = useTextState();
    return (
      <VaultLibrary
        bridge={bridge}
        snapshot={snapshot}
        busy={false}
        notice={notice}
        setNotice={setNotice}
        // As VaultApp's: a failure is reported as the notice.
        run={async (operation) => {
          try {
            await operation();
          } catch (error) {
            setNotice(vaultErrorMessage(error));
          }
        }}
        refresh={async () => {
          setSnapshot(current);
          return current;
        }}
        onLock={vi.fn().mockResolvedValue(undefined)}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
        computer={computer}
      />
    );
  }
  render(<Harness />);
  return bridge;
}

const openDetails = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    screen.getByRole("button", {
      name: humanText("Details for FAKE Letter.pdf"),
    }),
  );
  return screen.getByRole("dialog", { name: humanText("FAKE Letter.pdf") });
};

describe("a PDF locked with a password (#54)", () => {
  it("keeps the current PDF unlock available when an earlier document check finishes", async () => {
    const user = userEvent.setup();
    let finishEarlier!: (locked: boolean) => void;
    const earlier = new Promise<boolean>((resolve) => {
      finishEarlier = resolve;
    });
    const bridge = renderLibrary(
      {
        isLockedPdf: vi.fn((id: string) =>
          id === "locked-1" ? earlier : Promise.resolve(true),
        ),
        unlockPdf: vi.fn().mockRejectedValue({ code: "pdf_wrong_password" }),
      },
      true,
      {
        ...base,
        records: [...base.records, record("locked-2", "FAKE Results.pdf")],
      },
    );
    try {
      const earlierDetails = await openDetails(user);
      expect(bridge.isLockedPdf).toHaveBeenCalledExactlyOnceWith("locked-1");
      expect(
        within(earlierDetails).queryByRole("button", {
          name: humanText("Unlock…"),
        }),
      ).toBeNull();
      await user.click(
        within(earlierDetails).getByRole("button", {
          name: humanText("Close document details"),
        }),
      );
      await user.click(
        screen.getByRole("button", {
          name: humanText("Details for FAKE Results.pdf"),
        }),
      );
      const currentDetails = screen.getByRole("dialog", {
        name: humanText("FAKE Results.pdf"),
      });
      const unlock = await within(currentDetails).findByRole("button", {
        name: humanText("Unlock…"),
      });
      expect(bridge.isLockedPdf).toHaveBeenNthCalledWith(2, "locked-2");

      // The older positive check must not replace the current document's
      // positive check, which would remove its already available Unlock action.
      await act(async () => finishEarlier(true));
      expect(unlock).toBeVisible();
      expect(unlock).toBeEnabled();
      await user.click(unlock);
      const prompt = screen.getByRole("dialog", {
        name: humanText("Unlock FAKE Results.pdf"),
      });
      await user.type(
        within(prompt).getByLabelText(humanText("Document password")),
        "FAKE-current-password{Enter}",
      );
      expect(await within(prompt).findByRole("alert")).toHaveHumanTextContent(
        "That password did not open the document.",
      );
      expect(bridge.unlockPdf).toHaveBeenCalledExactlyOnceWith(
        "locked-2",
        "FAKE-current-password",
      );
      expect(bridge.isLockedPdf).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => finishEarlier(true));
    }
  });

  it("is unlocked from its details: the copy takes its name, and the original is kept", async () => {
    const user = userEvent.setup();
    const wrong = Object.assign(new Error("wrong"), {
      code: "pdf_wrong_password",
      message:
        "That password did not open the document. Check the document password in your patient portal, then try again.",
    });
    const bridge = renderLibrary();
    vi.mocked(bridge.unlockPdf).mockRejectedValueOnce(wrong);
    const details = await openDetails(user);
    expect(bridge.isLockedPdf).toHaveBeenCalledWith("locked-1");
    expect(
      await within(details).findByText(
        humanText(
          "Locked with a password. Unlock adds a copy that opens without it, and keeps this one.",
        ),
      ),
    ).toBeVisible();
    await user.click(
      within(details).getByRole("button", { name: humanText("Unlock…") }),
    );

    const prompt = screen.getByRole("dialog", {
      name: humanText("Unlock FAKE Letter.pdf"),
    });
    await user.type(
      within(prompt).getByLabelText(humanText("Document password")),
      "FAKE-wrong{Enter}",
    );
    // A wrong password keeps the prompt open, and says so.
    expect(await within(prompt).findByRole("alert")).toHaveHumanTextContent(
      "That password did not open the document.",
    );
    await user.type(
      within(prompt).getByLabelText(humanText("Document password")),
      "FAKE-portal-2026{Enter}",
    );
    expect(bridge.unlockPdf).toHaveBeenLastCalledWith(
      "locked-1",
      "FAKE-portal-2026",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: humanText("Unlock FAKE Letter.pdf"),
        }),
      ).toBeNull(),
    );
    // The details now show the copy, which is not locked, and say where the
    // original is.
    const copy = await screen.findByRole("dialog", {
      name: humanText("FAKE Letter.pdf"),
    });
    expect(
      within(copy).getByText(
        humanText(
          "An unlocked copy was added. The locked original is now called FAKE Letter (locked original).pdf.",
        ),
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(bridge.isLockedPdf).toHaveBeenLastCalledWith("copy-1"),
    );
    expect(
      within(copy).queryByRole("button", { name: humanText("Unlock…") }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Letter (locked original).pdf"),
      }),
    ).toBeVisible();
  });

  it("hides and restores an unlocked copy, then reads it while keeping the locked original", async () => {
    const user = userEvent.setup();
    const bridge = renderLibrary();
    const details = await openDetails(user);
    await user.click(
      await within(details).findByRole("button", {
        name: humanText("Unlock…"),
      }),
    );
    const prompt = screen.getByRole("dialog", {
      name: humanText("Unlock FAKE Letter.pdf"),
    });
    await user.type(
      within(prompt).getByLabelText(humanText("Document password")),
      "FAKE-portal-2026{Enter}",
    );
    const copy = await screen.findByRole("dialog", {
      name: humanText("FAKE Letter.pdf"),
    });
    await user.click(
      within(copy).getByRole("button", { name: humanText("Hide") }),
    );
    await waitFor(() =>
      expect(bridge.hideRecord).toHaveBeenCalledExactlyOnceWith("copy-1"),
    );
    expect(
      screen.queryByRole("button", {
        name: humanText("Details for FAKE Letter.pdf"),
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Letter (locked original).pdf"),
      }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Security" }));
    await user.click(
      screen.getByRole("button", { name: humanText(/^Hidden/) }),
    );
    const hidden = screen.getByRole("article", {
      name: humanText("FAKE Letter.pdf, hidden"),
    });
    await user.click(
      within(hidden).getByRole("button", {
        name: humanText("Restore FAKE Letter.pdf"),
      }),
    );
    await waitFor(() =>
      expect(bridge.unhideRecord).toHaveBeenCalledExactlyOnceWith("copy-1"),
    );
    await user.click(
      within(
        screen.getByRole("navigation", { name: humanText("Record library") }),
      ).getByRole("button", { name: humanText(/^My records/) }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("FAKE Letter.pdf") }),
    );
    const restoredDetails = await screen.findByRole("dialog", {
      name: humanText("FAKE Letter.pdf"),
    });
    await user.click(
      within(restoredDetails).getByRole("button", { name: humanText("Read") }),
    );
    const reader = await screen.findByRole("dialog", {
      name: humanText("FAKE Letter.pdf"),
    });
    expect(
      await within(reader).findByRole("img", {
        name: humanText("Page 1 of 1. The page's text follows."),
      }),
    ).toBeVisible();
    expect(bridge.viewPage).toHaveBeenCalledWith(
      "copy-1",
      0,
      expect.any(Number),
      undefined,
    );
    await user.click(
      within(reader).getByRole("button", { name: humanText("Close") }),
    );
    await waitFor(() => expect(bridge.cancelView).toHaveBeenCalled());
    expect(
      screen.getByRole("button", {
        name: humanText("Details for FAKE Letter (locked original).pdf"),
      }),
    ).toBeVisible();
  });

  it("closes the prompt with Cancel and changes nothing", async () => {
    const user = userEvent.setup();
    const bridge = renderLibrary();
    const details = await openDetails(user);
    await user.click(
      await within(details).findByRole("button", {
        name: humanText("Unlock…"),
      }),
    );
    await user.click(screen.getByRole("button", { name: humanText("Cancel") }));
    expect(bridge.unlockPdf).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: humanText("FAKE Letter.pdf") }),
    ).toBeVisible();
  });

  it("says why when it cannot be unlocked, and keeps the document", async () => {
    const user = userEvent.setup();
    const bridge = renderLibrary({
      unlockPdf: vi.fn(async () => {
        throw Object.assign(new Error("failed"), {
          code: "pdf_unlock_failed",
          message:
            "myCarlos could not open this locked document. It may be damaged, or locked in a way myCarlos cannot open. The document is unchanged.",
        });
      }),
    });
    const details = await openDetails(user);
    await user.click(
      await within(details).findByRole("button", {
        name: humanText("Unlock…"),
      }),
    );
    await user.type(
      screen.getByLabelText(humanText("Document password")),
      "FAKE-portal-2026{Enter}",
    );
    const back = await screen.findByRole("dialog", {
      name: humanText("FAKE Letter.pdf"),
    });
    expect(
      await within(back).findByText(humanText(/The document is unchanged\.$/)),
    ).toBeVisible();
    expect(bridge.unlockPdf).toHaveBeenCalledTimes(1);
  });

  it("is only marked on a phone, which cannot open it yet", async () => {
    const user = userEvent.setup();
    renderLibrary({}, false);
    const details = await openDetails(user);
    expect(
      await within(details).findByText(
        humanText(
          "Locked with a password. myCarlos cannot open it on this device yet.",
        ),
      ),
    ).toBeVisible();
    expect(
      within(details).queryByRole("button", { name: humanText("Unlock…") }),
    ).toBeNull();
  });

  it("is not marked when the vault finds no password on it", async () => {
    const user = userEvent.setup();
    const bridge = renderLibrary({ isLockedPdf: vi.fn(async () => false) });
    const details = await openDetails(user);
    await waitFor(() => expect(bridge.isLockedPdf).toHaveBeenCalled());
    expect(
      within(details).queryByText(humanText(/Locked with a password/)),
    ).toBeNull();
    expect(
      within(details).queryByRole("button", { name: humanText("Unlock…") }),
    ).toBeNull();
  });
});
