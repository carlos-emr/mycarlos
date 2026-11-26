import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
const GROUPS = KEY.split("-");
const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

function setUp(
  props: Partial<Parameters<typeof RecoveryKeySetup>[0]> = {},
  overrides: Record<string, unknown> = {},
) {
  setLocaleOverride("en");
  const bridge = {
    beginRecoveryKey: vi.fn().mockResolvedValue(KEY),
    confirmRecoveryKey: vi.fn(),
    saveRecoveryKit: vi.fn().mockResolvedValue(true),
    recoveryKeyLabel: vi.fn().mockResolvedValue("7F3A"),
    cancelRecoveryKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
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
    const { bridge, onClose, onLockAndLeave } = setUp({
      initialKey: KEY,
      required: false,
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
    // The key that was shown is thrown away on the native side too.
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(onLockAndLeave).not.toHaveBeenCalled();
  });

  it("still locks when throwing the key away fails, with the failure handled", async () => {
    const user = userEvent.setup();
    // The runner does not report unhandled rejections here, so watch for the handler itself:
    // `catch` is `then(undefined, handler)`, so a rejection handler is the second argument.
    let asked = 0;
    // The second argument of every `then` the caller made: a rejection handler, if it gave one.
    const rejectionHandlers: unknown[] = [];
    const { onLockAndLeave, onClose } = setUp(
      { initialKey: KEY, required: true },
      // Not a vi.fn: a mock attaches its own handlers to what it returns, which would hide the
      // caller's. The rejection is made here, with the spy on before it is returned, so the
      // caller's handler attaches in the same tick.
      {
        cancelRecoveryKey: () => {
          asked += 1;
          const failing = Promise.reject(new Error("FAKE failure"));
          const original = failing.then.bind(failing);
          failing.then = ((onFulfilled, onRejected) => {
            rejectionHandlers.push(onRejected);
            return original(onFulfilled, onRejected);
          }) as typeof failing.then;
          return failing;
        },
      },
    );
    await user.click(
      screen.getByRole("button", { name: en("recoveryKey.leave.required") }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: en("recoveryKey.discard.confirm"),
      }),
    );
    expect(asked).toBe(1);
    expect(onLockAndLeave).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    // The failure was handled by the caller, not left to surface as an unhandled rejection.
    expect(
      rejectionHandlers.some((handler) => typeof handler === "function"),
    ).toBe(true);
  });

  it("does nothing on Cancel or Escape while the kit is being saved, and works again after", async () => {
    const user = userEvent.setup();
    let finishSave: (saved: boolean) => void = () => {};
    const { bridge, onClose } = setUp(
      { initialKey: KEY, required: false },
      {
        saveRecoveryKit: vi.fn(
          () =>
            new Promise<boolean>((resolve) => {
              finishSave = resolve;
            }),
        ),
      },
    );
    await user.click(
      screen.getByRole("button", { name: en("recoveryKey.saveKit") }),
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    await act(async () => finishSave(true));
    await waitFor(() => expect(cancel).toBeEnabled());
    await user.click(cancel);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
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
    // Nothing is discarded by asking, but the key is off the screen while the question is up.
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Recovery key" })).toBeNull();
    for (const group of GROUPS) {
      for (const shown of screen.queryAllByText(group)) {
        expect(shown, group).not.toBeVisible();
      }
    }
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // ...and back, all of it, after Cancel.
    const back = within(
      screen.getByRole("list", { name: "Recovery key" }),
    ).getAllByRole("listitem");
    expect(back).toHaveLength(7);
    GROUPS.forEach((group, index) =>
      expect(back[index].textContent).toContain(group),
    );
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

  it("Escape on the question is Cancel: the key comes back, and a second Escape never discards it", async () => {
    const user = userEvent.setup();
    const { bridge, onLockAndLeave, onClose } = setUp({
      initialKey: KEY,
      required: true,
    });
    await user.click(
      screen.getByRole("button", { name: en("recoveryKey.leave.required") }),
    );
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const back = within(
      screen.getByRole("list", { name: "Recovery key" }),
    ).getAllByRole("listitem");
    expect(back).toHaveLength(7);
    GROUPS.forEach((group, index) =>
      expect(back[index].textContent).toContain(group),
    );
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    expect(onLockAndLeave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // A second Escape asks again; it does not discard.
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("alertdialog")).toBeVisible();
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    expect(onLockAndLeave).not.toHaveBeenCalled();
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
      screen.getByRole("button", { name: en("recoveryKey.checkAndSave") }),
    );
    // A key of the wrong length is refused on the spot, with a message.
    expect(await screen.findByRole("alert")).toBeVisible();
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
