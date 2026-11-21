import { humanText } from "../test/humanText";
import { useTextState } from "../i18n";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  vaultErrorMessage,
  type PendingRecording,
  type VaultBridge,
  type VaultRecord,
  type VaultSnapshot,
} from "../vault";
import { VaultLibrary } from "./VaultLibrary";

let snapshotSequence = 1;
function captureSnapshot(snapshot: VaultSnapshot): VaultSnapshot {
  return {
    ...structuredClone(snapshot),
    capture: {
      epoch: "00000000-0000-4000-8000-000000000185",
      sequence: ++snapshotSequence,
    },
  };
}

const VIDEO_NAME = "FAKE Video, 20 Nov 2026, 3.05 PM.mp4";
const TOKEN = "a".repeat(64);
const URL = `mycarlos-video://localhost/${TOKEN}`;

const record = (id: string, displayName: string) =>
  ({
    id,
    profileId: "profile-1",
    folderIds: [],
    displayName,
    sourceLabel: "Manual import — unverified",
    mediaType: "application/octet-stream",
    plaintextSize: 2048,
    importedAtMs: Date.UTC(2026, 10, 20, 15, 5),
    available: true,
  }) satisfies VaultRecord;

const base: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [{ id: "profile-1", displayName: "FAKE Patient", createdAtMs: 1 }],
  folders: [],
  records: [],
  recovery: null,
};

// The webview records MP4, or it does not.
let mp4 = true;
class Recorder extends EventTarget {
  static isTypeSupported = (type: string) =>
    mp4 && type.startsWith("video/mp4");
}
beforeEach(() => {
  mp4 = true;
  vi.stubGlobal("MediaRecorder", Recorder);
});
afterEach(() => vi.unstubAllGlobals());

function renderLibrary(
  initial: VaultSnapshot,
  overrides: Partial<VaultBridge> = {},
  holdMedia?: () => () => void,
) {
  let current = initial;
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    isPhoto: vi.fn(async () => false),
    isLockedPdf: vi.fn(async () => false),
    isVideo: vi.fn(async () => false),
    videoStart: vi.fn(async () => ({ recordingId: "recording-1" })),
    videoPending: vi.fn(async () => ({ recordings: [], unreadable: 0 })),
    videoRecover: vi.fn(async () => ({ recordId: null })),
    videoOpen: vi.fn(async () => ({
      token: TOKEN,
      url: URL,
      totalBytes: 123,
    })),
    videoClose: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => captureSnapshot(current)),
    ...overrides,
  } as unknown as VaultBridge;
  function Harness() {
    const [snapshot, setSnapshot] = useState(initial);
    const [notice, setNotice] = useTextState("");
    return (
      <VaultLibrary
        bridge={bridge}
        snapshot={snapshot}
        busy={false}
        notice={notice}
        setNotice={setNotice}
        run={async (operation) => {
          try {
            await operation();
          } catch (error) {
            setNotice(vaultErrorMessage(error));
          }
        }}
        refresh={async () => {
          setSnapshot(current);
          return current;
        }}
        onLock={vi.fn().mockResolvedValue(undefined)}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
        cameraPlatform="windows"
        holdMedia={holdMedia}
      />
    );
  }
  render(<Harness />);
  return bridge;
}

