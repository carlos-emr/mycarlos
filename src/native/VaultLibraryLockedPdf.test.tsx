import { render, screen, waitFor, within } from "@testing-library/react";
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

const record = (id: string, displayName: string) =>
  ({
    id,
    profileId: "profile-1",
    folderIds: [],
    displayName,
    sourceLabel: "Manual import — unverified",
    mediaType: "application/pdf",
    plaintextSize: 2048,
    importedAtMs: Date.UTC(2026, 9, 20, 19, 5),
    available: true,
  }) satisfies VaultRecord;

const base: VaultSnapshot = {
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
) {
  let current = base;
  const bridge = {
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
    snapshot: vi.fn(async () => current),
    ...bridgeOverrides,
  } as unknown as VaultBridge;
  function Harness() {
    const [snapshot, setSnapshot] = useState(base);
    const [notice, setNotice] = useState("");
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
    screen.getByRole("button", { name: "Details for FAKE Letter.pdf" }),
  );
  return screen.getByRole("dialog", { name: "FAKE Letter.pdf" });
};

describe("a PDF locked with a password (#54)", () => {
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
        "Locked with a password. Unlock adds a copy that opens without it, and keeps this one.",
      ),
    ).toBeVisible();
    await user.click(within(details).getByRole("button", { name: "Unlock…" }));

    const prompt = screen.getByRole("dialog", {
      name: "Unlock FAKE Letter.pdf",
    });
    await user.type(
      within(prompt).getByLabelText("Document password"),
      "FAKE-wrong{Enter}",
    );
    // A wrong password keeps the prompt open, and says so.
    expect(await within(prompt).findByRole("alert")).toHaveTextContent(
      "That password did not open the document.",
    );
    await user.type(
      within(prompt).getByLabelText("Document password"),
      "FAKE-portal-2026{Enter}",
    );
    expect(bridge.unlockPdf).toHaveBeenLastCalledWith(
      "locked-1",
      "FAKE-portal-2026",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Unlock FAKE Letter.pdf" }),
      ).toBeNull(),
    );
    // The details now show the copy, which is not locked, and say where the
    // original is.
    const copy = await screen.findByRole("dialog", { name: "FAKE Letter.pdf" });
    expect(
      within(copy).getByText(
        "FAKE Letter.pdf unlocked. The locked original is kept as FAKE Letter (locked original).pdf.",
      ),
    ).toBeVisible();
    await waitFor(() =>
      expect(bridge.isLockedPdf).toHaveBeenLastCalledWith("copy-1"),
    );
    expect(within(copy).queryByRole("button", { name: "Unlock…" })).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Details for FAKE Letter (locked original).pdf",
      }),
    ).toBeVisible();
  });

  it("closes the prompt with Cancel and changes nothing", async () => {
    const user = userEvent.setup();
    const bridge = renderLibrary();
    const details = await openDetails(user);
    await user.click(
      await within(details).findByRole("button", { name: "Unlock…" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.unlockPdf).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("dialog", { name: "FAKE Letter.pdf" }),
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
      await within(details).findByRole("button", { name: "Unlock…" }),
    );
    await user.type(
      screen.getByLabelText("Document password"),
      "FAKE-portal-2026{Enter}",
    );
    const back = await screen.findByRole("dialog", { name: "FAKE Letter.pdf" });
    expect(
      await within(back).findByText(/The document is unchanged\.$/),
    ).toBeVisible();
    expect(bridge.unlockPdf).toHaveBeenCalledTimes(1);
  });

  it("is only marked on a phone, which cannot open it yet", async () => {
    const user = userEvent.setup();
    renderLibrary({}, false);
    const details = await openDetails(user);
    expect(
      await within(details).findByText(
        "Locked with a password. myCarlos cannot open it on this device yet.",
      ),
    ).toBeVisible();
    expect(
      within(details).queryByRole("button", { name: "Unlock…" }),
    ).toBeNull();
  });

  it("is not marked when the vault finds no password on it", async () => {
    const user = userEvent.setup();
    const bridge = renderLibrary({ isLockedPdf: vi.fn(async () => false) });
    const details = await openDetails(user);
    await waitFor(() => expect(bridge.isLockedPdf).toHaveBeenCalled());
    expect(within(details).queryByText(/Locked with a password/)).toBeNull();
    expect(
      within(details).queryByRole("button", { name: "Unlock…" }),
    ).toBeNull();
  });
});
