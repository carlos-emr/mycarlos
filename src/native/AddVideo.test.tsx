import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import type {
  VideoImportProgress,
  VideoImportResult,
  VideoRefusal,
} from "../vault";
import {
  AddVideo,
  AddVideoButton,
  AddVideoStatus,
  canAddVideo,
  useAddVideo,
  type AddVideoBridge,
} from "./AddVideo";

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

const REASONS: VideoRefusal[] = [
  "notVideo",
  "hevc",
  "videoCodec",
  "audioCodec",
  "noVideo",
  "tooManyTracks",
  "external",
  "fragmented",
  "tooBig",
  "tooLarge",
  "damaged",
];

function bridgeFor(result: VideoImportResult | Promise<VideoImportResult>) {
  const bridge = {
    pickImportVideo: vi.fn(async () => "pick-1" as string | null),
    importPickedVideo: vi.fn(async () => result),
    videoImportProgress: vi.fn(
      async (): Promise<VideoImportProgress> => ({
        stage: "idle",
        doneBytes: 0,
        totalBytes: 0,
      }),
    ),
    videoImportCancel: vi.fn(async () => undefined),
  } satisfies AddVideoBridge;
  return bridge;
}

/** A promise the test settles by hand. */
function later<T>() {
  let finish: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function renderAdd(bridge: AddVideoBridge, onAdded = vi.fn()) {
  render(
    <AddVideo
      bridge={bridge}
      profileId="person-1"
      folderIds={["folder-1"]}
      onAdded={onAdded}
    />,
  );
  return onAdded;
}

const status = () => screen.getByRole("status");
const alert = () => screen.getByRole("alert");

describe("Add a video: the button and its status", () => {
  it("is offered only by a bridge that can add one", () => {
    expect(canAddVideo({})).toBe(false);
    expect(canAddVideo({ pickImportVideo: async () => null })).toBe(false);
    expect(canAddVideo(bridgeFor({ result: "duplicate" }))).toBe(true);
  });

  it("has its two speaking lines on screen from the start, empty, so that what they later say is read", () => {
    setLocaleOverride("en");
    renderAdd(bridgeFor({ result: "duplicate" }));
    expect(status()).toBeEmptyDOMElement();
    expect(alert()).toBeEmptyDOMElement();
  });

  it("picks, adds into the open folder, says so, tells the library and gives the focus back", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const bridge = bridgeFor({ result: "imported", recordId: "record-9" });
    const onAdded = renderAdd(bridge);
    const button = screen.getByRole("button", { name: "Add a video" });
    // What it does is the description, so the name stays the visible word.
    expect(button).toHaveAccessibleDescription(/the device's name and model/);
    await user.click(button);
    expect(bridge.pickImportVideo).toHaveBeenCalledWith("person-1", [
      "folder-1",
    ]);
    expect(bridge.importPickedVideo).toHaveBeenCalledWith(
      "pick-1",
      "person-1",
      ["folder-1"],
    );
    await vi.waitFor(() =>
      expect(status()).toHaveTextContent("The video was added."),
    );
    expect(onAdded).toHaveBeenCalledWith("record-9");
    await vi.waitFor(() => expect(button).toHaveFocus());
  });

  it("does nothing, and says nothing, when the picker is closed", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const bridge = bridgeFor({ result: "duplicate" });
    bridge.pickImportVideo.mockResolvedValue(null);
    const onAdded = renderAdd(bridge);
    await user.click(screen.getByRole("button", { name: "Add a video" }));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Add a video" })).toBeEnabled(),
    );
    expect(bridge.importPickedVideo).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(status()).toBeEmptyDOMElement();
    expect(alert()).toBeEmptyDOMElement();
  });

  it("says a duplicate and a cancel plainly, and adds nothing in either case", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    for (const [result, words] of [
      [
        { result: "duplicate" },
        "That video is already here. Nothing was added.",
      ],
      [{ result: "cancelled" }, "Cancelled. Nothing was added."],
    ] as const) {
      const onAdded = renderAdd(bridgeFor(result));
      await user.click(screen.getByRole("button", { name: "Add a video" }));
      await vi.waitFor(() => expect(status()).toHaveTextContent(words));
      expect(alert()).toBeEmptyDOMElement();
      expect(onAdded).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("gives every reason a refusal can have its own words, on the alert line", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const seen = new Set<string>();
    for (const reason of REASONS) {
      const onAdded = renderAdd(bridgeFor({ result: "refused", reason }));
      await user.click(screen.getByRole("button", { name: "Add a video" }));
      await vi.waitFor(() =>
        expect(alert()).toHaveTextContent(
          translate("en", `interface.AddVideo.${reason}` as const),
        ),
      );
      const text = alert().textContent ?? "";
      expect(text.length).toBeGreaterThan(30);
      expect(seen.has(text)).toBe(false);
      seen.add(text);
      expect(status()).toBeEmptyDOMElement();
      expect(onAdded).not.toHaveBeenCalled();
      cleanup();
    }
    expect(seen.size).toBe(REASONS.length);
    expect(translate("en", "interface.AddVideo.hevc")).toContain("H.264 MP4");
  });

  it("moves the focus to Cancel when the bar appears, shows the bar and its percentage, and the answer replaces them", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const done = later<VideoImportResult>();
    const bridge = bridgeFor(done.promise);
    bridge.videoImportProgress
      .mockResolvedValueOnce({ stage: "checking", doneBytes: 5, totalBytes: 0 })
      .mockResolvedValue({ stage: "storing", doneBytes: 50, totalBytes: 100 });
    renderAdd(bridge);
    const add = screen.getByRole("button", { name: "Add a video" });
    await user.click(add);
    // The Add button waits, and the focus is on Cancel (it would otherwise fall to the page).
    expect(add).toBeDisabled();
    const group = await screen.findByRole("group", {
      name: "Adding the video",
    });
    const cancel = within(group).getByRole("button", { name: "Cancel" });
    await vi.waitFor(() => expect(cancel).toHaveFocus());
    const bar = within(group).getByRole("progressbar");
    await vi.waitFor(
      () => expect(status()).toHaveTextContent("Checking the video…"),
      {
        timeout: 3000,
      },
    );
    expect(bar).not.toHaveAttribute("value");
    await vi.waitFor(() => expect(bar).toHaveAttribute("value", "50"), {
      timeout: 3000,
    });
    expect(within(group).getByText("50%")).toBeVisible();
    expect(status()).toHaveTextContent("Adding the video…");
    await user.click(cancel);
    expect(bridge.videoImportCancel).toHaveBeenCalledTimes(1);
    expect(status()).toHaveTextContent("Cancelling…");
    expect(cancel).toBeDisabled();
    act(() => done.finish({ result: "cancelled" }));
    await vi.waitFor(() =>
      expect(status()).toHaveTextContent("Cancelled. Nothing was added."),
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(add).toBeEnabled();
    await vi.waitFor(() => expect(add).toHaveFocus());
  });

  it("changes what it says only when the stage changes, never with the percentage", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const done = later<VideoImportResult>();
    const bridge = bridgeFor(done.promise);
    let at = 0;
    bridge.videoImportProgress.mockImplementation(async () => {
      at += 10;
      return { stage: "storing", doneBytes: Math.min(at, 90), totalBytes: 100 };
    });
    renderAdd(bridge);
    // Every text the status line takes, in order.
    const said: string[] = [];
    const watcher = new MutationObserver(() => {
      const text = status().textContent ?? "";
      if (said[said.length - 1] !== text) said.push(text);
    });
    watcher.observe(status(), {
      childList: true,
      characterData: true,
      subtree: true,
    });
    await user.click(screen.getByRole("button", { name: "Add a video" }));
    // Several polls go by, each with a higher percentage.
    await vi.waitFor(
      () =>
        expect(bridge.videoImportProgress.mock.calls.length).toBeGreaterThan(4),
      {
        timeout: 6000,
      },
    );
    act(() => done.finish({ result: "duplicate" }));
    await vi.waitFor(() =>
      expect(status()).toHaveTextContent("That video is already here."),
    );
    watcher.disconnect();
    // Not one line for each percentage: the stages only, and the answer.
    expect(said.filter((text) => /\d/.test(text))).toEqual([]);
    expect(said.length).toBeLessThanOrEqual(4);
    expect(said).toContain("Adding the video…");
  });

  it("reports a failure in the vault's own words on the alert line and lets the patient try again", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const bridge = bridgeFor({ result: "duplicate" });
    bridge.importPickedVideo.mockRejectedValue({ code: "no_space" });
    renderAdd(bridge);
    const add = screen.getByRole("button", { name: "Add a video" });
    await user.click(add);
    await vi.waitFor(() =>
      expect(alert().textContent?.length).toBeGreaterThan(10),
    );
    expect(add).toBeEnabled();
  });

  it("is turned off by the library when it cannot add (read-only, no person)", () => {
    render(
      <AddVideo
        bridge={bridgeFor({ result: "duplicate" })}
        profileId="person-1"
        folderIds={[]}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Add a video" })).toBeDisabled();
  });
});