describe("video in the library", () => {
  it("offers Record a video where the webview records MP4, and no explaining line", () => {
    renderLibrary(base);
    expect(
      screen.getByRole("button", { name: humanText("Record a video") }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    ).toBeEnabled();
    expect(
      screen.queryByText(
        humanText("Video recording isn't available on this device."),
      ),
    ).toBeNull();
  });

  it("says so, where the button would be, when it cannot, with a Why? that explains", async () => {
    mp4 = false;
    renderLibrary(base);
    expect(
      screen.queryByRole("button", { name: humanText("Record a video") }),
    ).toBeNull();
    // The camera for photos is unaffected.
    expect(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        humanText("Video recording isn't available on this device."),
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: humanText("Why?") }));
    const help = screen.getByRole("dialog", {
      name: humanText("Why can't I record video here?"),
    });
    expect(help).toHaveHumanTextContent("Media Feature Pack");
    expect(help).toHaveHumanTextContent("gstreamer1.0-plugins-ugly");
    expect(help).toHaveHumanTextContent("iOS before 14.5");
    expect(help).toHaveHumanTextContent("Photos and documents work as usual.");
    fireEvent.click(
      within(help).getByRole("button", { name: humanText("Close") }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The page behind was inert while it was open, and gets its focus back.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: humanText("Why?") }),
      ).toBeEnabled(),
    );
  });

  it("opens the recording dialog from the add menu and records nothing yet", () => {
    const bridge = renderLibrary(base);
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Record a video") }),
    );
    expect(
      screen.getByRole("dialog", { name: humanText("Record a video") }),
    ).toBeVisible();
    expect(bridge.videoStart).not.toHaveBeenCalled();
  });

  it("plays a document whose file is an MP4, from the vault's address, and ends the playback when closed", async () => {
    const hold = vi.fn();
    const release = vi.fn();
    hold.mockReturnValue(release);
    const bridge = renderLibrary(
      { ...base, records: [record("video-1", VIDEO_NAME)] },
      { isVideo: vi.fn(async (id: string) => id === "video-1") },
      hold,
    );
    fireEvent.click(
      screen.getByRole("button", { name: humanText(VIDEO_NAME) }),
    );
    const details = screen.getByRole("dialog", { name: humanText(VIDEO_NAME) });
    const play = await within(details).findByRole("button", {
      name: humanText("Play video"),
    });
    fireEvent.click(play);
    await waitFor(() =>
      expect(bridge.videoOpen).toHaveBeenCalledWith("video-1"),
    );
    const player = await screen.findByLabelText(
      humanText(`Video player: ${VIDEO_NAME}`),
    );
    expect(player).toHaveAttribute("src", URL);
    // Playing holds the automatic lock; pausing lets go; closing ends the playback.
    expect(hold).not.toHaveBeenCalled();
    fireEvent(player, new Event("playing"));
    expect(hold).toHaveBeenCalledTimes(1);
    fireEvent(player, new Event("pause"));
    expect(release).toHaveBeenCalledTimes(1);
    fireEvent(player, new Event("playing"));
    expect(hold).toHaveBeenCalledTimes(2);
    // The player is the dialog on top of the document's details.
    const viewer = screen
      .getAllByRole("dialog", { name: humanText(VIDEO_NAME) })
      .find((dialog) => dialog.querySelector("video"))!;
    fireEvent.click(
      within(viewer).getByRole("button", { name: humanText("Close") }),
    );
    expect(bridge.videoClose).toHaveBeenCalledWith(TOKEN);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("offers no Play for a document that is not a video", async () => {
    const bridge = renderLibrary({
      ...base,
      records: [record("note-1", "FAKE note.txt")],
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("FAKE note.txt") }),
    );
    await waitFor(() => expect(bridge.isVideo).toHaveBeenCalledWith("note-1"));
    expect(
      screen.queryByRole("button", { name: humanText("Play video") }),
    ).toBeNull();
  });
});

