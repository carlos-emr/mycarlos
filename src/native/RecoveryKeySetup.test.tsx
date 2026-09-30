import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { VaultSnapshot } from "../vault";
import { RecoveryKeySetup } from "./RecoveryKeySetup";

const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345";
const GROUPS = KEY.split("-");
const snapshot: VaultSnapshot = {
  profiles: [],
  folders: [],
  records: [],
  recovery: null,
  recoveryKeySetAtMs: 5,
};
const typo = {
  code: "recovery_key_typo",
  message: "FAKE that doesn't match.",
};

function setUp(
  props: Partial<Parameters<typeof RecoveryKeySetup>[0]> = {},
  bridgeOverrides: Partial<
    Parameters<typeof RecoveryKeySetup>[0]["bridge"]
  > = {},
) {
  const bridge = {
    beginRecoveryKey: vi.fn().mockResolvedValue(KEY),
    confirmRecoveryKey: vi.fn().mockResolvedValue(snapshot),
    saveRecoveryKit: vi.fn().mockResolvedValue(true),
    recoveryKeyLabel: vi.fn().mockResolvedValue("7F3A"),
    cancelRecoveryKey: vi.fn().mockResolvedValue(undefined),
    ...bridgeOverrides,
  };
  const onDone = vi.fn();
  const onClose = vi.fn();
  const onLocked = vi.fn();
  render(
    <RecoveryKeySetup
      bridge={bridge}
      replacing={false}
      canPrint={false}
      onDone={onDone}
      onClose={onClose}
      onLocked={onLocked}
      {...props}
    />,
  );
  return { bridge, onDone, onClose, onLocked };
}

/** Types the whole key back in the check step. */
async function typeKey(user: ReturnType<typeof userEvent.setup>, key: string) {
  const field = screen.getByLabelText("Your recovery key");
  await user.clear(field);
  await user.type(field, key);
}