describe("Add a video: one state, shown once, kept when the screen goes", () => {
  function Host({
    bridge,
    onAdded,
    menus = 1,
  }: {
    bridge: AddVideoBridge;
    onAdded: (id: string) => void;
    menus?: number;
  }) {
    const add = useAddVideo({ bridge, onAdded });
    const [shown, setShown] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setShown((now) => !now)}>
          Go to Security
        </button>
        {shown && (
          <section aria-label="Library">
            {Array.from({ length: menus }, (_, index) => (
              <AddVideoButton
                key={index}
                add={add}
                profileId="person-1"
                folderIds={[]}
              />
            ))}
            <AddVideoStatus add={add} />
          </section>
        )}
      </>
    );
  }

  it("renders the status line once and gives each Add button an id of its own, with two menus on screen", () => {
    setLocaleOverride("en");
    render(
      <Host
        bridge={bridgeFor({ result: "duplicate" })}
        onAdded={vi.fn()}
        menus={2}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Add a video" });
    expect(buttons).toHaveLength(2);
    for (const button of buttons)
      expect(button).toHaveAccessibleDescription(/the device's name and model/);
    const hints = buttons.map((button) =>
      button.getAttribute("aria-describedby"),
    );
    expect(new Set(hints).size).toBe(2);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps the progress, the Cancel and the answer when the library is left mid-import, and still tells the library", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const done = later<VideoImportResult>();
    const bridge = bridgeFor(done.promise);
    bridge.videoImportProgress.mockResolvedValue({
      stage: "storing",
      doneBytes: 30,
      totalBytes: 100,
    });
    const onAdded = vi.fn();
    render(<Host bridge={bridge} onAdded={onAdded} />);
    await user.click(screen.getByRole("button", { name: "Add a video" }));
    await screen.findByRole("group", { name: "Adding the video" });
    // To Security, and the library's screen is gone.
    await user.click(screen.getByRole("button", { name: "Go to Security" }));
    expect(screen.queryByRole("group")).toBeNull();
    expect(bridge.videoImportCancel).not.toHaveBeenCalled();
    // Back: the bar is there, still running, and no focus was taken from the patient.
    await user.click(screen.getByRole("button", { name: "Go to Security" }));
    const group = await screen.findByRole("group", {
      name: "Adding the video",
    });
    const cancel = within(group).getByRole("button", { name: "Cancel" });
    expect(cancel).not.toHaveFocus();
    await user.click(cancel);
    expect(bridge.videoImportCancel).toHaveBeenCalledTimes(1);
    // The import ends while the library is away again: the answer waits for the return.
    await user.click(screen.getByRole("button", { name: "Go to Security" }));
    act(() => done.finish({ result: "imported", recordId: "record-4" }));
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith("record-4"));
    await user.click(screen.getByRole("button", { name: "Go to Security" }));
    await vi.waitFor(() =>
      expect(status()).toHaveTextContent("The video was added."),
    );
    expect(onAdded).toHaveBeenCalledTimes(1);
  });
});

