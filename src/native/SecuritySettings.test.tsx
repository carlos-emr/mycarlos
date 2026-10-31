import { humanValue } from "../test/humanText";
import { humanText } from "../test/humanText";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { setLocaleOverride, translate } from "../i18n";
import { setDeviceLocale } from "../test/deviceLocale";
import { printedDate } from "./KeyLabel";
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
    hiddenCount: 0,
    hiddenScopeName: "My records",
    onOpenHidden: vi.fn(),
    onOpenAuditHistory: vi.fn(),
    recoveryKeySetAtMs: null,
    onSetUpRecoveryKey: vi.fn(),
    onSaveBackup: vi.fn().mockResolvedValue(undefined),
    onSpeedTest: vi.fn().mockResolvedValue(speedTest),
    ...overrides,
  };
  render(<SecuritySettings {...props} />);
  return props;
}

const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(humanText(label)), {
    target: { value },
  });

describe("SecuritySettings profile layout", () => {
  afterEach(async () => {
    document.documentElement.style.fontSize = "";
    await page.viewport(1100, 760);
  });

  it("keeps the profile name and Add profile action inside their section on a phone with enlarged text", async () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: "New profile name" });
    const button = screen.getByRole("button", { name: "Add profile" });
    input.closest("main")!.classList.add("native-vault-page");
    fireEvent.change(input, { target: { value: "FAKE Profile" } });
    const form = input.closest("form")!;
    const section = form.closest<HTMLElement>(".setting-row")!;
    const intro = section.firstElementChild!;
    section.style.fontFamily = "'DejaVu Sans', Verdana, sans-serif";
    const overlaps = (a: DOMRect, b: DOMRect) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    for (const width of [360, 320]) {
      await page.viewport(width, 800);
      for (const fontSize of ["16px", "24px", "32px"]) {
        document.documentElement.style.fontSize = fontSize;
        const row = section.getBoundingClientRect();
        const introduction = intro.getBoundingClientRect();
        expect(introduction.width).toBeGreaterThanOrEqual(
          Math.min(220, row.width - 4),
        );
        for (const control of [form, input, button]) {
          const box = control.getBoundingClientRect();
          expect(box.left).toBeGreaterThanOrEqual(row.left - 1);
          expect(box.right).toBeLessThanOrEqual(row.right + 1);
        }
        expect(overlaps(introduction, form.getBoundingClientRect())).toBe(
          false,
        );
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
        expect(button.scrollHeight).toBeLessThanOrEqual(
          button.clientHeight + 1,
        );
        expect(section.scrollWidth).toBeLessThanOrEqual(
          section.clientWidth + 1,
        );
      }
    }
  });

  it("keeps the profile form as wide as the other setting forms on a wide screen", () => {
    renderSettings();
    const input = screen.getByRole("textbox", { name: "New profile name" });
    input.closest("main")!.classList.add("native-vault-page");
    const profile = input.closest("form")!.getBoundingClientRect();
    const passphrase = screen
      .getByLabelText("Current passphrase")
      .closest("form")!
      .getBoundingClientRect();
    expect(Math.abs(profile.width - passphrase.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(profile.right - passphrase.right)).toBeLessThanOrEqual(1);
  });
});

