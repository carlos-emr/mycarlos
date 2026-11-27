import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import { BackupReminderNote } from "./BackupReminderNote";

const note = () =>
  screen.getByRole("note", { name: humanText("Backup reminder") });

describe("BackupReminderNote", () => {
  it("on an iPhone or iPad says the vault is not in iCloud or the device's backups, and what is lost", () => {
    render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        device="ios"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent("not part of iCloud");
    expect(note()).toHaveHumanTextContent("the device’s own backups");
    expect(note()).toHaveHumanTextContent(
      "without a myCarlos backup, you lose your vault",
    );
  });

  it("on Android does not say iCloud, and says the device's backups", () => {
    render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        device="android"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).not.toHaveHumanTextContent("iCloud");
    expect(note()).toHaveHumanTextContent("Android phone or tablet");
    expect(note()).toHaveHumanTextContent("the device’s own backups");
  });

  it("on a computer is true of the computer: no iCloud, and the folder may be in the user's own backups", () => {
    render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        device="computer"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).not.toHaveHumanTextContent("iCloud");
    expect(note()).toHaveHumanTextContent("only on this computer");
    expect(note()).toHaveHumanTextContent(
      "your own computer backups do not include myCarlos’s folder",
    );
    expect(note()).not.toHaveHumanTextContent("not in the computer");
  });

  it("says why: the date of an old backup, and how many documents were added (singular and plural)", () => {
    const { rerender } = render(
      <BackupReminderNote
        reminder={{ kind: "old", savedDay: 20_000 }}
        device="computer"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    // 20,000 days after 1970-01-01 is 4 October 2024, shown in the app's language.
    expect(note()).toHaveHumanTextContent(
      "Your last myCarlos backup was on October 4, 2024.",
    );
    rerender(
      <BackupReminderNote
        reminder={{ kind: "many", added: 1 }}
        device="computer"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent(
      "1 document has been added since your last myCarlos backup.",
    );
    rerender(
      <BackupReminderNote
        reminder={{ kind: "many", added: 20 }}
        device="computer"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent(
      "20 documents have been added since your last myCarlos backup.",
    );
  });

  it("says a backup that left the videos out does not hold everything", () => {
    render(
      <BackupReminderNote
        reminder={{ kind: "partial" }}
        device="computer"
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent("left your videos out");
  });

  it("has two real buttons: Make an encrypted backup (off while busy) and Not now", () => {
    const onMake = vi.fn();
    const onNotNow = vi.fn();
    const { rerender } = render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        device="computer"
        busy={false}
        onMake={onMake}
        onNotNow={onNotNow}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Make an encrypted backup"),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: humanText("Not now") }));
    expect(onMake).toHaveBeenCalledTimes(1);
    expect(onNotNow).toHaveBeenCalledTimes(1);
    rerender(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        device="computer"
        busy
        onMake={onMake}
        onNotNow={onNotNow}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: humanText("Make an encrypted backup"),
      }),
    ).toBeDisabled();
  });
});
