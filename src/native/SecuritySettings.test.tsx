import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecuritySettings } from "./SecuritySettings";

function renderSettings() {
  const props = {
    busy: false,
    readOnly: false,
    notice: "",
    autoLockMinutes: 5,
    onAutoLockMinutes: vi.fn(),
    onLock: vi.fn().mockResolvedValue(undefined),
    onChangePassphrase: vi.fn().mockResolvedValue(undefined),
    onCreateProfile: vi.fn().mockResolvedValue(true),
    onReset: vi.fn().mockResolvedValue(undefined),
  };
  render(<SecuritySettings {...props} />);
  return props;
}

const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("SecuritySettings passphrase change", () => {
  it("refuses a replacement under the minimum length before sending it", () => {
    const props = renderSettings();
    change("Current passphrase", "river-azimuth-cobalt-sparrow-934");
    change("New passphrase", "short phrase");
    change("Confirm new passphrase", "short phrase");

    expect(screen.getByRole("alert")).toHaveTextContent("too short");
    const button = screen.getByRole("button", { name: "Change passphrase" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    expect(props.onChangePassphrase).not.toHaveBeenCalled();
  });

  it("says a current passphrase over the vault's byte limit cannot be right", () => {
    const props = renderSettings();
    // 600 characters need 1800 UTF-8 bytes, over the vault's 1024-byte limit.
    change("Current passphrase", "字".repeat(600));
    change("New passphrase", "lantern-orbit-willow-cascade-572");
    change("Confirm new passphrase", "lantern-orbit-willow-cascade-572");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "longer than any vault passphrase",
    );
    const button = screen.getByRole("button", { name: "Change passphrase" });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest("form")!);
    expect(props.onChangePassphrase).not.toHaveBeenCalled();

    change("Current passphrase", "river-azimuth-cobalt-sparrow-934");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(button).toBeEnabled();
  });
});

describe("SecuritySettings profiles", () => {
  it("limits a profile name by characters, as the vault does", () => {
    renderSettings();
    const name = screen.getByLabelText("New profile name");
    fireEvent.change(name, { target: { value: "\u{1F332}".repeat(120) } });
    expect(name).toHaveValue("\u{1F332}".repeat(120));
    expect((name as HTMLInputElement).maxLength).toBe(240);
    expect(screen.getByRole("button", { name: "Add profile" })).toBeEnabled();

    fireEvent.change(name, { target: { value: "a".repeat(121) } });
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();

    fireEvent.change(name, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();
  });
});
