import { humanText } from "../test/humanText";
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
  await user.click(
    screen.getByRole("button", { name: humanText("Choose backup file…") }),
  );
  await user.type(
    await screen.findByLabelText(humanText("Backup passphrase")),
    secret,
  );
  await user.click(
    screen.getByRole("button", { name: humanText("Check backup") }),
  );
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
    expect(status).toHaveHumanTextContent(
      "The backup holds 2 documents. Restoring puts this vault on this device.",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    );
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
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    await user.click(
      await screen.findByLabelText(humanText("Its recovery key")),
    );
    await user.type(
      screen.getByLabelText(humanText("Recovery key")),
      "ABCD-EFGH",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Check backup") }),
    );
    expect(bridge.inspectRestore).toHaveBeenCalledWith("pick-1", {
      recoveryKey: "ABCD-EFGH",
    });
  });

  it.each([
    [
      { replaces: "otherVault" as const },
      /sets it aside.*stays on this device, encrypted/,
      "Set the vault on this device aside and restore the backup",
    ],
    [
      // A vault whose header cannot be read: it may be the backup's or not.
      { replaces: "unreadable" as const },
      /could not be read, so myCarlos cannot tell.*sets it aside/,
      "Set the vault on this device aside and restore the backup",
    ],
    [
      // A changed passphrase or recovery key, with the documents as they were.
      { replaces: "sameVault" as const, differsFromThisDevice: true },
      /may not be the same as this backup.*could not be read.*passphrase and recovery key/,
      "Set the vault on this device aside, with what changed since, and restore this backup",
    ],
  ])(
    "asks for agreement before losing anything (%o)",
    async (preview, warning, agreement) => {
      const user = userEvent.setup();
      const { bridge } = setUp(preview);
      await chooseAndCheck(user);
      expect(screen.getByRole("status")).toHaveHumanTextContent(warning);
      const restore = screen.getByRole("button", {
        name: humanText("Restore backup"),
      });
      expect(restore).toBeDisabled();
      await user.click(screen.getByLabelText(humanText(agreement)));
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
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "The vault on this device holds the same documents. Restoring sets it aside and puts this backup in its place. The vault set aside stays on this device, encrypted, but myCarlos cannot open it again for you yet.",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    );
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
    await user.click(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    );
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "Restore cancelled. Nothing changed.",
    );
    // The backup is still chosen, for another try.
    expect(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    ).toBeEnabled();
  });

  it("clears the old value and resets reveal when the credential method changes", async () => {
    const user = userEvent.setup();
    const { bridge, onRestored } = setUp();
    await user.click(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    const passphrase = await screen.findByLabelText(
      humanText("Backup passphrase"),
    );
    await user.type(passphrase, "FAKE old passphrase");
    await user.click(
      screen.getByRole("button", { name: humanText("Show passphrase") }),
    );
    expect(passphrase).toHaveAttribute("type", "text");
    expect(passphrase).toHaveValue("FAKE old passphrase");

    await user.click(screen.getByLabelText(humanText("Its recovery key")));
    const recovery = screen.getByLabelText(humanText("Recovery key"));
    expect(recovery).toHaveValue("");
    expect(recovery).toHaveAttribute("type", "password");
    const showKey = screen.getByRole("button", {
      name: humanText("Show recovery key"),
    });
    expect(showKey).toHaveAttribute("aria-pressed", "false");
    await user.type(recovery, "FAKE replacement key");
    expect(recovery).toHaveAttribute("type", "password");
    await user.click(showKey);
    expect(recovery).toHaveAttribute("type", "text");
    expect(recovery).toHaveValue("FAKE replacement key");

    await user.click(screen.getByLabelText(humanText("Its passphrase")));
    const again = screen.getByLabelText(humanText("Backup passphrase"));
    expect(again).toHaveValue("");
    expect(again).toHaveAttribute("type", "password");
    expect(
      screen.getByRole("button", { name: humanText("Show passphrase") }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(bridge.pickRestoreSource).toHaveBeenCalledOnce();
    expect(bridge.inspectRestore).not.toHaveBeenCalled();
    expect(bridge.restore).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("hides the secret as typed and forgets a preview when it changes", async () => {
    const user = userEvent.setup();
    setUp();
    await chooseAndCheck(user);
    expect(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    ).toBeVisible();
    const field = screen.getByLabelText(humanText("Backup passphrase"));
    expect(field).toHaveAttribute("type", "password");
    await user.click(
      screen.getByRole("button", { name: humanText("Show passphrase") }),
    );
    expect(field).toHaveAttribute("type", "text");

    // The preview was for what was typed before.
    await user.type(field, "x");
    expect(
      screen.queryByRole("button", { name: humanText("Restore backup") }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("starts again after a restore, with nothing left to press twice", async () => {
    const user = userEvent.setup();
    const { bridge, onRestored } = setUp();
    await chooseAndCheck(user);
    await user.click(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    );
    expect(onRestored).toHaveBeenCalledOnce();
    expect(bridge.restore).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: humanText("Restore backup") }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText(humanText("Backup passphrase")),
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
    await user.click(
      screen.getByRole("button", { name: humanText("Show passphrase") }),
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Restore backup") }),
    );
    expect(
      await screen.findByText(humanText("FAKE the backup changed.")),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    ).toHaveFocus();
    // The next secret is hidden as typed.
    await user.click(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    expect(
      await screen.findByLabelText(humanText("Backup passphrase")),
    ).toHaveAttribute("type", "password");
  });

  it("clears a secret left unattended", async () => {
    vi.useFakeTimers();
    try {
      setUp();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose backup file…"),
          }),
        );
      });
      const field = screen.getByLabelText(humanText("Backup passphrase"));
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
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "FAKE wrong passphrase.",
    );
    expect(
      screen.queryByRole("button", { name: humanText("Restore backup") }),
    ).not.toBeInTheDocument();
  });

  it("asks for nothing more when no backup was chosen", async () => {
    const user = userEvent.setup();
    setUp({}, { pickRestoreSource: vi.fn().mockResolvedValue(null) });
    await user.click(
      screen.getByRole("button", { name: humanText("Choose backup file…") }),
    );
    expect(
      screen.queryByLabelText(humanText("Backup passphrase")),
    ).not.toBeInTheDocument();
  });
});
