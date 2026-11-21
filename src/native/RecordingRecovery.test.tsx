import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText } from "../test/humanText";
import type { PendingRecording } from "../vault";
import { RecordingRecovery } from "./RecordingRecovery";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};
beforeEach(() => setLocaleOverride("en"));

const recording = (
  overrides: Partial<PendingRecording> = {},
): PendingRecording => ({
  id: "recording-1",
  displayName: "FAKE Video, 20 Nov 2026, 3.05 PM.mp4",
  startedAtMs: 1,
  paused: false,
  parked: false,
  ...overrides,
});

function open(r: PendingRecording, busy = false) {
  const onAnswer = vi.fn();
  const onLater = vi.fn();
  render(
    <RecordingRecovery
      recording={r}
      busy={busy}
      onAnswer={onAnswer}
      onLater={onLater}
    />,
  );
  return { onAnswer, onLater };
}

describe("RecordingRecovery", () => {
  it("asks whether to keep the video, with Keep as the default", async () => {
    const { onAnswer } = open(recording());
    expect(
      screen.getByRole("alertdialog", {
        name: "myCarlos closed while you were recording. Keep the video that was saved?",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Keep the video" }),
    ).toHaveFocus();
    expect(
      screen.getByText(
        humanText("Recording: FAKE Video, 20 Nov 2026, 3.05 PM.mp4"),
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep the video" }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it("does not delete on one tap: it asks again, says it cannot be undone, and Keep is the default", async () => {
    const { onAnswer } = open(recording());
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", {
        name: humanText("Delete this recording? It can't be undone."),
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Keep the video" }),
      ).toHaveFocus(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith(false);
  });

  it("goes back from the confirmation on Escape, and keeping from it keeps", () => {
    const { onAnswer, onLater } = open(recording());
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    // Back at the question; nothing was deleted and nothing was put off.
    expect(
      screen.getByRole("alertdialog", {
        name: humanText(
          "myCarlos closed while you were recording. Keep the video that was saved?",
        ),
      }),
    ).toBeVisible();
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onLater).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep the video" }));
    expect(onAnswer).toHaveBeenCalledWith(true);
  });

  it("can be left unanswered: Escape or Ask me later, and the question comes back at the next unlock", () => {
    const { onAnswer, onLater } = open(recording());
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onLater).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Ask me later" }));
    expect(onLater).toHaveBeenCalledTimes(2);
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("says paused when it was paused", () => {
    open(recording({ paused: true }));
    expect(
      screen.getByRole("alertdialog", {
        name: humanText(
          "myCarlos closed while a recording was paused. Keep the video that was saved?",
        ),
      }),
    ).toBeVisible();
  });

  it("does nothing while an answer is being saved", () => {
    const { onAnswer, onLater } = open(recording(), true);
    fireEvent.click(screen.getByRole("button", { name: "Keep the video" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask me later" }));
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onLater).not.toHaveBeenCalled();
  });

  it("has no accessibility violations and speaks the patient's language", async () => {
    setLocaleOverride("pt-BR");
    open(recording());
    expect(
      screen.getByRole("button", { name: "Manter o vídeo" }),
    ).toBeVisible();
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
  });
});
