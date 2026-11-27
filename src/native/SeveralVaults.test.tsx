import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import type { FoundVaults } from "../vault";
import { CreateVault, UnlockVault } from "./VaultAuth";

// Several vaults on one device (#357), the screens: "Use a different vault" on the unlock screen
// (a name field, never a list), "Find my other vaults" and the names it asks for, and the screen
// that sets up another vault. FAKE values only.

const PASS = "river-azimuth-cobalt-sparrow-934";
const restoreBridge = {
  pickRestoreSource: vi.fn().mockResolvedValue(null),
  inspectRestore: vi.fn(),
  restore: vi.fn(),
};

function unlockScreen(
  options: {
    found?: FoundVaults | null;
    named?: boolean;
    severalVaults?: boolean;
  } = {},
) {
  const onUnlock = vi.fn().mockResolvedValue(undefined);
  const onFind = vi
    .fn()
    .mockResolvedValue(
      options.found === undefined
        ? { found: [], notOpened: 0, empty: 0 }
        : options.found,
    );
  const onNameFound = vi.fn().mockResolvedValue(options.named ?? true);
  render(
    <UnlockVault
      busy={false}
      notice=""
      autoLockMinutes={5}
      onUnlock={onUnlock}
      onRecover={vi.fn()}
      onReset={vi.fn()}
      restoreBridge={restoreBridge}
      onRestored={vi.fn()}
      severalVaults={
        options.severalVaults === false ? undefined : { onFind, onNameFound }
      }
    />,
  );
  return { onUnlock, onFind, onNameFound };
}

const passphrase = () => screen.getByLabelText(humanText("Passphrase"));
const disclosure = () =>
  screen.getByText(humanText("Use a different vault")).closest("details")!;
const nameBox = () => screen.getByLabelText(humanText("Vault name"));

