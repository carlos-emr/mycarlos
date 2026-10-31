import { humanText } from "../test/humanText";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RestorePreview } from "../vault";
import { RestoreBackup } from "./RestoreBackup";
import { setLocaleOverride, translate } from "../i18n";

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

  it.each(["success", "refusal"] as const)(
    "ignores an old inspection %s after the credential is edited and accepts a fresh check",
    async (outcome) => {
      let finishInspect!: (preview: RestorePreview) => void;
      let refuseInspect!: (failure: unknown) => void;
      const pendingInspection = new Promise<RestorePreview>(
        (resolve, reject) => {
          finishInspect = resolve;
          refuseInspect = reject;
        },
      );
      const found: RestorePreview = {
        replaces: "nothing",
        differsFromThisDevice: false,
        documentCount: 27,
      };
      const { bridge, onRestored } = setUp(
        {},
        {
          inspectRestore: vi.fn().mockReturnValue(pendingInspection),
        },
      );
      const user = userEvent.setup();
      const originalSecret = "FAKE original backup secret";
      const revisedSecret = "FAKE corrected backup secret";
      try {
        await chooseAndCheck(user, originalSecret);
        expect(bridge.inspectRestore).toHaveBeenCalledExactlyOnceWith(
          "pick-1",
          {
            passphrase: originalSecret,
          },
        );
        const field = screen.getByLabelText(humanText("Backup passphrase"));
        await user.clear(field);
        await user.type(field, revisedSecret);
        await act(async () => {
          if (outcome === "success") finishInspect(found);
          else
            refuseInspect({
              code: "corrupt",
              message: "FAKE old inspection refused.",
            });
        });
        expect(field).toHaveValue(revisedSecret);
        expect(
          screen.queryByRole("button", { name: humanText("Restore backup") }),
        ).toBeNull();
        expect(screen.getByRole("status")).toBeEmptyDOMElement();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(bridge.restore).not.toHaveBeenCalled();
        expect(onRestored).not.toHaveBeenCalled();
        bridge.inspectRestore.mockResolvedValueOnce({
          ...found,
          documentCount: 2,
        });
        await user.click(
          screen.getByRole("button", { name: humanText("Check backup") }),
        );
        expect(bridge.inspectRestore).toHaveBeenCalledTimes(2);
        expect(bridge.inspectRestore).toHaveBeenLastCalledWith("pick-1", {
          passphrase: revisedSecret,
        });
        expect(
          await screen.findByRole("button", {
            name: humanText("Restore backup"),
          }),
        ).toBeEnabled();
        expect(bridge.restore).not.toHaveBeenCalled();
        expect(onRestored).not.toHaveBeenCalled();
      } finally {
        await act(async () => finishInspect(found));
      }
    },
  );

  it.each(["method switch", "hiding then returning"] as const)(
    "does not revive a preview after %s while inspection waits",
    async (change) => {
      let finishInspect!: (preview: RestorePreview) => void;
      const pendingInspection = new Promise<RestorePreview>((resolve) => {
        finishInspect = resolve;
      });
      const found: RestorePreview = {
        replaces: "nothing",
        differsFromThisDevice: false,
        documentCount: 27,
      };
      const { bridge, onRestored } = setUp(
        {},
        {
          inspectRestore: vi.fn().mockReturnValue(pendingInspection),
        },
      );
      const visibility =
        change === "hiding then returning"
          ? vi
              .spyOn(document, "visibilityState", "get")
              .mockReturnValue("visible")
          : null;
      const user = userEvent.setup();
      try {
        await chooseAndCheck(user);
        expect(bridge.inspectRestore).toHaveBeenCalledOnce();
        if (change === "method switch") {
          await user.click(
            screen.getByLabelText(humanText("Its recovery key")),
          );
          expect(
            screen.getByLabelText(humanText("Its recovery key")),
          ).toBeChecked();
        } else {
          visibility!.mockReturnValue("hidden");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
          visibility!.mockReturnValue("visible");
          await act(async () => {
            document.dispatchEvent(new Event("visibilitychange"));
          });
        }
        const field = screen.getByLabelText(
          humanText(
            change === "method switch" ? "Recovery key" : "Backup passphrase",
          ),
        );
        expect(field).toHaveValue("");
        await act(async () => finishInspect(found));
        expect(
          screen.queryByRole("button", { name: humanText("Restore backup") }),
        ).toBeNull();
        expect(screen.getByRole("status")).toBeEmptyDOMElement();
        expect(bridge.restore).not.toHaveBeenCalled();
        expect(onRestored).not.toHaveBeenCalled();
        const freshSecret =
          change === "method switch"
            ? "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345"
            : "FAKE fresh backup passphrase";
        await user.type(field, freshSecret);
        bridge.inspectRestore.mockResolvedValueOnce({
          ...found,
          documentCount: 2,
        });
        await user.click(
          screen.getByRole("button", { name: humanText("Check backup") }),
        );
        expect(bridge.inspectRestore).toHaveBeenCalledTimes(2);
        expect(bridge.inspectRestore).toHaveBeenLastCalledWith(
          "pick-1",
          change === "method switch"
            ? { recoveryKey: freshSecret }
            : { passphrase: freshSecret },
        );
        expect(
          await screen.findByRole("button", {
            name: humanText("Restore backup"),
          }),
        ).toBeEnabled();
        expect(bridge.restore).not.toHaveBeenCalled();
        expect(onRestored).not.toHaveBeenCalled();
      } finally {
        await act(async () => finishInspect(found));
        visibility?.mockRestore();
      }
    },
  );

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

  it("keeps the original unattended-clear deadline when the checked backup changes language", async () => {
    vi.useFakeTimers();
    try {
      setLocaleOverride("en");
      const { bridge, onRestored } = setUp({ replaces: "otherVault" });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: humanText("Choose backup file…"),
          }),
        );
      });
      const field = screen.getByLabelText(humanText("Backup passphrase"));
      const secret = "FAKE restore draft { $name }";
      fireEvent.change(field, { target: { value: secret } });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: humanText("Check backup") }),
        );
      });
      const agreement = screen.getByRole("checkbox");
      fireEvent.click(agreement);
      fireEvent.click(
        screen.getByRole("button", { name: humanText("Show passphrase") }),
      );
      expect(field).toHaveAttribute("type", "text");

      act(() => vi.advanceTimersByTime(4 * 60 * 1000));
      act(() => setLocaleOverride("pl"));
      expect(
        screen.getByLabelText(translate("pl", "restore.passphrase.label")),
      ).toBe(field);
      expect(field).toHaveValue(secret);
      expect(agreement).toBeChecked();
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        translate("pl", "restore.checked", {
          count: 2,
          consequence: translate("pl", "restore.consequence.otherVault"),
        }),
      );
      expect(
        screen.getByRole("button", { name: translate("pl", "restore.submit") }),
      ).toBeEnabled();

      act(() => vi.advanceTimersByTime(59_999));
      act(() => setLocaleOverride("fr"));
      expect(field).toHaveValue(secret);
      expect(agreement).toBeChecked();
      act(() => vi.advanceTimersByTime(1));
      expect(field).toHaveValue("");
      expect(field).toHaveAttribute("type", "password");
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: translate("fr", "restore.submit"),
        }),
      ).toBeNull();
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      expect(bridge.pickRestoreSource).toHaveBeenCalledTimes(1);
      expect(bridge.inspectRestore).toHaveBeenCalledExactlyOnceWith("pick-1", {
        passphrase: secret,
      });
      expect(bridge.restore).not.toHaveBeenCalled();
      expect(onRestored).not.toHaveBeenCalled();
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