describe("SecuritySettings speed test", () => {
  it("does not start while another vault action is busy", () => {
    const props = renderSettings({ busy: true });
    const button = screen.getByRole("button", {
      name: humanText("Run speed test"),
    });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(props.onSpeedTest).not.toHaveBeenCalled();
  });

  it("measures when asked, and gives a line to send", async () => {
    let finish!: (report: typeof speedTest) => void;
    const props = renderSettings();
    props.onSpeedTest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const button = screen.getByRole("button", {
      name: humanText("Run speed test"),
    });
    const section = button.closest("section")!;
    const status = within(section).getByRole("status");
    expect(status).toBeEmptyDOMElement();
    expect(props.onSpeedTest).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(status).toHaveHumanTextContent("Measuring…");
    expect(button).toBeDisabled();
    await act(async () => finish(speedTest));
    expect(status).toHaveHumanTextContent(
      "5 runs: 812, 820, 815, 830, 811 ms. Median 815 ms, longest 830 ms. Argon2id, 64 MiB, 3 passes, 4 lanes. android aarch64, myCarlos 0.1.0. Release build.",
    );
    expect(button).toBeEnabled();
  });

  it("says which kind of build was timed", () => {
    expect(humanValue(speedTestLine({ ...speedTest, release: false }))).toMatch(
      humanValue(/Evaluation build\.$/),
    );
    expect(
      humanValue(
        speedTestLine({ ...speedTest, release: false, simulator: true }),
      ),
    ).toMatch(humanValue(/Evaluation build, Simulator\.$/));
  });

  it("says why it could not measure, and can be run again", async () => {
    const props = renderSettings();
    props.onSpeedTest.mockRejectedValueOnce({
      code: "busy",
      message: "FAKE already running.",
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Run speed test") }),
    );
    expect(
      await screen.findByText(humanText("FAKE already running.")),
    ).toBeVisible();
    const button = screen.getByRole("button", {
      name: humanText("Run speed test"),
    });
    expect(button).toBeEnabled();
    expect(
      within(button.closest("section")!).getByRole("status"),
    ).toBeEmptyDOMElement();
    fireEvent.click(button);
    expect(
      await screen.findByText(humanText(speedTestLine(speedTest))),
    ).toBeVisible();
    expect(props.onSpeedTest).toHaveBeenCalledTimes(2);
    // Only a locked vault locks the app.
    expect(props.onLock).not.toHaveBeenCalled();
  });

  it("locks the app when the vault locked during the test", async () => {
    const props = renderSettings();
    props.onSpeedTest.mockRejectedValueOnce({
      code: "locked",
      message: "FAKE the vault is locked.",
    });
    const button = screen.getByRole("button", {
      name: humanText("Run speed test"),
    });
    fireEvent.click(button);
    await vi.waitFor(() => expect(props.onLock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(button).toBeEnabled());
    expect(
      within(button.closest("section")!).getByRole("status"),
    ).toBeEmptyDOMElement();
    expect(
      screen.queryByText(humanText("FAKE the vault is locked.")),
    ).toBeNull();
  });

  it("does not lock again once the screen has gone", async () => {
    let answer!: (error: unknown) => void;
    const props = renderSettings({
      onSpeedTest: vi.fn(
        () =>
          new Promise((_, reject) => {
            answer = reject;
          }),
      ),
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Run speed test") }),
    );
    // The app locked by itself and this screen went.
    cleanup();
    await act(async () => answer({ code: "locked", message: "FAKE locked." }));
    expect(props.onLock).not.toHaveBeenCalled();
  });
});

describe("SecuritySettings recovery key", () => {
  it("shows the current key's label and date, so the current kit can be told", () => {
    const setAt = Date.UTC(2026, 8, 30, 12);
    renderSettings({ recoveryKeySetAtMs: setAt, recoveryKeyLabel: "7F3A" });
    const line = screen.getByText(humanText(/Your current key has the label/));
    // Shown as printed, and spelled out to a screen reader.
    expect(within(line).getByText(humanText("7F3A"))).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(within(line).getByText(humanText("7 F 3 A"))).toHaveClass("sr-only");
    expect(line).toHaveHumanTextContent(/one with another label does not open/);
    // A kit or note from before labels has none, and may still work.
    expect(line).toHaveHumanTextContent(
      `one without a label may still be this key, set up on ${printedDate(new Date(setAt))}.`,
    );
    // The date it was set up is beside the heading.
    expect(
      screen.getByText(humanText(`Set up ${printedDate(new Date(setAt))}`)),
    ).toBeVisible();
  });

  it("shows the steps for older backups: a new one first", () => {
    const props = renderSettings({ oldBackupsGuide: { step: "save" } });
    const guide = screen.getByRole("region", {
      name: humanText("Your older backups"),
    });
    const steps = within(guide).getAllByRole("listitem");
    expect(steps[0]).toHaveHumanTextContent("Save a new backup now");
    // A patient with no older backups is not held to the steps.
    expect(
      within(guide).getByRole("button", {
        name: humanText("I have no older backups"),
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
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
    const guide = screen.getByRole("region", {
      name: humanText("Your older backups"),
    });
    // Kept, with a copy away from this device; the rest are older.
    const steps = within(guide).getAllByRole("listitem");
    expect(steps[0]).toHaveHumanTextContent(
      `Your new backup is “myCarlos backup 2026-09-30 7F3A” (2 kB, ${(2048).toLocaleString()} bytes). Keep it, or a copy of it, somewhere other than this device`,
    );
    expect(steps[1]).toHaveHumanTextContent(
      "other than the new one and its copies",
    );
    fireEvent.click(
      within(guide).getByRole("button", {
        name: humanText("Done with older backups"),
      }),
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
        screen.getByRole("region", { name: humanText("Your older backups") }),
      ).getAllByRole("listitem")[0],
    ).toHaveHumanTextContent(`(586 KB, ${(600000).toLocaleString()} bytes)`);
  });

  it("names no file when the platform does not say it", () => {
    const savedAtMs = Date.UTC(2026, 8, 30, 14, 31);
    renderSettings({
      oldBackupsGuide: { step: "delete", keep: null, savedAtMs, bytes: 0 },
    });
    // It is told apart by when it was saved.
    expect(
      within(
        screen.getByRole("region", { name: humanText("Your older backups") }),
      ).getAllByRole("listitem")[0],
    ).toHaveHumanTextContent(
      `Your new backup is the one you just saved, on ${printedDate(new Date(savedAtMs))} at about ${new Date(savedAtMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} (0 bytes)`,
    );
  });

  it("says when it was saved as the computer writes it, whatever the language", () => {
    // Ben, 21 Oct, kept 28 Oct: a Canadian computer's date and time, in a
    // French sentence.
    setDeviceLocale("en-CA");
    setLocaleOverride("fr");
    const savedAtMs = Date.UTC(2026, 8, 30, 14, 31);
    renderSettings({
      oldBackupsGuide: { step: "delete", keep: null, savedAtMs, bytes: 0 },
    });
    const time = new Intl.DateTimeFormat("en-CA", {
      hour: "numeric",
      minute: "2-digit",
    }).format(savedAtMs);
    expect(
      within(
        screen.getByRole("region", { name: "Vos anciennes sauvegardes" }),
      ).getAllByRole("listitem")[0],
    ).toHaveHumanTextContent(
      `Votre nouvelle sauvegarde est celle que vous venez d’enregistrer, le September 30, 2026 vers ${time} (`,
    );
  });

  it("says a new backup waits for a vault that accepts changes", () => {
    renderSettings({ readOnly: true, oldBackupsGuide: { step: "save" } });
    expect(
      within(
        screen.getByRole("region", { name: humanText("Your older backups") }),
      ).getAllByRole("listitem")[0],
    ).toHaveHumanTextContent("Once the vault accepts changes again");
  });

  it("names no label for a vault without a key", () => {
    renderSettings({ recoveryKeyLabel: null });
    expect(
      screen.queryByText(humanText(/Your current key has the label/)),
    ).toBeNull();
  });
});

describe("SecuritySettings privacy notice", () => {
  it("says that nothing is deleted and that a history is kept (#71)", () => {
    renderSettings();
    const notice = screen
      .getByRole("heading", { name: humanText("What myCarlos keeps") })
      .closest("section")!;
    expect(notice).toHaveHumanTextContent(/never deletes a document/);
    expect(notice).toHaveHumanTextContent(
      /also keeps a history: when the vault was opened; when its passphrase or recovery key was set or changed, and when a backup was saved or restored; when each patient profile was added and each folder made, renamed or moved; and when each document was added, renamed, moved, hidden, restored or saved outside myCarlos, and where/,
    );
    expect(notice).toHaveHumanTextContent(
      /can read it here; myCarlos never changes or removes it/,
    );
    expect(notice).toHaveHumanTextContent(
      /sets the vault aside: it stays on this device, encrypted. myCarlos never deletes a vault/,
    );
  });
});

describe("SecuritySettings passphrase change", () => {
  it("says what a new passphrase does not protect, without urging a new vault", () => {
    renderSettings();
    const limit =
      screen.getByText(humanText(/a new passphrase\s+is not enough/))
        .textContent ?? "";
    expect(limit).toMatch(/the old one still opens that copy/);
    expect(limit).toMatch(/Ask for help before you set your vault aside/);
    // The steps are in the documents, not here: nothing on this screen
    // tells a patient to do it.
    expect(limit).not.toMatch(/erase|set this vault aside/);
  });

  it("offers no way to set the vault aside from here (D89)", () => {
    // Starting again is only on the unlock screen ("Forgot your
    // passphrase?"): on a phone a vault set aside can't be removed without
    // removing every vault, so Security doesn't offer it as a fresh start.
    renderSettings();
    expect(
      screen.queryByRole("button", { name: humanText(/set vault aside/i) }),
    ).toBeNull();
    expect(screen.queryByText(humanText("Show reset controls"))).toBeNull();
    expect(
      screen.queryByLabelText(humanText(/RESET MYCARLOS VAULT/)),
    ).toBeNull();
    expect(document.body).not.toHaveHumanTextContent(/start again/i);
  });

  it("says hiding a document leaves copies outside the vault, not that it deletes (#71)", () => {
    renderSettings();
    const section = screen
      .getByRole("heading", {
        name: humanText("Readable copies and screenshots"),
      })
      .closest("section")!;
    expect(section).toHaveHumanTextContent(
      /Hiding a document in myCarlos does not erase those copies/,
    );
    // Nothing in myCarlos deletes a document since #71.
    expect(section).not.toHaveHumanTextContent(/delet/i);
  });

  it("keeps mismatched passphrase drafts while translating and clears all three only on explicit submit", () => {
    setLocaleOverride("en");
    const props = renderSettings();
    const current = screen.getByLabelText(
      "Current passphrase",
    ) as HTMLInputElement;
    const replacement = screen.getByLabelText("New passphrase");
    const confirmation = screen.getByLabelText(
      "Confirm new passphrase",
    ) as HTMLInputElement;
    const button = screen.getByRole("button", { name: "Change passphrase" });
    const form = button.closest("form")!;
    const currentValue = "FAKE current e\u0301{ $name }";
    const newValue = "FAKE lantern-e\u0301-orbit-cobalt-934";
    const mismatched = "FAKE different confirmation";
    fireEvent.change(current, { target: { value: currentValue } });
    fireEvent.change(replacement, { target: { value: newValue } });
    fireEvent.change(confirmation, { target: { value: mismatched } });
    confirmation.focus();
    confirmation.setSelectionRange(2, 5);

    for (const locale of ["pl", "fr"] as const) {
      act(() => setLocaleOverride(locale));
      expect(
        screen.getByLabelText(translate(locale, "security.passphrase.current")),
      ).toBe(current);
      expect(
        screen.getByLabelText(translate(locale, "passphrase.new.label")),
      ).toBe(replacement);
      expect(
        screen.getByLabelText(translate(locale, "passphrase.confirmNew.label")),
      ).toBe(confirmation);
      expect(current).toHaveValue(currentValue);
      expect(replacement).toHaveValue(newValue);
      expect(confirmation).toHaveValue(mismatched);
      expect(confirmation).toHaveFocus();
      expect([confirmation.selectionStart, confirmation.selectionEnd]).toEqual([
        2, 5,
      ]);
      expect(within(form).getByRole("alert")).toHaveHumanTextContent(
        translate(locale, "security.passphrase.mismatch"),
      );
      expect(
        screen.getByRole("button", {
          name: translate(locale, "security.passphrase.submit"),
        }),
      ).toBe(button);
      expect(button).toBeDisabled();
      expect(props.onChangePassphrase).not.toHaveBeenCalled();
    }

    fireEvent.change(confirmation, { target: { value: newValue } });
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(props.onChangePassphrase).toHaveBeenCalledExactlyOnceWith(
      currentValue,
      newValue,
    );
    for (const field of [current, replacement, confirmation])
      expect(field).toHaveValue("");
    act(() => setLocaleOverride("pt-BR"));
    for (const field of [current, replacement, confirmation])
      expect(field).toHaveValue("");
    expect(props.onChangePassphrase).toHaveBeenCalledTimes(1);
  });

  it("refuses a replacement under the minimum length before sending it", () => {
    const props = renderSettings();
    change("Current passphrase", "river-azimuth-cobalt-sparrow-934");
    change("New passphrase", "short phrase");
    change("Confirm new passphrase", "short phrase");

    expect(screen.getByRole("alert")).toHaveHumanTextContent("too short");
    const button = screen.getByRole("button", {
      name: humanText("Change passphrase"),
    });
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

    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "longer than any vault passphrase",
    );
    const button = screen.getByRole("button", {
      name: humanText("Change passphrase"),
    });
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
    const name = screen.getByLabelText(humanText("New profile name"));
    fireEvent.change(name, { target: { value: "\u{1F332}".repeat(120) } });
    expect(name).toHaveValue("\u{1F332}".repeat(120));
    expect((name as HTMLInputElement).maxLength).toBe(240);
    expect(
      screen.getByRole("button", { name: humanText("Add profile") }),
    ).toBeEnabled();

    fireEvent.change(name, { target: { value: "a".repeat(121) } });
    expect(screen.getByRole("alert")).toHaveHumanTextContent("too long");
    expect(
      screen.getByRole("button", { name: humanText("Add profile") }),
    ).toBeDisabled();

    fireEvent.change(name, { target: { value: "   " } });
    expect(
      screen.getByRole("button", { name: humanText("Add profile") }),
    ).toBeDisabled();
  });
});

describe("SecuritySettings backup", () => {
  it("saves an encrypted backup", () => {
    const props = renderSettings();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Save encrypted backup…") }),
    );
    expect(props.onSaveBackup).toHaveBeenCalledOnce();
  });
});

describe("Automatic lock delay (#67)", () => {
  it("puts Lock now beside the delay, before its steps, and locks (#110)", () => {
    const props = renderSettings({ autoLockMinutes: 5 });
    const heading = screen.getByRole("heading", {
      name: humanText("Lock automatically 5 minutes"),
    });
    const lockNow = screen.getByRole("button", { name: "Lock now" });
    const group = screen.getByRole("group", { name: "Automatic lock delay" });
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    // Right after the heading with its value, and before the delay's steps,
    // in reading and Tab order.
    expect(lockNow.previousElementSibling).toBe(heading);
    expect(follows(lockNow, group)).toBe(true);
    fireEvent.click(lockNow);
    expect(props.onLock).toHaveBeenCalledOnce();
  });

  it("steps by one minute with minus and plus, within 1 to 15", () => {
    const props = renderSettings({ autoLockMinutes: 5 });
    const group = screen.getByRole("group", {
      name: humanText("Automatic lock delay"),
    });
    expect(
      screen.queryByRole("combobox", { name: humanText(/lock delay/i) }),
    ).toBeNull();
    expect(within(group).getByText(humanText("5 minutes"))).toBeVisible();
    // On focus, each step says what the delay is now.
    for (const name of ["Shorter delay", "Longer delay"])
      expect(
        within(group).getByRole("button", { name }),
      ).toHaveHumanAccessibleDescription("5 minutes");
    fireEvent.click(
      within(group).getByRole("button", { name: humanText("Longer delay") }),
    );
    expect(props.onAutoLockMinutes).toHaveBeenLastCalledWith(6);
    fireEvent.click(
      within(group).getByRole("button", { name: humanText("Shorter delay") }),
    );
    expect(props.onAutoLockMinutes).toHaveBeenLastCalledWith(4);
  });

  it("goes no further at either end, and keeps the button usable for focus", () => {
    for (const [minutes, name] of [
      [1, "Shorter delay"],
      [15, "Longer delay"],
    ] as const) {
      const props = renderSettings({ autoLockMinutes: minutes });
      const group = screen.getAllByRole("group", {
        name: humanText("Automatic lock delay"),
      })[0];
      const end = within(group).getByRole("button", { name });
      expect(end).toHaveAttribute("aria-disabled", "true");
      expect(end).toBeEnabled();
      fireEvent.click(end);
      expect(props.onAutoLockMinutes).not.toHaveBeenCalled();
      cleanup();
    }
  });
});

describe("SecuritySettings backup layout", () => {
  it("keeps the encrypted backup action inside its row with enlarged text and a wide fallback font", () => {
    renderSettings();
    const button = screen.getByRole("button", {
      name: "Save encrypted backup…",
    });
    // Match the native vault's appearance without involving routing or profiles.
    button.closest("main")!.classList.add("native-vault-page");
    const section = button.closest<HTMLElement>(".setting-row")!;
    section.style.fontFamily = "'DejaVu Sans', Verdana, sans-serif";
    try {
      for (const fontSize of ["16px", "24px", "32px"]) {
        document.documentElement.style.fontSize = fontSize;
        for (const width of [760, 320]) {
          section.style.width = `${width}px`;
          section.style.maxWidth = "100%";
          const row = section.getBoundingClientRect();
          const action = button.getBoundingClientRect();
          expect(action.left).toBeGreaterThanOrEqual(row.left - 1);
          expect(action.right).toBeLessThanOrEqual(row.right + 1);
          expect(button.scrollWidth).toBeLessThanOrEqual(
            button.clientWidth + 1,
          );
          expect(button.scrollHeight).toBeLessThanOrEqual(
            button.clientHeight + 1,
          );
          expect(section.scrollWidth).toBeLessThanOrEqual(
            section.clientWidth + 1,
          );
        }
      }
    } finally {
      document.documentElement.style.fontSize = "";
    }
  });
});