describe("RecoveryKeySetup", () => {
  it("asks for the passphrase, then shows the key a group at a time", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp();
    expect(
      screen.getByRole("heading", { name: "Set up a recovery key" }),
    ).toBeVisible();
    await user.type(
      screen.getByLabelText("Passphrase"),
      "river-azimuth-cobalt-sparrow-934",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(bridge.beginRecoveryKey).toHaveBeenCalledWith(
      "river-azimuth-cobalt-sparrow-934",
    );
    const heading = await screen.findByRole("heading", {
      name: "Your recovery key",
    });
    // The step replaces the form that had focus; the reader starts here.
    expect(heading).toHaveFocus();
    const list = screen.getByRole("list", { name: "Recovery key" });
    const items = within(list).getAllByRole("listitem");
    expect(
      items.map(
        (item) => item.querySelector('[aria-hidden="true"]')?.textContent,
      ),
    ).toEqual(GROUPS);
    // Read a character at a time, so that 0 and O are not confused: the
    // group as shown is hidden from the reader, which gets this instead.
    expect(items[5].querySelector(".sr-only")).toHaveTextContent(
      "Group 6: Y Z 0 1",
    );
  });

  it("says why the passphrase was refused", async () => {
    const user = userEvent.setup();
    setUp(
      {},
      {
        beginRecoveryKey: vi.fn().mockRejectedValue({
          code: "wrong_passphrase",
          message: "FAKE wrong passphrase.",
        }),
      },
    );
    await user.type(screen.getByLabelText("Passphrase"), "not-the-passphrase");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "FAKE wrong passphrase.",
    );
  });

  it("saves the kit and says so", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp({ initialKey: KEY });
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    await user.click(screen.getByRole("button", { name: "Save kit…" }));
    expect(bridge.saveRecoveryKit).toHaveBeenCalledOnce();
    expect(status).toHaveTextContent(
      "Recovery kit saved. The key starts working once you finish the check.",
    );
  });

  it("shows the key's label with the key", async () => {
    const { bridge } = setUp({ initialKey: KEY });
    expect(await screen.findByText("7F3A")).toBeVisible();
    expect(bridge.recoveryKeyLabel).toHaveBeenCalledOnce();
  });

  it("shows the key without its label when the label cannot be had", async () => {
    setUp(
      { initialKey: KEY },
      { recoveryKeyLabel: vi.fn().mockRejectedValue({ code: "locked" }) },
    );
    expect(await screen.findByText(GROUPS[0])).toBeVisible();
    expect(screen.queryByText(/Key label/)).toBeNull();
  });

  it("offers Print only where the platform can print", () => {
    setUp({ initialKey: KEY });
    expect(
      screen.queryByRole("button", { name: "Print" }),
    ).not.toBeInTheDocument();
  });

  it("puts the kit in the page only while it prints", async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    onTestFinished(() => print.mockRestore());
    setUp({ initialKey: KEY, canPrint: true });
    expect(document.querySelector(".recovery-kit-print")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledOnce();
    expect(document.body).toHaveClass("printing-recovery-kit");
    const kit = document.querySelector("body > .recovery-kit-print");
    expect(kit).toHaveTextContent(KEY);
    // Its label and the date, so that kits can be told apart.
    expect(kit).toHaveTextContent(
      `Key label: 7F3A · Printed ${new Date().toLocaleDateString()}`,
    );
    // On screen it takes no part.
    expect(kit).not.toBeVisible();

    await act(async () => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(document.querySelector(".recovery-kit-print")).toBeNull();
    expect(document.body).not.toHaveClass("printing-recovery-kit");
  });

  it("offers a way out of a required setup once it cannot succeed", async () => {
    const user = userEvent.setup();
    const { bridge, onClose } = setUp(
      { initialKey: KEY, required: true },
      {
        confirmRecoveryKey: vi
          .fn()
          .mockRejectedValue({ code: "no_space", message: "FAKE disk full." }),
      },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen.queryByRole("button", { name: "Set up later" }),
    ).not.toBeInTheDocument();
    await typeKey(user, "ZZZZ".repeat(7));
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    await user.click(
      await screen.findByRole("button", { name: "Set up later" }),
    );
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stores the key only once the whole key is typed back", async () => {
    const user = userEvent.setup();
    const { bridge, onDone } = setUp({ initialKey: KEY });
    await user.click(screen.getByRole("button", { name: "Next" }));
    const field = screen.getByLabelText("Your recovery key");
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription(/7 groups of 4/);
    // Case, dashes and spaces do not matter.
    await typeKey(user, KEY.toLowerCase().replaceAll("-", " "));
    await user.click(screen.getByRole("button", { name: "Check and save" }));

    expect(bridge.confirmRecoveryKey).toHaveBeenCalledWith(
      GROUPS.map((group, index) => ({ index, value: group.toLowerCase() })),
    );
    expect(onDone).toHaveBeenCalledWith(snapshot);
  });

  it("reads other punctuation between groups as a separator", async () => {
    // Some phone keyboards turn a double space into ". ".
    const user = userEvent.setup();
    const { bridge } = setUp({ initialKey: KEY });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await typeKey(user, KEY.replaceAll("-", ". "));
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(bridge.confirmRecoveryKey).toHaveBeenCalledWith(
      GROUPS.map((group, index) => ({ index, value: group })),
    );
  });

  it("clears a typing error as the patient types again", async () => {
    const user = userEvent.setup();
    setUp({ initialKey: KEY });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await typeKey(user, GROUPS[0]);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("You typed 4");
    await user.type(screen.getByLabelText("Your recovery key"), "-");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says when what was typed is not the length of a key, and asks nothing", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp({ initialKey: KEY });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await typeKey(user, GROUPS.slice(0, 6).join("-"));
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You typed 24 letters and digits. Your recovery key has 28 letters and digits: 7 groups of 4.",
    );
    expect(bridge.confirmRecoveryKey).not.toHaveBeenCalled();
  });

  it("goes back to the key after three wrong answers", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp(
      { initialKey: KEY },
      { confirmRecoveryKey: vi.fn().mockRejectedValue(typo) },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await typeKey(user, "ZZZZ".repeat(7));
      await user.click(screen.getByRole("button", { name: "Check and save" }));
      if (attempt < 3)
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "FAKE that doesn't match.",
        );
    }
    expect(bridge.confirmRecoveryKey).toHaveBeenCalledTimes(3);
    expect(
      await screen.findByRole("heading", { name: "Your recovery key" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "did not match three times",
    );
  });

  it("does not count a failure other than a wrong answer as a try", async () => {
    const user = userEvent.setup();
    const { bridge } = setUp(
      { initialKey: KEY },
      {
        confirmRecoveryKey: vi
          .fn()
          .mockRejectedValue({ code: "storage", message: "FAKE disk full." }),
      },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await typeKey(user, "ZZZZ".repeat(7));
      await user.click(screen.getByRole("button", { name: "Check and save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "FAKE disk full.",
      );
    }
    expect(bridge.confirmRecoveryKey).toHaveBeenCalledTimes(3);
    expect(
      screen.getByRole("heading", { name: "Check your recovery key" }),
    ).toBeVisible();
  });

  it("cancelling forgets the key, and says that one was shown", async () => {
    const user = userEvent.setup();
    const { bridge, onClose } = setUp({ initialKey: KEY });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.cancelRecoveryKey).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cancelling before a key was made says that none was shown", async () => {
    const user = userEvent.setup();
    const { onClose } = setUp();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not end on a click outside once the key is on screen", async () => {
    const user = userEvent.setup();
    const { bridge, onClose } = setUp({ initialKey: KEY });
    await user.pointer({
      keys: "[MouseLeft]",
      target: document.querySelector(".dialog-backdrop")!,
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
  });

  it("hands a locked vault to the app", async () => {
    const user = userEvent.setup();
    const { onLocked } = setUp(
      { initialKey: KEY },
      {
        saveRecoveryKit: vi
          .fn()
          .mockRejectedValue({ code: "locked", message: "FAKE locked." }),
      },
    );
    await user.click(screen.getByRole("button", { name: "Save kit…" }));
    await vi.waitFor(() => expect(onLocked).toHaveBeenCalledOnce());
    expect(screen.queryByText("FAKE locked.")).not.toBeInTheDocument();
  });

  it("offers a way out of a required setup when the kit cannot be saved", async () => {
    const user = userEvent.setup();
    const { onClose } = setUp(
      { initialKey: KEY, required: true },
      {
        saveRecoveryKit: vi
          .fn()
          .mockRejectedValue({ code: "storage", message: "FAKE no disk." }),
      },
    );
    const save = screen.getByRole("button", { name: "Save kit…" });
    await user.click(save);
    expect(await screen.findByText("FAKE no disk.")).toBeVisible();
    // Focus is back where it was before the buttons were disabled.
    expect(save).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Set up later" }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("says so when printing is not possible", async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, "print").mockImplementation(() => {
      throw new Error("FAKE no printing");
    });
    onTestFinished(() => print.mockRestore());
    setUp({ initialKey: KEY, canPrint: true });
    await user.click(screen.getByRole("button", { name: "Print" }));
    expect(await screen.findByText(/Printing is not available/)).toBeVisible();
    expect(document.querySelector(".recovery-kit-print")).toBeNull();
    expect(document.body).not.toHaveClass("printing-recovery-kit");
  });

  it("has no way out when the key is required", async () => {
    const user = userEvent.setup();
    const { bridge, onClose } = setUp({ initialKey: KEY, required: true });
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Your recovery key" }),
    ).toBeVisible();
  });

  it("keeps the setup open when replacing was cancelled in the native confirmation", async () => {
    const user = userEvent.setup();
    const { bridge, onDone, onClose } = setUp(
      { initialKey: KEY, replacing: true },
      {
        confirmRecoveryKey: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot),
      },
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    await typeKey(user, KEY);
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(status).toHaveTextContent(
      "Your recovery key was not changed. Your current key still works.",
    );
    // Both ways on from here are on this step, and focus is on one.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Check and save" }),
    ).toHaveFocus();
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.cancelRecoveryKey).not.toHaveBeenCalled();
    // The key typed is still there, and agreeing the second time saves it.
    await user.click(screen.getByRole("button", { name: "Check and save" }));
    expect(onDone).toHaveBeenCalledWith(snapshot);
  });

  it("says when it replaces an existing key", () => {
    setUp({ replacing: true });
    expect(
      screen.getByRole("heading", { name: "Replace your recovery key" }),
    ).toBeVisible();
    expect(
      screen.getByText(/current recovery key stops working/),
    ).toBeVisible();
  });
});
