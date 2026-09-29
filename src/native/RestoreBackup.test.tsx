import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RestorePreview } from "../vault";
import { RestoreBackup } from "./RestoreBackup";

function setUp(preview: Partial<RestorePreview> = {}, overrides = {}) {
  const bridge = {
    pickRestoreSource: vi.fn().mockResolvedValue("pick-1"),
    inspectRestore: vi.fn().mockResolvedValue({
      replaces: "nothing",
      differsFromThisDevice: false,
      olderThanThisDevice: false,
      documentCount: 2,
      ...preview,
    }),
    restore: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const onRestored = vi.fn();
  render(<RestoreBackup bridge={bridge} onRestored={onRestored} />);
  return { bridge, onRestored };
}

async function chooseAndCheck(
  user: ReturnType<typeof userEvent.setup>,
  secret = "river-azimuth-cobalt-sparrow-934",
) {
  await user.click(screen.getByRole("button", { name: "Choose backup file…" }));
  await user.type(await screen.findByLabelText("Backup passphrase"), secret);
  await user.click(screen.getByRole("button", { name: "Check backup" }));
}

describe("RestoreBackup", () => {
  it("opens the chosen backup, says what it replaces, then restores it", async () => {
    const user = userEvent.setup();
    const { bridge, onRestored } = setUp();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    await chooseAndCheck(user);

    expect(bridge.inspectRestore).toHaveBeenCalledWith("pick-1", {
      passphrase: "river-azimuth-cobalt-sparrow-934",
    });
    expect(status).toHaveTextContent(
      "The backup holds 2 documents. Restoring puts this vault on this device.",
    );
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(bridge.restore).toHaveBeenCalledWith(
      "pick-1",
      { passphrase: "river-azimuth-cobalt-sparrow-934" },
      false,
    );
    expect(onRestored).toHaveBeenCalledOnce();
  });

  it("opens a backup with its recovery key", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp();
    await user.click(
      screen.getByRole("button", { name: "Choose backup file…" }),
    );
    await user.click(await screen.findByLabelText("Its recovery key"));
    await user.type(screen.getByLabelText("Recovery key"), "ABCD-EFGH");
    await user.click(screen.getByRole("button", { name: "Check backup" }));
    expect(bridge.inspectRestore).toHaveBeenCalledWith("pick-1", {
      recoveryKey: "ABCD-EFGH",
    });
  });

  it.each([
    [
      { replaces: "otherVault" as const },
      /erases it, permanently/,
      "Erase the vault on this device and restore the backup",
    ],
    [
      {
        replaces: "sameVault" as const,
        differsFromThisDevice: true,
        olderThanThisDevice: true,
      },
      /is not the same as this backup/,
      "Replace the vault on this device with this backup and lose what changed since",
    ],
    [
      // A changed passphrase or recovery key, with the documents as they were.
      { replaces: "sameVault" as const, differsFromThisDevice: true },
      /is not the same as this backup.*passphrase and recovery key/,
      "Replace the vault on this device with this backup and lose what changed since",
    ],
  ])(
    "asks for agreement before losing anything (%o)",
    async (preview, warning, agreement) => {
      const user = userEvent.setup();
      const { bridge } = setUp(preview);
      await chooseAndCheck(user);
      expect(screen.getByRole("status")).toHaveTextContent(warning);
      const restore = screen.getByRole("button", { name: "Restore backup" });
      expect(restore).toBeDisabled();
      await user.click(screen.getByLabelText(agreement));
      await user.click(restore);
      expect(bridge.restore).toHaveBeenCalledWith(
        "pick-1",
        expect.anything(),
        true,
      );
    },
  );

  it("asks for no agreement when the vault holds what the backup holds", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp({ replaces: "sameVault" });
    await chooseAndCheck(user);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The vault on this device holds the same documents. Restoring replaces it with this backup.",
    );
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(bridge.restore).toHaveBeenCalledWith(
      "pick-1",
      expect.anything(),
      true,
    );
  });

  it("changes nothing when the native confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const { onRestored } = setUp(
      { replaces: "sameVault" },
      { restore: vi.fn().mockResolvedValue(false) },
    );
    await chooseAndCheck(user);
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Restore cancelled. Nothing changed.",
    );
    // The backup is still chosen, for another try.
    expect(
      screen.getByRole("button", { name: "Restore backup" }),
    ).toBeEnabled();
  });

  it("hides the secret as typed and forgets a preview when it changes", async () => {
    const user = userEvent.setup();
    setUp();
    await chooseAndCheck(user);
    expect(
      screen.getByRole("button", { name: "Restore backup" }),
    ).toBeVisible();
    const field = screen.getByLabelText("Backup passphrase");
    expect(field).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show passphrase" }));
    expect(field).toHaveAttribute("type", "text");

    // The preview was for what was typed before.
    await user.type(field, "x");
    expect(
      screen.queryByRole("button", { name: "Restore backup" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("starts again after a restore, with nothing left to press twice", async () => {
    const user = userEvent.setup();
    const { bridge, onRestored } = setUp();
    await chooseAndCheck(user);
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(onRestored).toHaveBeenCalledOnce();
    expect(bridge.restore).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Restore backup" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Backup passphrase"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("starts again from the file, with focus on it, when a restore fails", async () => {
    const user = userEvent.setup();
    setUp(
      {},
      {
        restore: vi.fn().mockRejectedValue({
          code: "backup_changed",
          message: "FAKE the backup changed.",
        }),
      },
    );
    await chooseAndCheck(user);
    await user.click(screen.getByRole("button", { name: "Show passphrase" }));
    await user.click(screen.getByRole("button", { name: "Restore backup" }));
    expect(await screen.findByText("FAKE the backup changed.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Choose backup file…" }),
    ).toHaveFocus();
    // The next secret is hidden as typed.
    await user.click(
      screen.getByRole("button", { name: "Choose backup file…" }),
    );
    expect(await screen.findByLabelText("Backup passphrase")).toHaveAttribute(
      "type",
      "password",
    );
  });

  it("clears a secret left unattended", async () => {
    vi.useFakeTimers();
    try {
      setUp();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Choose backup file…" }),
        );
      });
      const field = screen.getByLabelText("Backup passphrase");
      await act(async () => {
        fireEvent.change(field, { target: { value: "FAKE secret typed" } });
      });
      await act(async () => {
        vi.advanceTimersByTime(5 * 60 * 1000);
      });
      expect(field).toHaveValue("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why a backup did not open", async () => {
    const user = userEvent.setup();
    setUp(
      {},
      {
        inspectRestore: vi.fn().mockRejectedValue({
          code: "wrong_passphrase",
          message: "FAKE wrong passphrase.",
        }),
      },
    );
    await chooseAndCheck(user, "not-the-passphrase");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "FAKE wrong passphrase.",
    );
    expect(
      screen.queryByRole("button", { name: "Restore backup" }),
    ).not.toBeInTheDocument();
  });

  it("asks for nothing more when no backup was chosen", async () => {
    const user = userEvent.setup();
    setUp({}, { pickRestoreSource: vi.fn().mockResolvedValue(null) });
    await user.click(
      screen.getByRole("button", { name: "Choose backup file…" }),
    );
    expect(
      screen.queryByLabelText("Backup passphrase"),
    ).not.toBeInTheDocument();
  });
});