describe("useAddVideo, by itself", () => {
  it("runs one import at a time and reports each state in turn", async () => {
    const done = later<VideoImportResult>();
    const bridge = bridgeFor(done.promise);
    const onAdded = vi.fn();
    const { result } = renderHook(() => useAddVideo({ bridge, onAdded }));
    expect(result.current.canAdd).toBe(true);
    expect(result.current.working).toBe(false);
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.start("person-1", []);
    });
    await vi.waitFor(() => expect(result.current.working).toBe(true));
    // A second start while one runs does nothing.
    await act(async () => {
      await result.current.start("person-1", []);
    });
    expect(bridge.pickImportVideo).toHaveBeenCalledTimes(1);
    act(() => result.current.cancel());
    expect(result.current.cancelling).toBe(true);
    expect(bridge.videoImportCancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      done.finish({ result: "cancelled" });
      await first;
    });
    expect(result.current.working).toBe(false);
    expect(result.current.outcome).toEqual({ kind: "cancelled" });
    expect(onAdded).not.toHaveBeenCalled();
    // The next start clears the last answer.
    const again = bridgeFor({ result: "imported", recordId: "r1" });
    const second = renderHook(() => useAddVideo({ bridge: again, onAdded }));
    await act(async () => {
      await second.result.current.start("person-1", ["f"]);
    });
    expect(second.result.current.outcome).toEqual({ kind: "added" });
    expect(onAdded).toHaveBeenCalledWith("r1");
  });

  it("forgets everything on reset (the vault locked): a late failure of the stopped import and a stale answer do not show after the next unlock", async () => {
    let fail: (reason: unknown) => void = () => undefined;
    const stopped = new Promise<VideoImportResult>((_resolve, reject) => {
      fail = reject;
    });
    const bridge = bridgeFor(stopped);
    const { result } = renderHook(() => useAddVideo({ bridge }));
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.start("person-1", []);
    });
    await vi.waitFor(() => expect(result.current.working).toBe(true));
    // The lock: the screens reset the state, and the import, stopped natively, ends in failure.
    act(() => result.current.reset());
    expect(result.current.working).toBe(false);
    await act(async () => {
      fail({ code: "locked" });
      await first;
    });
    expect(result.current.outcome).toBeNull();
    expect(result.current.working).toBe(false);
    // After the unlock a new import is taken and reports as usual.
    bridge.importPickedVideo.mockResolvedValueOnce({
      result: "imported",
      recordId: "r2",
    });
    await act(async () => {
      await result.current.start("person-1", []);
    });
    expect(result.current.outcome).toEqual({ kind: "added" });
    // And a finished import's answer does not outlive a lock either.
    act(() => result.current.reset());
    expect(result.current.outcome).toBeNull();
  });

  it("shows no alert and no status after a lock and an unlock, with the screen on", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const stopped = later<VideoImportResult>();
    const bridge = bridgeFor(stopped.promise);
    bridge.importPickedVideo.mockImplementation(() =>
      stopped.promise.then(() => {
        throw { code: "locked" };
      }),
    );
    function Locking() {
      const add = useAddVideo({ bridge });
      return (
        <>
          <AddVideoButton add={add} profileId="p" folderIds={[]} />
          <AddVideoStatus add={add} />
          <button type="button" onClick={add.reset}>
            Lock
          </button>
        </>
      );
    }
    render(<Locking />);
    await user.click(screen.getByRole("button", { name: "Add a video" }));
    await screen.findByRole("group", { name: "Adding the video" });
    await user.click(screen.getByRole("button", { name: "Lock" }));
    expect(screen.queryByRole("group")).toBeNull();
    act(() => stopped.finish({ result: "duplicate" }));
    // Time for the stopped import to end in its failure; nothing of it is shown.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alert()).toBeEmptyDOMElement();
    expect(status()).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Add a video" })).toBeEnabled();
  });

  it("cannot add on a bridge without the video methods, and says nothing then", async () => {
    const { result } = renderHook(() => useAddVideo({ bridge: {} }));
    expect(result.current.canAdd).toBe(false);
    await act(async () => {
      await result.current.start("person-1", []);
    });
    expect(result.current.working).toBe(false);
    expect(result.current.outcome).toBeNull();
  });
});

