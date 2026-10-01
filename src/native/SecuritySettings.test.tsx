import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { printedDate } from "./KeyLabel";
import { SecuritySettings } from "./SecuritySettings";

function renderSettings(overrides: Record<string, unknown> = {}) {
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
    recoveryKeySetAtMs: null,
    onSetUpRecoveryKey: vi.fn(),
    onSaveBackup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<SecuritySettings {...props} />);
  return props;
}

const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("SecuritySettings recovery key", () => {
  it("shows the current key's label and date, so the current kit can be told", () => {
    const setAt = Date.UTC(2026, 8, 30, 12);
    renderSettings({ recoveryKeySetAtMs: setAt, recoveryKeyLabel: "7F3A" });
    const line = screen.getByText(/Your current key has the label/);
    // Shown as printed, and spelled out to a screen reader.
    expect(within(line).getByText("7F3A")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(within(line).getByText("7 F 3 A")).toHaveClass("sr-only");
    expect(line).toHaveTextContent(/one with another label does not open/);
    // A kit or note from before labels has none, and may still work.
    expect(line).toHaveTextContent(
      `one without a label may still be this key, set up on ${printedDate(new Date(setAt))}.`,
    );
    // The date it was set up is beside the heading.
    expect(
      screen.getByText(`Set up ${printedDate(new Date(setAt))}`),
    ).toBeVisible();
  });

  it("shows the steps for older backups: a new one first", () => {
    const props = renderSettings({ oldBackupsGuide: { step: "save" } });
    const guide = screen.getByRole("region", { name: "Your older backups" });
    const steps = within(guide).getAllByRole("listitem");
    expect(steps[0]).toHaveTextContent("Save a new backup now");
    // A patient with no older backups is not held to the steps.
    expect(
      within(guide).getByRole("button", { name: "I have no older backups" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Save encrypted backup…" }),
    );
    expect(props.onSaveBackup).toHaveBeenCalledOnce();
  });

  it("names the new backup to keep, then lets the steps be closed", () => {
    const onOldBackupsGuideDone = vi.fn();
    renderSettings({
      oldBackupsGuide: {
        step: "delete",
        keep: "myCarlos backup 2026-09-30 7F3A",
        savedAtMs: 1,
        bytes: 2048,
      },
      onOldBackupsGuideDone,
    });
    const guide = screen.getByRole("region", { name: "Your older backups" });
    // Kept, with a copy away from this device; the rest are older.
    const steps = within(guide).getAllByRole("listitem");
    expect(steps[0]).toHaveTextContent(
      `Your new backup is “myCarlos backup 2026-09-30 7F3A” (2 kB, ${(2048).toLocaleString()} bytes). Keep it, or a copy of it, somewhere other than this device`,
    );
    expect(steps[1]).toHaveTextContent("other than the new one and its copies");
    fireEvent.click(
      within(guide).getByRole("button", { name: "Done with older backups" }),
    );
    expect(onOldBackupsGuideDone).toHaveBeenCalledOnce();
  });

  it("gives the size as Windows Explorer counts it, on Windows", () => {
    renderSettings({
      sizesIn1024s: true,
      oldBackupsGuide: {
        step: "delete",
        keep: "myCarlos backup 2026-09-30 7F3A",
        savedAtMs: 1,
        bytes: 600_000,
      },
    });
    expect(
      within(
        screen.getByRole("region", { name: "Your older backups" }),
      ).getAllByRole("listitem")[0],
    ).toHaveTextContent(`(586 KB, ${(600000).toLocaleString()} bytes)`);
  });

  it("names no file when the platform does not say it", () => {
    const savedAtMs = Date.UTC(2026, 8, 30, 14, 31);
    renderSettings({
      oldBackupsGuide: { step: "delete", keep: null, savedAtMs, bytes: 0 },
    });
    // It is told apart by when it was saved.
    expect(
      within(
        screen.getByRole("region", { name: "Your older backups" }),
      ).getAllByRole("listitem")[0],
    ).toHaveTextContent(
      `Your new backup is the one you just saved, on ${printedDate(new Date(savedAtMs))} at about ${new Date(savedAtMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} (0 bytes)`,
    );
  });

  it("says a new backup waits for a vault that accepts changes", () => {
    renderSettings({ readOnly: true, oldBackupsGuide: { step: "save" } });
    expect(
      within(
        screen.getByRole("region", { name: "Your older backups" }),
      ).getAllByRole("listitem")[0],
    ).toHaveTextContent("Once the vault accepts changes again");
  });

  it("names no label for a vault without a key", () => {
    renderSettings({ recoveryKeyLabel: null });
    expect(screen.queryByText(/Your current key has the label/)).toBeNull();
  });
});

describe("SecuritySettings passphrase change", () => {
  it("says what a new passphrase does not protect, without urging an erase", () => {
    renderSettings();
    const limit =
      screen.getByText(/a new passphrase\s+is not enough/).textContent ?? "";
    expect(limit).toMatch(/the old one still opens that copy/);
    expect(limit).toMatch(/Ask for help before you erase anything/);
    // The steps are in the documents, not here: nothing on this screen
    // tells a patient to erase.
    expect(limit).not.toMatch(/erase this vault/);
  });

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

describe("SecuritySettings backup", () => {
  it("saves an encrypted backup", () => {
    const props = renderSettings();
    fireEvent.click(
      screen.getByRole("button", { name: "Save encrypted backup…" }),
    );
    expect(props.onSaveBackup).toHaveBeenCalledOnce();
  });
});
