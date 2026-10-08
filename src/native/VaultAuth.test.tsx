import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateVault, UnlockVault } from "./VaultAuth";

const restoreBridge = {
  pickRestoreSource: vi.fn().mockResolvedValue(null),
  inspectRestore: vi.fn(),
  restore: vi.fn(),
};

describe("CreateVault", () => {
  it("refuses a passphrase under the minimum as the vault counts it", () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByLabelText("First patient profile"), {
      target: { value: "Jamie" },
    });
    // Fifteen code points typed with a decomposed accent are fourteen after NFC
    // normalization, which is the form the vault checks.
    const short = "café lanterns!";
    expect([...short].length).toBe(15);
    for (const field of screen.getAllByLabelText(/passphrase/i))
      fireEvent.change(field, { target: { value: short } });

    expect(screen.getByRole("alert")).toHaveTextContent("too short");
    const create = screen.getByRole("button", { name: "Create vault" });
    expect(create).toBeDisabled();
    fireEvent.submit(create.closest("form")!);
    expect(onCreate).not.toHaveBeenCalled();

    // Astral characters count once each, as the vault counts them.
    const astral = "\u{1F332}".repeat(15);
    for (const field of screen.getAllByLabelText(/passphrase/i))
      fireEvent.change(field, { target: { value: astral } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(create).toBeEnabled();
  });

  it("accepts a profile name of 120 characters that need two UTF-16 units each", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const profile = screen.getByLabelText("First patient profile");
    fireEvent.change(profile, { target: { value: "\u{1F332}".repeat(120) } });
    expect(profile).toHaveValue("\u{1F332}".repeat(120));
    expect((profile as HTMLInputElement).maxLength).toBe(240);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(profile, { target: { value: "a".repeat(121) } });
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(screen.getByRole("button", { name: "Create vault" })).toBeDisabled();
  });

  it("refuses a profile name of only spaces, which the vault would refuse", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("First patient profile"), {
      target: { value: "   " },
    });
    for (const field of screen.getAllByLabelText(/passphrase/i))
      fireEvent.change(field, {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
    expect(screen.getByRole("button", { name: "Create vault" })).toBeDisabled();
  });

  it("reads the passphrase rules with the passphrase field", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Passphrase")).toHaveAccessibleDescription(
      /^0 character password Use at least 15 characters\./,
    );
  });

  it("keeps an empty status line on the page without taking up space", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    // The Create form's; the other is under "Restore from a backup".
    const status = screen.getAllByRole("status")[0];
    expect(status).toBeEmptyDOMElement();
    expect(status.getBoundingClientRect().height).toBe(0);
    // The same 12px as between the other fields.
    const above = screen
      .getByText("Confirm passphrase")
      .getBoundingClientRect();
    const create = screen
      .getByRole("button", { name: "Create vault" })
      .getBoundingClientRect();
    expect(create.top - above.bottom).toBeCloseTo(12, 0);
  });

  it("does not silently shorten a long pasted passphrase", () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(screen.getByLabelText("First patient profile"), {
      target: { value: "Jamie" },
    });
    const long = "a".repeat(1025);
    for (const field of screen.getAllByLabelText(/passphrase/i)) {
      fireEvent.change(field, { target: { value: long } });
      expect(field).toHaveValue(long);
    }
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(screen.getByRole("button", { name: "Create vault" })).toBeDisabled();
  });
});

