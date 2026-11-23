import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import { BackupReminderNote } from "./BackupReminderNote";

const note = () =>
  screen.getByRole("note", { name: humanText("Backup reminder") });

describe("BackupReminderNote", () => {
  it("on a phone says the vault is not in iCloud or the phone's backups, and what is lost", () => {
    render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        phone
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent("not part of iCloud");
    expect(note()).toHaveHumanTextContent("the phone’s own backups");
    expect(note()).toHaveHumanTextContent(
      "without a myCarlos backup, you lose your vault",
    );
  });

  it("on a computer does not talk about iCloud", () => {
    render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        phone={false}
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).not.toHaveHumanTextContent("iCloud");
    expect(note()).toHaveHumanTextContent("only on this computer");
  });

  it("says why: the date of an old backup, and how many documents were added (singular and plural)", () => {
    const { rerender } = render(
      <BackupReminderNote
        reminder={{ kind: "old", savedAtMs: Date.UTC(2026, 9, 1, 12) }}
        phone={false}
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent("Your last myCarlos backup was on");
    rerender(
      <BackupReminderNote
        reminder={{ kind: "many", added: 1 }}
        phone={false}
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
        phone={false}
        busy={false}
        onMake={vi.fn()}
        onNotNow={vi.fn()}
      />,
    );
    expect(note()).toHaveHumanTextContent(
      "20 documents have been added since your last myCarlos backup.",
    );
  });

  it("has two real buttons: Make an encrypted backup (off while busy) and Not now", () => {
    const onMake = vi.fn();
    const onNotNow = vi.fn();
    const { rerender } = render(
      <BackupReminderNote
        reminder={{ kind: "never" }}
        phone={false}
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
        phone={false}
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
