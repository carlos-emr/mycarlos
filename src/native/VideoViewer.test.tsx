import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { Icon } from "../Icon";
import { LOCALES, setLocaleOverride } from "../i18n";
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
    // Stuck waiting for data is not playing either; it says so again when it
    // goes on. `stalled` can fire while it still plays from its buffer: not
    // the same.
    fireEvent(video, new Event("waiting"));
    fireEvent(video, new Event("playing"));
    fireEvent(video, new Event("stalled"));
    expect(onPlaying.mock.calls.map(([playing]) => playing)).toEqual([
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

  it("names every key on a button, and has no accessibility violations", async () => {
    open();
    const group = screen.getByRole("group", { name: "Player controls" });
    const labels = within(group)
      .getAllByRole("button")
      .map((button) => visibleText(button.textContent ?? ""));
    // No button for the arrows' 5 s skip (the keys still do it, below): only the 10 s buttons.
    expect(labels).toEqual([
      "Play/Pause (k)",
      "Back 10 s (j)",
      "Forward 10 s (l)",
      "Volume up (↑)",
      "Volume down (↓)",
      "Mute (m)",
      "To the start (Home)",
      "To the end (End)",
    ]);
    // Each button announces its key too, as its own shortcut.
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-keyshortcuts")),
    ).toEqual([
      "k Space",
      "j",
      "l",
      "ArrowUp",
      "ArrowDown",
      "m",
      "Home",
      "End",
    ]);
    // The arrows' skip has no button, so a line says it (and the keys themselves work: see the
    // keyboard test). Nothing else claims a key the buttons do not have.
    expect(
      screen.getByText(humanText("The ← and → keys skip 5 s")),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /5 s/ }),
      "no 5 second button",
    ).toBeNull();
    expect(await axe.run(document.body, AXE)).toHaveProperty("violations", []);
  });

  it("puts an icon on every button, drawing only, and keeps the visible label as the name", () => {
    open();
    const group = screen.getByRole("group", { name: "Player controls" });
    for (const button of within(group).getAllByRole("button")) {
      const icons = button.querySelectorAll("svg.icon");
      expect(icons, button.textContent ?? "").toHaveLength(1);
      expect(icons[0].getAttribute("aria-hidden")).toBe("true");
      // The label is the visible text, which is also the accessible name: the icon adds none.
      expect(visibleText(button.textContent ?? "")).not.toBe("");
    }
    // Four groups: playback, skip, volume, jump.
    expect(
      Array.from(group.querySelectorAll(".video-control-group")).map(
        (part) => part.querySelectorAll("button").length,
      ),
    ).toEqual([1, 2, 3, 2]);
  });

  it("shows Pause while playing and Play while not, and Unmute while muted, from the video's own events", () => {
    const { video } = open();
    const drawn = (name: "play" | "pause" | "volume" | "volume-off") =>
      render(<Icon name={name} />).container.innerHTML;
    const iconOf = (label: string) =>
      screen
        .getByRole("button", { name: humanText(label) })
        .querySelector("svg.icon")!.outerHTML;
    expect(iconOf("Play/Pause (k)")).toBe(drawn("play"));
    fireEvent.play(video);
    expect(iconOf("Play/Pause (k)")).toBe(drawn("pause"));
    fireEvent.pause(video);
    expect(iconOf("Play/Pause (k)")).toBe(drawn("play"));
    fireEvent.play(video);
    fireEvent.ended(video);
    expect(iconOf("Play/Pause (k)")).toBe(drawn("play"));
    // The mute button's icon is what pressing it does, as its label says.
    expect(iconOf("Mute (m)")).toBe(drawn("volume-off"));
    video.muted = true;
    fireEvent(video, new Event("volumechange"));
    expect(iconOf("Unmute (m)")).toBe(drawn("volume"));
  });

  it("works with the focus on any control of the player, not only on the video", () => {
    const { video, time } = open();
    const playButton = screen.getByRole("button", { name: "Play/Pause (k)" });
    playButton.focus();
    for (const [name, expected] of [
      ["ArrowRight", 30 + SKIP_SECONDS],
      ["ArrowLeft", 30],
      ["l", 30 + BIG_SKIP_SECONDS],
      ["j", 30],
    ] as const) {
      fireEvent.keyDown(playButton, { key: name });
      expect(time()).toBe(expected);
    }
    fireEvent.keyDown(playButton, { key: "k" });
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), {
      key: "m",
    });
    expect(video.muted).toBe(true);
    // A key handled here is not also handled by the button it came from.
    const clicked = vi.fn();
    playButton.addEventListener("click", clicked);
    fireEvent.keyDown(playButton, { key: "k" });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("leaves Space and Enter on a focused button to that button alone: one press, one action", () => {
    const { video } = open();
    const playButton = screen.getByRole("button", { name: "Play/Pause (k)" });
    for (const key of [" ", "Enter"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      playButton.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(play).not.toHaveBeenCalled();
    // The button's own action, once.
    fireEvent.click(playButton);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(true);
  });

  it("never acts on a key typed in a text field, or outside the player", () => {
    const { video, time } = open();
    const field = document.createElement("input");
    screen.getByRole("dialog").appendChild(field);
    field.focus();
    for (const key of [" ", "k", "m", "ArrowRight", "j", "Home"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      field.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(play).not.toHaveBeenCalled();
    expect(video.muted).toBe(false);
    expect(time()).toBe(30);
    // Single-key shortcuts belong to the focused player and nothing wider (WCAG 2.1.4).
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "m" });
    expect(play).not.toHaveBeenCalled();
    expect(video.muted).toBe(false);
  });

  it("has a button for each key that does what the key does", () => {
    const { video, time } = open();
    const press = (name: string) =>
      fireEvent.click(screen.getByRole("button", { name: humanText(name) }));
    press("Play/Pause (k)");
    expect(play).toHaveBeenCalledTimes(1);
    Object.defineProperty(video, "paused", {
      configurable: true,
      value: false,
    });
    press("Play/Pause (k)");
    expect(pause).toHaveBeenCalledTimes(1);
    press("Forward 10 s (l)");
    expect(time()).toBe(30 + BIG_SKIP_SECONDS);
    press("Back 10 s (j)");
    expect(time()).toBe(30);
    press("To the end (End)");
    expect(time()).toBe(100);
    press("To the start (Home)");
    expect(time()).toBe(0);
    video.volume = 0.5;
    press("Volume up (↑)");
    expect(video.volume).toBeCloseTo(0.6);
    press("Volume down (↓)");
    press("Volume down (↓)");
    expect(video.volume).toBeCloseTo(0.4);
    press("Mute (m)");
    expect(video.muted).toBe(true);
    // The button says what it will do next.
    fireEvent(video, new Event("volumechange"));
    press("Unmute (m)");
    expect(video.muted).toBe(false);
  });

  it("says Unmute or Mute from the video's real state, not from counting its own presses", () => {
    const { video } = open();
    const mute = () =>
      screen.getByRole("button", { name: humanText("Mute (m)") });
    expect(mute()).toBeVisible();
    // Muted by something other than the button (the browser's own control, say).
    video.muted = true;
    fireEvent(video, new Event("volumechange"));
    expect(
      screen.getByRole("button", { name: humanText("Unmute (m)") }),
    ).toBeVisible();
    // A volume change that leaves it muted does not flip the label back.
    fireEvent(video, new Event("volumechange"));
    expect(
      screen.getByRole("button", { name: humanText("Unmute (m)") }),
    ).toBeVisible();
    video.muted = false;
    fireEvent(video, new Event("volumechange"));
    expect(mute()).toBeVisible();
  });

  it("stops the page from also acting on a key the player handled (a phone's dialog scrolls)", () => {
    const { video } = open();
    for (const key of [" ", "k", "ArrowLeft", "m"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      video.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(true);
    }
    // A key it does not handle is left alone.
    const other = new KeyboardEvent("keydown", {
      key: "x",
      bubbles: true,
      cancelable: true,
    });
    video.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("keeps the focus in the player after Play, even where the click took it away", () => {
    const { video } = open();
    const playButton = screen.getByRole("button", { name: "Play/Pause (k)" });
    // The focus is on the play button: it stays there.
    playButton.focus();
    fireEvent.play(video);
    expect(playButton).toHaveFocus();
    // The focus went to the page behind it: it comes back into the player.
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    fireEvent.play(video);
    expect(video).toHaveFocus();
  });

  it("is in the patient's language", () => {
    setLocaleOverride("es");
    open();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeVisible();
    expect(screen.getByText("Video")).toBeVisible();
    // The buttons say their keys in the patient's language too.
    expect(screen.getByRole("button", { name: "Silenciar (m)" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: humanText("Retroceder 10 s (j)") }),
    ).toBeVisible();
    // The arrows' skip is said in the patient's language too (it has no button).
    expect(
      screen.getByText(humanText("Las teclas ← y → saltan 5 s")),
    ).toBeVisible();
  });

  // The row under the video, in every language, on the narrowest phone (WCAG 1.4.10) and on a
  // desktop: nothing past the edge or its own box, a target that is at least 44 px tall, the same
  // gap between buttons of a group, and one wider gap, the same everywhere, between groups.
  for (const locale of LOCALES) {
    for (const [width, height] of [
      [320, 640],
      [1100, 760],
    ] as const) {
      it(`lays the control row out evenly, in groups, at ${width} px in ${locale}`, async () => {
        await page.viewport(width, height);
        try {
          setLocaleOverride(locale);
          open();
          const row = document.querySelector<HTMLElement>(".video-controls")!;
          const groups = Array.from(
            row.querySelectorAll<HTMLElement>(".video-control-group"),
          );
          expect(groups).toHaveLength(4);
          expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
          const near = (a: number, b: number, why: string) =>
            expect(Math.abs(a - b), why).toBeLessThanOrEqual(1);
          const buttonsOf = (group: HTMLElement) =>
            Array.from(group.querySelectorAll<HTMLElement>("button"));
          for (const button of groups.flatMap(buttonsOf)) {
            const box = button.getBoundingClientRect();
            const name = button.textContent ?? "";
            expect(box.left, name).toBeGreaterThanOrEqual(-1);
            expect(box.right, name).toBeLessThanOrEqual(width + 1);
            expect(box.height, name).toBeGreaterThanOrEqual(43.5);
            expect(button.scrollWidth, name).toBeLessThanOrEqual(
              button.clientWidth + 1,
            );
          }
          // Inside a group: 8 px between neighbours, along a row and down a wrapped one.
          for (const group of groups) {
            const boxes = buttonsOf(group).map((b) =>
              b.getBoundingClientRect(),
            );
            for (let at = 1; at < boxes.length; at++) {
              const [before, after] = [boxes[at - 1], boxes[at]];
              if (Math.abs(after.top - before.top) < 2)
                near(after.left - before.right, 8, "gap in a group row");
              else
                near(after.top - before.bottom, 8, "gap between wrapped rows");
            }
          }
          // Between groups: 24 px along a row, 12 px between wrapped rows.
          const parts = groups.map((g) => g.getBoundingClientRect());
          for (let at = 1; at < parts.length; at++) {
            const [before, after] = [parts[at - 1], parts[at]];
            if (Math.abs(after.top - before.top) < 2)
              near(after.left - before.right, 24, "gap between groups");
            else near(after.top - before.bottom, 12, "gap between group rows");
          }
          const hint =
            row.parentElement!.querySelector<HTMLElement>(".video-key-hint")!;
          expect(hint.getBoundingClientRect().right).toBeLessThanOrEqual(
            width + 1,
          );
          expect(hint.scrollWidth).toBeLessThanOrEqual(hint.clientWidth + 1);
        } finally {
          await page.viewport(1100, 760);
        }
      });
    }
  }
});