describe("the question about a recording that was cut short", () => {
  const pending = (overrides: Partial<PendingRecording> = {}) =>
    ({
      id: "recording-9",
      displayName: VIDEO_NAME,
      startedAtMs: 1,
      paused: false,
      parked: false,
      stopped: false,
      ...overrides,
    }) satisfies PendingRecording;

  it("asks at unlock, and Keep is the default", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [pending()],
        unreadable: 0,
      })),
      videoRecover: vi.fn(async () => ({ recordId: null })),
    });
    const question = await screen.findByRole("alertdialog", {
      name: humanText(
        "myCarlos closed while you were recording. Keep the video that was saved?",
      ),
    });
    await waitFor(() =>
      expect(
        within(question).getByRole("button", {
          name: humanText("Keep the video"),
        }),
      ).toHaveFocus(),
    );
    fireEvent.click(
      within(question).getByRole("button", {
        name: humanText("Keep the video"),
      }),
    );
    await waitFor(() =>
      expect(bridge.videoRecover).toHaveBeenCalledWith("recording-9", true),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Nothing complete was there: the notice says so, plainly.
    expect(
      await screen.findByText(
        humanText(
          "Nothing complete had been saved, so there was no video to keep.",
        ),
      ),
    ).toBeVisible();
  });

  it("deletes only after a second, plainer question, and says so", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [pending({ paused: true })],
        unreadable: 0,
      })),
    });
    await screen.findByRole("alertdialog", {
      name: humanText(
        "myCarlos closed while a recording was paused. Keep the video that was saved?",
      ),
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Delete it") }),
    );
    expect(bridge.videoRecover).not.toHaveBeenCalled();
    await screen.findByRole("alertdialog", {
      name: humanText("Delete this recording? It can't be undone."),
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Delete it") }),
    );
    await waitFor(() =>
      expect(bridge.videoRecover).toHaveBeenCalledWith("recording-9", false),
    );
    expect(
      await screen.findByText(
        humanText("The unfinished recording was deleted."),
      ),
    ).toBeVisible();
  });

  it("saves a recording a lock parked, without a question, and says so", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [
          pending({ id: "recording-1", parked: true }),
          pending({
            id: "recording-2",
            displayName: "FAKE Paused.mp4",
            parked: true,
            paused: true,
          }),
        ],
        unreadable: 0,
      })),
      videoRecover: vi.fn(async (id: string) => ({ recordId: `video-${id}` })),
    });
    await waitFor(() => expect(bridge.videoRecover).toHaveBeenCalledTimes(2));
    expect(bridge.videoRecover).toHaveBeenCalledWith("recording-1", true);
    expect(bridge.videoRecover).toHaveBeenCalledWith("recording-2", true);
    // No Keep or Delete question: they were saved.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const notice = await screen.findByText(
      humanText(
        /myCarlos locked while you were recording\. The video was saved/,
      ),
    );
    expect(notice).toHaveHumanTextContent(
      "myCarlos locked while a recording was paused. The video was saved: FAKE Paused.mp4",
    );
  });

  it("says a recording the patient ended for want of room was finished now there is room, not that a lock ended it", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [pending({ parked: true, stopped: true })],
        unreadable: 0,
      })),
      videoRecover: vi.fn(async () => ({ recordId: "video-1" })),
    });
    await waitFor(() =>
      expect(bridge.videoRecover).toHaveBeenCalledWith("recording-9", true),
    );
    expect(
      await screen.findByText(
        humanText(
          `There is room again, so your unfinished video was finished: ${VIDEO_NAME}`,
        ),
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(humanText(/locked while you were recording/)),
    ).toBeNull();
  });

  it("says there is still no room for one, tries the others, and does not call it a failure", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [
          pending({ id: "recording-1", parked: true, stopped: true }),
          pending({
            id: "recording-2",
            displayName: "FAKE Other.mp4",
            parked: true,
          }),
        ],
        unreadable: 0,
      })),
      videoRecover: vi.fn(async (id: string) => {
        if (id === "recording-1")
          throw { code: "no_space", message: "FAKE no room" };
        return { recordId: "video-2" };
      }),
    });
    await waitFor(() => expect(bridge.videoRecover).toHaveBeenCalledTimes(2));
    const notice = await screen.findByText(
      humanText(
        /There is still not enough room to finish your unfinished video/,
      ),
    );
    expect(notice).toHaveHumanTextContent(
      "myCarlos locked while you were recording. The video was saved: FAKE Other.mp4",
    );
    expect(notice).not.toHaveHumanTextContent("could not");
  });

  it("waits for the next unlock when the patient does not answer", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [pending()],
        unreadable: 0,
      })),
    });
    await screen.findByRole("alertdialog");
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Ask me later") }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(bridge.videoRecover).not.toHaveBeenCalled();
  });

  it("asks about each in turn", async () => {
    const bridge = renderLibrary(base, {
      videoPending: vi.fn(async () => ({
        recordings: [
          pending({ id: "recording-1" }),
          pending({ id: "recording-2", displayName: "FAKE Second.mp4" }),
        ],
        unreadable: 0,
      })),
    });
    await screen.findByText(humanText(`Recording: ${VIDEO_NAME}`));
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Delete it") }),
    );
    await screen.findByRole("alertdialog", {
      name: humanText("Delete this recording? It can't be undone."),
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Delete it") }),
    );
    await waitFor(() =>
      expect(bridge.videoRecover).toHaveBeenCalledWith("recording-1", false),
    );
    expect(
      await screen.findByText(humanText("Recording: FAKE Second.mp4")),
    ).toBeVisible();
    await act(async () => undefined);
  });
});
