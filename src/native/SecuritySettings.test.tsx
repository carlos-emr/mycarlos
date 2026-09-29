import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecuritySettings, speedTestLine } from "./SecuritySettings";

const speedTest = {
  memoryKib: 65536,
  iterations: 3,
  lanes: 4,
  samplesMs: [812, 820, 815, 830, 811],
  medianMs: 815,
  maxMs: 830,
  release: true,
  simulator: false,
  platform: "android",
  architecture: "aarch64",
  appVersion: "0.1.0",
};

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
    recoveryKeySetAtMs: null,
    onSetUpRecoveryKey: vi.fn(),
    onSaveBackup: vi.fn().mockResolvedValue(undefined),
    onSpeedTest: vi.fn().mockResolvedValue(speedTest),
  };
  render(<SecuritySettings {...props} />);
  return props;
}

const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("SecuritySettings speed test", () => {
  it("measures when asked, and gives a line to send", async () => {
    let finish!: (report: typeof speedTest) => void;
    const props = renderSettings();
    props.onSpeedTest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const button = screen.getByRole("button", { name: "Run speed test" });
    const section = button.closest("section")!;
    const status = within(section).getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(props.onSpeedTest).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(status).toHaveTextContent("Measuring…");
    expect(button).toBeDisabled();
    await act(async () => finish(speedTest));
    expect(status).toHaveTextContent(
      "5 runs: 812, 820, 815, 830, 811 ms. Median 815 ms, longest 830 ms. Argon2id, 64 MiB, 3 passes, 4 lanes. android aarch64, myCarlos 0.1.0. Release build.",
    );
    expect(button).toBeEnabled();
  });

  it("says which kind of build was timed", () => {
    expect(speedTestLine({ ...speedTest, release: false })).toMatch(
      /Evaluation build\.$/,
    );
    expect(
      speedTestLine({ ...speedTest, release: false, simulator: true }),
    ).toMatch(/Evaluation build, Simulator\.$/);
  });

  it("says why it could not measure", async () => {
    const props = renderSettings();
    props.onSpeedTest.mockRejectedValueOnce({
      code: "busy",
      message: "FAKE already running.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Run speed test" }));
    expect(await screen.findByText("FAKE already running.")).toBeVisible();
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
