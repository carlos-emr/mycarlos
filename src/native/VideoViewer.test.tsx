import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText, visibleText } from "../test/humanText";
import { BIG_SKIP_SECONDS, SKIP_SECONDS, VideoViewer } from "./VideoViewer";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};
const URL = "mycarlos-video://localhost/" + "0".repeat(64);

let play: ReturnType<typeof vi.spyOn>;
let pause: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  setLocaleOverride("en");
  // Nothing real plays: the element's own methods are watched, not run.
  play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
  pause = vi
    .spyOn(HTMLMediaElement.prototype, "pause")
    .mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined,
  );
});
afterEach(() => vi.restoreAllMocks());

function open(onPlaying = vi.fn(), onClose = vi.fn()) {
  const view = render(
    <VideoViewer
      name="FAKE Video, 20 Nov 2026, 3.05 PM.mp4"
      url={URL}
      onPlaying={onPlaying}
      onClose={onClose}
    />,
  );
  const video = view.container.ownerDocument.querySelector("video")!;
  // The element's clock, which a real file would supply.
  let time = 30;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  Object.defineProperty(video, "duration", {
    configurable: true,
    get: () => 100,
  });
  return { ...view, video, onPlaying, onClose, time: () => time };
}

describe("VideoViewer", () => {
  it("never plays by itself and never repeats, with the player's own controls", () => {
    const { video } = open();
    expect(video.autoplay).toBe(false);
    expect(video.loop).toBe(false);
    expect(video.controls).toBe(true);
    expect(video.preload).toBe("metadata");
    expect(video.getAttribute("src")).toBe(URL);
    expect(play).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "FAKE Video, 20 Nov 2026, 3.05 PM.mp4",
      }),
    ).toBeVisible();
    expect(visibleText(video.getAttribute("aria-label") ?? "")).toBe(
      "Video player: FAKE Video, 20 Nov 2026, 3.05 PM.mp4",
    );
  });

  it("is played from the keyboard: space, arrows, J and L, volume, mute, home and end", () => {
    const { video, time } = open();
    const key = (name: string, target: Element = video) =>
      fireEvent.keyDown(target, { key: name });
    key(" ");
    expect(play).toHaveBeenCalledTimes(1);
    Object.defineProperty(video, "paused", {
      configurable: true,
      value: false,
    });
    key(" ");
    expect(pause).toHaveBeenCalledTimes(1);
    key("k");
    expect(pause).toHaveBeenCalledTimes(2);
    key("ArrowRight");
    expect(time()).toBe(30 + SKIP_SECONDS);
    key("ArrowLeft");
    expect(time()).toBe(30);
    key("l");
    expect(time()).toBe(30 + BIG_SKIP_SECONDS);
    key("j");
    expect(time()).toBe(30);
    key("Home");
    expect(time()).toBe(0);
    key("ArrowLeft"); // never before the start
    expect(time()).toBe(0);
    key("End");
    expect(time()).toBe(100);
    key("ArrowRight"); // never past the end
    expect(time()).toBe(100);
    video.volume = 0.5;
    key("ArrowUp");
    expect(video.volume).toBeCloseTo(0.6);
    key("ArrowDown");
    key("ArrowDown");
    expect(video.volume).toBeCloseTo(0.4);
    key("m");
    expect(video.muted).toBe(true);
    key("M");
    expect(video.muted).toBe(false);
  });

  it("leaves a button its own keys and ignores shortcuts that carry a modifier", () => {
    const { video } = open();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), {
      key: " ",
    });
    expect(play).not.toHaveBeenCalled();
    fireEvent.keyDown(video, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(video, { key: " ", altKey: true });
    expect(play).not.toHaveBeenCalled();
  });

  it("says it is playing only while it actually is, not while paused or buffering", () => {
    const { video, onPlaying } = open();
    fireEvent(video, new Event("waiting"));
    fireEvent(video, new Event("progress"));
    fireEvent(video, new Event("canplay"));
    expect(onPlaying).not.toHaveBeenCalled();
    fireEvent(video, new Event("playing"));
    fireEvent(video, new Event("playing"));
    expect(onPlaying.mock.calls).toEqual([[true]]);
    // Stuck waiting for data is not playing either; it says so again when it goes on.
    fireEvent(video, new Event("waiting"));
    fireEvent(video, new Event("playing"));
    fireEvent(video, new Event("stalled"));
    fireEvent(video, new Event("playing"));
    expect(onPlaying.mock.calls.map(([playing]) => playing)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    onPlaying.mockClear();
    fireEvent(video, new Event("pause"));
    expect(onPlaying.mock.calls).toEqual([[false]]);
    onPlaying.mockClear();
    fireEvent(video, new Event("playing"));
    fireEvent(video, new Event("ended"));
    expect(onPlaying.mock.calls).toEqual([[true], [false]]);
  });

  it("lets go of the lock and drops its address when it closes while playing (a lock closes it)", () => {
    const { video, onPlaying, unmount } = open();
    fireEvent(video, new Event("playing"));
    unmount();
    expect(onPlaying).toHaveBeenLastCalledWith(false);
    // Nothing is left asking the vault for more.
    expect(video.getAttribute("src")).toBeNull();
    expect(pause).toHaveBeenCalled();
  });

  it("keeps its address and its video when the library draws it again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <VideoViewer
        name="FAKE.mp4"
        url={URL}
        onPlaying={first}
        onClose={vi.fn()}
      />,
    );
    const video = view.container.ownerDocument.querySelector("video")!;
    // The library draws again with a new function each time.
    view.rerender(
      <VideoViewer
        name="FAKE.mp4"
        url={URL}
        onPlaying={second}
        onClose={vi.fn()}
      />,
    );
    view.rerender(
      <VideoViewer
        name="FAKE.mp4"
        url={URL}
        onPlaying={second}
        onClose={vi.fn()}
      />,
    );
    expect(video.getAttribute("src")).toBe(URL);
    expect(pause).not.toHaveBeenCalled();
    // The newest callback is the one told.
    fireEvent(video, new Event("playing"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(true);
    view.unmount();
    expect(video.getAttribute("src")).toBeNull();
    expect(second).toHaveBeenLastCalledWith(false);
  });

  it("is not left blank by React's development double mount", () => {
    const view = render(
      <StrictMode>
        <VideoViewer name="FAKE.mp4" url={URL} onClose={vi.fn()} />
      </StrictMode>,
    );
    const video = view.container.ownerDocument.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(URL);
  });

  it("closes on Escape and on its button", () => {
    const { onClose } = open();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("says when the video cannot be played", () => {
    const { video, onPlaying } = open();
    fireEvent(video, new Event("playing"));
    fireEvent(video, new Event("error"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This video could not be played.",
    );
    expect(onPlaying).toHaveBeenLastCalledWith(false);
  });

  it("explains its keys and has no accessibility violations", async () => {
    open();
    expect(
      screen.getByText(
        humanText(
          /Space plays or pauses\. Left and right arrows skip 5 seconds/,
        ),
      ),
    ).toBeVisible();
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
  });

  it("is in the patient's language", () => {
    setLocaleOverride("es");
    open();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeVisible();
    expect(screen.getByText("Video")).toBeVisible();
  });
});
