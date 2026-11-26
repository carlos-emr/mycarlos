import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import { visibleText } from "../test/humanText";
import { RecoveryKeySetup } from "./RecoveryKeySetup";

// The ways out of a recovery key setup: before a key was made, after one is on screen, from the
// check step, and a step back. A key that is on screen and then left is a key that will never
// open the vault, so what is told to the rest of the app (and whether the vault locks) matters.
// FAKE data only.

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";
const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

function setUp(props: Partial<Parameters<typeof RecoveryKeySetup>[0]> = {}) {
  setLocaleOverride("en");
  const bridge = {
    beginRecoveryKey: vi.fn().mockResolvedValue(KEY),
    confirmRecoveryKey: vi.fn(),
    saveRecoveryKit: vi.fn().mockResolvedValue(true),
    recoveryKeyLabel: vi.fn().mockResolvedValue("7F3A"),
    cancelRecoveryKey: vi.fn().mockResolvedValue(undefined),
  };
  const handlers = {
    onDone: vi.fn(),
    onClose: vi.fn(),
    onLocked: vi.fn(),
    onLockAndLeave: vi.fn(),
  };
  render(
    <RecoveryKeySetup
      bridge={bridge}
      replacing={false}
      canPrint={false}
      {...handlers}
      {...props}
    />,
  );
  return { bridge, ...handlers };
}

describe("leaving a recovery key setup", () => {
  it("a required setup left before any key was made discards it and locks the vault, with no question", async () => {
    const user = userEvent.setup();
    const { bridge, onLockAndLeave, onClose } = setUp({ required: true });
    expect(
      screen.getByRole("heading", { name: "Set up a recovery key" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: en("recoveryKey.leave.required") }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(onLockAndLeave).toHaveBeenCalledOnce();
    // It is not a normal close: nothing is said to have been shown.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("an optional setup left before a key was made just closes, and says no key was shown", async () => {
    const user = userEvent.setup();
    const { bridge, onClose, onLockAndLeave } = setUp({ required: false });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(onLockAndLeave).not.toHaveBeenCalled();
  });

  it("an optional setup left with the key on screen closes and says a key was shown", async () => {
    const user = userEvent.setup();
    const { onClose, onLockAndLeave } = setUp({
      initialKey: KEY,
      required: false,
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    expect(onLockAndLeave).not.toHaveBeenCalled();
  });

  it("a required setup with the key on screen asks first: Cancel keeps the key and focus goes back to where it was, Leave discards and locks", async () => {
    const user = userEvent.setup();
    const { bridge, onLockAndLeave, onClose } = setUp({
      initialKey: KEY,
      required: true,
    });
    const leave = screen.getByRole("button", {
      name: en("recoveryKey.leave.required"),
    });
    leave.focus();
    await user.click(leave);
    const ask = await screen.findByRole("alertdialog");
    // Nothing is discarded by asking.
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(leave).toHaveFocus();
    expect(onLockAndLeave).not.toHaveBeenCalled();
    // Leaving after all.
    await user.click(leave);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: en("recoveryKey.discard.confirm"),
      }),
    );
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(onLockAndLeave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("from the check step Back returns to the key, still showing every group, with the check's message cleared", async () => {
    const user = userEvent.setup();
    setUp({ initialKey: KEY });
    await user.click(
      screen.getByRole("button", { name: "Next: check your recovery key" }),
    );
    const field = await screen.findByLabelText("Your recovery key");
    await user.type(field, "ABCD");
    await user.click(
      screen.getByRole("button", { name: en("recoveryKey.back") }),
    );
    expect(
      screen.getByRole("heading", { name: "Your recovery key" }),
    ).toBeVisible();
    const groups = within(
      screen.getByRole("list", { name: "Recovery key" }),
    ).getAllByRole("listitem");
    expect(groups).toHaveLength(7);
    expect(screen.queryByRole("alert")).toBeNull();
    // Going forward again starts the check from an empty field is not promised; the key is.
    await user.click(
      screen.getByRole("button", { name: "Next: check your recovery key" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Check your recovery key" }),
    ).toBeVisible();
  });

  it("from the check step, Cancel in a required setup asks the same question as on the key step", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp({ initialKey: KEY, required: true });
    await user.click(
      screen.getByRole("button", { name: "Next: check your recovery key" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: en("recoveryKey.leave.required"),
      }),
    );
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
  });
});
