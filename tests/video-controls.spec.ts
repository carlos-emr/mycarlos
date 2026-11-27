import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import { fakeCalls, fakeVaultWith, openDetails } from "./support/vaultFake";

// The buttons under a video (#359): one icon each, in four groups (playback, skip, volume, jump),
// no button for the arrows' 5 s skip (the keys still do it, and a line says so), the 10 s buttons
// and the J and L keys, play/pause and mute drawn from the video's own state. The journey a
// patient takes: open the document's details, press Play video, use the buttons and the keys,
// close.
//
// The native side is faked (support/vaultFake.ts), and so is what a browser cannot do here: the
// fake vault holds no video file, and a headless Chromium cannot decode the vault's MP4 anyway.
// So this spec gives the media element a clock of its own (a hundred seconds, now at 30) and keeps
// the address's failed load from reaching the page. It checks the real component, its icons, its
// layout and its keys; whether real frames play on a real device is the installed app's journey.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const VIDEO = "FAKE Video, Oct 6, 2026.mp4";
const PLAY = "M8 5v14l11-7Z";
const PAUSE = "M9 6v12M15 6v12";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const clocks = new WeakMap<
      HTMLMediaElement,
      { time: number; paused: boolean }
    >();
    const clock = (element: HTMLMediaElement) => {
      let state = clocks.get(element);
      if (!state) {
        state = { time: 30, paused: true };
        clocks.set(element, state);
      }
      return state;
    };
    const media = HTMLMediaElement.prototype;
    Object.defineProperty(media, "duration", {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(media, "currentTime", {
      configurable: true,
      get() {
        return clock(this as HTMLMediaElement).time;
      },
      set(value: number) {
        clock(this as HTMLMediaElement).time = value;
      },
    });
    Object.defineProperty(media, "paused", {
      configurable: true,
      get() {
        return clock(this as HTMLMediaElement).paused;
      },
    });
    media.play = function (this: HTMLMediaElement) {
      clock(this).paused = false;
      this.dispatchEvent(new Event("play"));
      this.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    };
    media.pause = function (this: HTMLMediaElement) {
      if (clock(this).paused) return;
      clock(this).paused = true;
      this.dispatchEvent(new Event("pause"));
    };
    // The address plays nothing here: its failed load must not close the controls.
    document.addEventListener(
      "error",
      (event) => {
        if (event.target instanceof HTMLVideoElement)
          event.stopImmediatePropagation();
      },
      true,
    );
  });
});

const viewer = (page: Page) => page.locator("section.video-viewer");
const controls = (page: Page) =>
  viewer(page).getByRole("group", {
    name: en("interface.VideoViewer.controls"),
  });
const button = (page: Page, name: string) =>
  controls(page).getByRole("button", { name, exact: true });
const clockOf = (page: Page) =>
  page.evaluate(() => document.querySelector("video")!.currentTime);
const iconOf = (page: Page, name: string) =>
  button(page, name).locator("svg.icon path").first().getAttribute("d");

async function openViewer(page: Page) {
  await fakeVaultWith(page, { start: "unlocked", videos: [VIDEO] });
  await page.goto("/");
  const details = await openDetails(page, VIDEO);
  await details
    .getByRole("button", {
      name: en("interface.VideoViewer.playVideo"),
      exact: true,
    })
    .click();
  await expect(viewer(page)).toBeVisible();
  await expect(controls(page)).toBeVisible();
}