describe("Add a video in every language", () => {
  for (const locale of LOCALES) {
    it(`speaks ${locale}: the button, the stages and every refusal`, () => {
      setLocaleOverride(locale);
      render(
        <AddVideo
          bridge={bridgeFor({ result: "duplicate" })}
          profileId="person-1"
          folderIds={[]}
        />,
      );
      expect(
        screen.getByRole("button", {
          name: translate(locale, "interface.AddVideo.add"),
        }),
      ).toBeVisible();
      for (const key of [
        "interface.AddVideo.notVideo",
        "interface.AddVideo.hevc",
        "interface.AddVideo.videoCodec",
        "interface.AddVideo.audioCodec",
        "interface.AddVideo.noVideo",
        "interface.AddVideo.tooManyTracks",
        "interface.AddVideo.external",
        "interface.AddVideo.fragmented",
        "interface.AddVideo.tooBig",
        "interface.AddVideo.tooLarge",
        "interface.AddVideo.damaged",
        "interface.AddVideo.checking",
        "interface.AddVideo.adding",
        "interface.AddVideo.cancelling",
        "interface.AddVideo.added",
        "interface.AddVideo.duplicate",
        "interface.AddVideo.cancelled",
        "interface.AddVideo.cancel",
        "interface.AddVideo.hint",
        "interface.AddVideo.progressLabel",
      ] as const) {
        const text = translate(locale, key);
        expect(text.length).toBeGreaterThan(1);
        expect(text).not.toContain("interface.AddVideo");
      }
    });
  }
});
