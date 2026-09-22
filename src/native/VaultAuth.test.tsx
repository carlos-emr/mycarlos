import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateVault, UnlockVault } from "./VaultAuth";

describe("CreateVault", () => {
  it("refuses a passphrase under the minimum as the vault counts it", () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<CreateVault busy={false} notice="" onCreate={onCreate} />);
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
    render(<CreateVault busy={false} notice="" onCreate={vi.fn()} />);
    const profile = screen.getByLabelText("First patient profile");
    fireEvent.change(profile, { target: { value: "\u{1F332}".repeat(120) } });
    expect(profile).toHaveValue("\u{1F332}".repeat(120));
    expect((profile as HTMLInputElement).maxLength).toBe(240);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(profile, { target: { value: "a".repeat(121) } });
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
        onReset={vi.fn()}
      />,
    );
    // 600 characters fit the input's 1024-unit limit but need 1800 UTF-8 bytes.
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
});