describe("the unlock screen with several vaults", () => {
  afterEach(cleanup);

  it("offers 'Use a different vault', closed, with a name field and no list", () => {
    unlockScreen();
    expect(disclosure().open).toBe(false);
    expect(nameBox()).not.toBeVisible();
    // Nothing says how many vaults there are, or what any is called.
    expect(document.body.textContent).not.toMatch(/\d+ vaults?\b/);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("is as it always was where the native side cannot open a vault by name", () => {
    unlockScreen({ severalVaults: false });
    expect(screen.queryByText(humanText("Use a different vault"))).toBeNull();
  });

  it("unlocks the device's own vault, exactly as before, when no name is typed", async () => {
    const user = userEvent.setup();
    const { onUnlock } = unlockScreen();
    await user.type(passphrase(), PASS);
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(onUnlock).toHaveBeenCalledTimes(1);
    // Exactly one argument: no name, not even an empty one.
    expect(onUnlock.mock.calls[0]).toEqual([PASS]);
  });

  it("unlocks the vault of the name typed, without its spaces, and clears both boxes", async () => {
    const user = userEvent.setup();
    const { onUnlock } = unlockScreen();
    await user.click(screen.getByText(humanText("Use a different vault")));
    await user.type(nameBox(), "  FAKE Garden  ");
    await user.type(passphrase(), PASS);
    await user.click(screen.getByRole("button", { name: humanText("Unlock") }));
    expect(onUnlock).toHaveBeenCalledExactlyOnceWith(PASS, "FAKE Garden");
    expect(passphrase()).toHaveValue("");
    expect(nameBox()).toHaveValue("");
  });

  it("finds other vaults with the typed passphrase and says only counts", async () => {
    const user = userEvent.setup();
    const { onFind } = unlockScreen({
      found: { found: ["slot-a", "slot-b"], notOpened: 1, empty: 2 },
    });
    await user.click(screen.getByText(humanText("Use a different vault")));
    const find = screen.getByRole("button", { name: humanText("Find vaults") });
    // Needs a passphrase to try.
    expect(find).toBeDisabled();
    await user.type(passphrase(), PASS);
    await user.click(find);
    expect(onFind).toHaveBeenCalledExactlyOnceWith(PASS);
    expect(await screen.findByText(humanText("Found 2 vaults."))).toBeVisible();
    expect(
      screen.getByText(
        humanText("1 folder did not open with that passphrase."),
      ),
    ).toBeVisible();
    expect(screen.getByText(humanText("2 folders were empty."))).toBeVisible();
    // The opaque folder ids are never shown.
    expect(document.body.textContent).not.toContain("slot-a");
    expect(document.body.textContent).not.toContain("slot-b");
  });

  it("says plainly when nothing opened", async () => {
    const user = userEvent.setup();
    unlockScreen({ found: { found: [], notOpened: 0, empty: 0 } });
    await user.click(screen.getByText(humanText("Use a different vault")));
    await user.type(passphrase(), PASS);
    await user.click(
      screen.getByRole("button", { name: humanText("Find vaults") }),
    );
    expect(
      await screen.findByText(
        humanText("No other vault opened with that passphrase."),
      ),
    ).toBeVisible();
    expect(screen.queryByText(humanText("Save names"))).toBeNull();
  });

  it("asks for a name for each vault found, by number, and saves them all together", async () => {
    const user = userEvent.setup();
    const { onNameFound } = unlockScreen({
      found: { found: ["slot-a", "slot-b"], notOpened: 0, empty: 0 },
    });
    await user.click(screen.getByText(humanText("Use a different vault")));
    await user.type(passphrase(), PASS);
    await user.click(
      screen.getByRole("button", { name: humanText("Find vaults") }),
    );
    const first = await screen.findByLabelText(humanText("Vault 1 of 2"));
    const second = screen.getByLabelText(humanText("Vault 2 of 2"));
    const save = screen.getByRole("button", { name: humanText("Save names") });
    // All or none: one name missing holds Save back.
    expect(save).toBeDisabled();
    await user.type(first, " FAKE Garden ");
    expect(save).toBeDisabled();
    await user.type(second, "FAKE Orchard");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onNameFound).toHaveBeenCalledExactlyOnceWith([
      { id: "slot-a", name: "FAKE Garden" },
      { id: "slot-b", name: "FAKE Orchard" },
    ]);
    expect(
      await screen.findByText(
        humanText("The names were saved. Nothing was unlocked."),
      ),
    ).toBeVisible();
    // Nothing was unlocked, and the names are not kept on screen.
    expect(screen.queryByLabelText(humanText("Vault 1 of 2"))).toBeNull();
  });

  it("keeps what was typed and says so when the names were not saved", async () => {
    const user = userEvent.setup();
    unlockScreen({
      found: { found: ["slot-a"], notOpened: 0, empty: 0 },
      named: false,
    });
    await user.click(screen.getByText(humanText("Use a different vault")));
    await user.type(passphrase(), PASS);
    await user.click(
      screen.getByRole("button", { name: humanText("Find vaults") }),
    );
    await user.type(
      await screen.findByLabelText(humanText("Vault 1 of 1")),
      "FAKE Garden",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Save names") }),
    );
    expect(
      await screen.findByText(
        humanText("The names were not saved. Nothing was changed."),
      ),
    ).toBeVisible();
    expect(screen.getByLabelText(humanText("Vault 1 of 1"))).toHaveValue(
      "FAKE Garden",
    );
  });
});

describe("setting up another vault", () => {
  afterEach(cleanup);

  const setUp = (
    onCreate = vi.fn().mockResolvedValue(undefined),
    fromLockScreen = false,
  ) => {
    const onCancel = vi.fn();
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={onCreate}
        newVault={{ onCancel, fromLockScreen }}
      />,
    );
    return { onCreate, onCancel };
  };
  const fillPassphrases = () => {
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i)))
      fireEvent.change(field, { target: { value: PASS } });
  };
  const person = () =>
    screen.getByLabelText(humanText("Whose records will you keep here?"));
  const vaultName = () =>
    screen.getByLabelText(humanText("Name for this vault"));
  const create = () =>
    screen.getByRole("button", { name: humanText("Set up vault") });

  it("says what it does, that other vaults are not touched, and that the name is not a password", () => {
    setUp();
    expect(
      screen.getByRole("heading", { name: humanText("Set up a new vault") }),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(
          "Your other vaults are not touched: each keeps its own passphrase and recovery key.",
        ),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(/It is not a password: anyone who holds this device/),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(
          "Choosing Set up vault locks this vault, then opens the new one.",
        ),
      ),
    ).toBeVisible();
    // Another vault is not restored from here.
    expect(screen.queryByText(humanText(/Restore/))).toBeNull();
  });

  it("says, from an open vault, that this vault is locked first and that the device asks for a confirmation", () => {
    setUp();
    expect(
      screen.getByText(humanText(/This vault is locked first/)),
    ).toBeVisible();
    expect(
      screen.getByText(
        humanText(
          "Choosing Set up vault first asks this device to confirm, in a window of its own that this app cannot click. Nothing is created unless you agree there.",
        ),
      ),
    ).toBeVisible();
  });

  it("says, from the lock screen, that the device asks for a confirmation and does not claim a vault is locked first", () => {
    setUp(undefined, true);
    expect(
      screen.getByText(
        humanText(
          "A new vault on this device has its own passphrase, recovery key and people.",
        ),
      ),
    ).toBeVisible();
    expect(screen.queryByText(humanText(/locked first/))).toBeNull();
    expect(
      screen.queryByText(humanText(/locks this vault, then opens/)),
    ).toBeNull();
    expect(
      screen.getByText(humanText(/asks this device to confirm/)),
    ).toBeVisible();
    // Still says the other vaults are not touched.
    expect(
      screen.getByText(humanText(/Your other vaults are not touched/)),
    ).toBeVisible();
  });

  it("needs a name of 1 to 64 characters, and hands name, passphrase and person on", () => {
    const { onCreate } = setUp();
    fireEvent.change(person(), { target: { value: "FAKE Robin" } });
    fillPassphrases();
    expect(create()).toBeDisabled();
    fireEvent.change(vaultName(), { target: { value: "x".repeat(65) } });
    expect(
      screen.getByText(humanText("Choose a name of 1 to 64 characters.")),
    ).toBeVisible();
    expect(create()).toBeDisabled();
    fireEvent.change(vaultName(), { target: { value: "  FAKE Garden " } });
    expect(create()).toBeEnabled();
    fireEvent.click(create());
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      "FAKE Robin",
      PASS,
      undefined,
      "FAKE Garden",
    );
  });

  it("can be cancelled, which sets nothing up", () => {
    const { onCreate, onCancel } = setUp();
    fireEvent.click(screen.getByRole("button", { name: humanText("Cancel") }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("the first vault's own setup screen has no name field and no Cancel", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(
      screen.queryByLabelText(humanText("Name for this vault")),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: humanText("Cancel") }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeVisible();
  });
});