test("the buttons have an icon each, in four groups, and no button for the 5 s skip", async ({
  page,
}) => {
  await openViewer(page);
  const labels = [
    en("interface.VideoViewer.playPause"),
    en("interface.VideoViewer.backBig", { seconds: 10 }),
    en("interface.VideoViewer.forwardBig", { seconds: 10 }),
    en("interface.VideoViewer.volumeUp"),
    en("interface.VideoViewer.volumeDown"),
    en("interface.VideoViewer.mute"),
    en("interface.VideoViewer.start"),
    en("interface.VideoViewer.end"),
  ];
  const all = controls(page).getByRole("button");
  await expect(all).toHaveCount(labels.length);
  for (const label of labels) {
    const one = button(page, label);
    await expect(one).toBeVisible();
    // One drawing, hidden from screen readers; the visible label is the name.
    await expect(one.locator("svg.icon")).toHaveCount(1);
    await expect(one.locator("svg.icon")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  }
  // The groups: playback 1, skip 2, volume 3, jump 2.
  expect(
    await controls(page)
      .locator(".video-control-group")
      .evaluateAll((groups) =>
        groups.map((group) => group.querySelectorAll("button").length),
      ),
  ).toEqual([1, 2, 3, 2]);
  // No 5 s button, and the line that says the arrows skip 5 s.
  await expect(
    controls(page).getByRole("button", { name: /\b5 s\b/ }),
  ).toHaveCount(0);
  // The line is for a keyboard: a screen that is only touch (a phone or tablet) hides it, because
  // the 5 s step is a key and a touch user has the 10 s buttons and the scrubber.
  const touchOnly = await page.evaluate(
    () => matchMedia("(pointer: coarse) and (hover: none)").matches,
  );
  const hint = viewer(page).getByText(
    en("interface.VideoViewer.arrowKeys", { seconds: 5 }),
  );
  if (touchOnly) await expect(hint).toBeHidden();
  else await expect(hint).toBeVisible();
  await expectNoAxeViolations(page, "the video viewer's buttons");
});

test("play and pause, the 10 s buttons, the keys and mute do what they say, with the icons following the state", async ({
  page,
}) => {
  await openViewer(page);
  const playPause = en("interface.VideoViewer.playPause");
  // Not playing: the button draws Play; pressed, the video plays and it draws Pause.
  expect(await iconOf(page, playPause)).toBe(PLAY);
  await button(page, playPause).click();
  await expect.poll(() => iconOf(page, playPause)).toBe(PAUSE);
  await button(page, playPause).click();
  await expect.poll(() => iconOf(page, playPause)).toBe(PLAY);

  // The 10 s buttons move the clock by ten seconds, and J and L do the same.
  expect(await clockOf(page)).toBe(30);
  await button(
    page,
    en("interface.VideoViewer.forwardBig", { seconds: 10 }),
  ).click();
  expect(await clockOf(page)).toBe(40);
  await button(
    page,
    en("interface.VideoViewer.backBig", { seconds: 10 }),
  ).click();
  expect(await clockOf(page)).toBe(30);
  await page.locator("video").focus();
  await page.keyboard.press("l");
  expect(await clockOf(page)).toBe(40);
  await page.keyboard.press("j");
  expect(await clockOf(page)).toBe(30);
  // The arrows still skip 5 s, though they have no button.
  await page.keyboard.press("ArrowRight");
  expect(await clockOf(page)).toBe(35);
  await page.keyboard.press("ArrowLeft");
  expect(await clockOf(page)).toBe(30);
  // Start and end.
  await button(page, en("interface.VideoViewer.end")).click();
  expect(await clockOf(page)).toBe(100);
  await button(page, en("interface.VideoViewer.start")).click();
  expect(await clockOf(page)).toBe(0);

  // Mute: the button says what it will do next, and its icon changes with it.
  // (Both speaker drawings begin with the same body path: compare the whole drawing.)
  const drawing = (label: string) =>
    button(page, label).locator("svg.icon").innerHTML();
  const muteIcon = await drawing(en("interface.VideoViewer.mute"));
  await button(page, en("interface.VideoViewer.mute")).click();
  const unmute = button(page, en("interface.VideoViewer.unmute"));
  await expect(unmute).toBeVisible();
  expect(await drawing(en("interface.VideoViewer.unmute"))).not.toBe(muteIcon);
  await unmute.click();
  await expect(button(page, en("interface.VideoViewer.mute"))).toBeVisible();
  await expectNoAxeViolations(page, "the video viewer after using its buttons");

  // Closing lets the video go.
  await viewer(page)
    .getByRole("button", { name: en("photo.close"), exact: true })
    .click();
  await expect(viewer(page)).toHaveCount(0);
  expect(await fakeCalls(page, "vault_video_close")).toHaveLength(1);
  await expectOnlyFakedCommands(page);
});

test("the row is laid out evenly and stays inside the screen, on this device's width", async ({
  page,
}) => {
  await openViewer(page);
  const width = await page.evaluate(() => window.innerWidth);
  const layout = await page.evaluate(() => {
    const boxes = (selector: string, within: ParentNode = document) =>
      Array.from(within.querySelectorAll<HTMLElement>(selector)).map(
        (element) => {
          const box = element.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            bottom: box.bottom,
            overflow: element.scrollWidth - element.clientWidth,
          };
        },
      );
    const row = document.querySelector<HTMLElement>(".video-controls")!;
    return {
      pageOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      rowOverflow: row.scrollWidth - row.clientWidth,
      groups: boxes(".video-control-group", row),
      buttons: boxes(".video-control-group button", row),
      perGroup: Array.from(row.querySelectorAll(".video-control-group")).map(
        (group) => boxes("button", group),
      ),
    };
  });
  // Nothing sideways, and every button inside the screen, tall enough to touch, whole.
  expect(layout.pageOverflow).toBeLessThanOrEqual(1);
  expect(layout.rowOverflow).toBeLessThanOrEqual(1);
  for (const box of layout.buttons) {
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(width + 1);
    expect(box.bottom - box.top).toBeGreaterThanOrEqual(43.5);
    expect(box.overflow).toBeLessThanOrEqual(1);
  }
  // 8 px between the buttons of a group (along a row or down a wrapped one).
  for (const group of layout.perGroup)
    for (let at = 1; at < group.length; at++) {
      const [before, after] = [group[at - 1], group[at]];
      const gap =
        Math.abs(after.top - before.top) < 2
          ? after.left - before.right
          : after.top - before.bottom;
      expect(Math.abs(gap - 8)).toBeLessThanOrEqual(1);
    }
  // 24 px between groups along a row, 12 px between wrapped rows of groups.
  for (let at = 1; at < layout.groups.length; at++) {
    const [before, after] = [layout.groups[at - 1], layout.groups[at]];
    const sameRow = Math.abs(after.top - before.top) < 2;
    const gap = sameRow ? after.left - before.right : after.top - before.bottom;
    expect(Math.abs(gap - (sameRow ? 24 : 12))).toBeLessThanOrEqual(1);
  }
});