describe("UnlockVault", () => {
  it("says a passphrase over the vault's byte limit cannot be right instead of sending it", () => {
    const onUnlock = vi.fn().mockResolvedValue(undefined);
    render(
      <UnlockVault
        busy={false}
        notice=""
        autoLockMinutes={5}
        onUnlock={onUnlock}
        onRecover={vi.fn()}
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    // 600 characters need 1800 UTF-8 bytes, over the vault's 1024-byte limit.
    const passphrase = screen.getByLabelText("Passphrase");
    fireEvent.change(passphrase, { target: { value: "字".repeat(600) } });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "longer than any vault passphrase",
    );
    const unlock = screen.getByRole("button", { name: "Unlock" });
    expect(unlock).toBeDisabled();
    fireEvent.submit(unlock.closest("form")!);
    expect(onUnlock).not.toHaveBeenCalled();

    fireEvent.change(passphrase, { target: { value: "字".repeat(341) } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(unlock).toBeEnabled();
  });

  it("keeps its status line on the page, so that a new message is read out", () => {
    const props = {
      busy: false,
      autoLockMinutes: 5,
      onUnlock: vi.fn(),
      onRecover: vi.fn(),
      restoreBridge,
      onRestored: vi.fn(),
      onReset: vi.fn(),
    };
    const { rerender } = render(<UnlockVault {...props} notice="" />);
    // The Unlock form's; the other is under "Forgot your passphrase?".
    const status = screen.getAllByRole("status")[0];
    expect(status).toBeEmptyDOMElement();
    expect(screen.getByLabelText("Passphrase")).toHaveAccessibleDescription(
      "0 character password",
    );

    rerender(<UnlockVault {...props} notice="FAKE wrong passphrase." />);
    expect(screen.getAllByRole("status")[0]).toBe(status);
    expect(status).toHaveTextContent("FAKE wrong passphrase.");
  });

  it("reads the message it opens with as the focused field's description", () => {
    render(
      <UnlockVault
        busy={false}
        notice="Vault locked."
        autoLockMinutes={5}
        onUnlock={vi.fn()}
        onRecover={vi.fn()}
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const passphrase = screen.getByLabelText("Passphrase");
    expect(passphrase).toHaveFocus();
    expect(passphrase).toHaveAccessibleDescription(
      "0 character password Vault locked.",
    );
  });

  it("opens with the recovery key and a new passphrase, and answers there", () => {
    const onRecover = vi.fn().mockResolvedValue(undefined);
    const props = {
      busy: false,
      autoLockMinutes: 5,
      onUnlock: vi.fn(),
      onRecover,
      onReset: vi.fn(),
      restoreBridge,
      onRestored: vi.fn(),
    };
    const { rerender } = render(<UnlockVault {...props} notice="" />);
    fireEvent.change(screen.getByLabelText("Recovery key"), {
      target: { value: "abcd efgh jkmn pqrs tvwx yz01 2345" },
    });
    const replacement = screen.getByLabelText("New passphrase");
    expect(replacement).toHaveAccessibleDescription(
      /^0 character password Use at least 15 characters\./,
    );
    fireEvent.change(replacement, {
      target: { value: "lantern-orbit-willow-cascade-572" },
    });
    const open = screen.getByRole("button", { name: "Open with recovery key" });
    expect(open).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm new passphrase"), {
      target: { value: "lantern-orbit-willow-cascade-572" },
    });
    expect(open).toBeEnabled();
    fireEvent.click(open);
    expect(onRecover).toHaveBeenCalledWith(
      "abcd efgh jkmn pqrs tvwx yz01 2345",
      "lantern-orbit-willow-cascade-572",
    );

    // Its answer is next to the recovery key, not by Unlock.
    rerender(<UnlockVault {...props} notice="FAKE wrong recovery key." />);
    const [unlockStatus, forgotStatus] = screen.getAllByRole("status");
    expect(unlockStatus).toBeEmptyDOMElement();
    expect(forgotStatus).toHaveTextContent("FAKE wrong recovery key.");
    expect(screen.getByLabelText("Passphrase")).toHaveAccessibleDescription(
      "0 character password",
    );
    // The key is kept, so that a typo in it can be corrected.
    expect(screen.getByLabelText("Recovery key")).toHaveValue(
      "abcd efgh jkmn pqrs tvwx yz01 2345",
    );
  });

  it("hides the recovery key as typed, and clears it when the app is hidden", () => {
    render(
      <UnlockVault
        busy={false}
        notice=""
        autoLockMinutes={5}
        onUnlock={vi.fn()}
        onRecover={vi.fn()}
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const field = screen.getByLabelText("Recovery key");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "ABCD-EFGH" } });
    const show = screen.getByRole("button", { name: "Show recovery key" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(show);
    expect(field).toHaveAttribute("type", "text");
    expect(show).toHaveAttribute("aria-pressed", "true");

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      fireEvent(document, new Event("visibilitychange"));
    } finally {
      visibility.mockRestore();
    }
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("type", "password");
  });
});
