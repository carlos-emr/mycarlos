import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import { fakeCalls, fakeVaultWith } from "./support/vaultFake";

// The microphone test in the video recorder: "Test microphone" takes about three seconds from the
// microphone the preview has open, plays it back once with "Recording…" and "Playing back…" said,
// and drops the clip (its address is revoked) when the playback ends, on Stop and when the dialog
// closes; nothing goes to the vault.
//
// Chromium's fake microphone and camera stand in for real ones (as in camera-photo.spec.ts: the
// full Chromium build, not the headless shell, which has no media devices), so the REAL
// getUserMedia, MediaRecorder, Audio element and blob addresses run here. The native side is faked
// (support/vaultFake.ts) and this run never starts a real recording, only the test; the only
// stand-in is that the recorder reports MP4 as supported so that the dialog offers "Record a
// video" in a Chromium build without H.264. On the installed Windows app (a real microphone, the
// real WebView2) the same journey needs a vault the test can create and a microphone or a virtual
// one: see the note in the pull request.

test.use({
  channel: "chromium",
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["camera", "microphone"]);
  await page.addInitScript(() => {
    // Every address the page makes for a blob, and every one it revokes.
    const made: string[] = [];
    const revoked: string[] = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const address = create(object);
      made.push(address);
      return address;
    };
    URL.revokeObjectURL = (address: string) => {
      revoked.push(address);
      revoke(address);
    };
    Reflect.set(window, "__addresses", { made, revoked });
    // The dialog offers video only where the recorder can write MP4; this Chromium may not.
    const supported = MediaRecorder.isTypeSupported.bind(MediaRecorder);
    MediaRecorder.isTypeSupported = (type: string) =>
      type.startsWith("video/mp4") ? true : supported(type);
    // What the page asks the real recorder and the real microphone for, as a test can read it.
    const asked: {
      recorders: {
        options: MediaRecorderOptions | undefined;
        audioBitsPerSecond: number;
        mimeType: string;
        audioTracks: number;
        videoTracks: number;
        sampleRate: number | undefined;
      }[];
      audioConstraints: unknown[];
    } = { recorders: [], audioConstraints: [] };
    Reflect.set(window, "__asked", asked);
    const Real = MediaRecorder;
    class Watched extends Real {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        asked.recorders.push({
          options,
          audioBitsPerSecond: this.audioBitsPerSecond,
          mimeType: this.mimeType,
          audioTracks: stream.getAudioTracks().length,
          videoTracks: stream.getVideoTracks().length,
          sampleRate: stream.getAudioTracks()[0]?.getSettings().sampleRate,
        });
      }
    }
    window.MediaRecorder = Watched;
    const ask = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = (
      constraints?: MediaStreamConstraints,
    ) => {
      asked.audioConstraints.push(constraints?.audio);
      return ask(constraints);
    };
  });
});

const addresses = (page: Page) =>
  page.evaluate(
    () =>
      Reflect.get(window, "__addresses") as {
        made: string[];
        revoked: string[];
      },
  );

async function openPreview(page: Page) {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: en("interface.RecordDialog.recordAVideo"),
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("interface.RecordDialog.recordAVideo"),
  });
  await dialog
    .getByRole("button", {
      name: en("interface.RecordDialog.useTheCameraAndMicrophone"),
    })
    .click();
  await expect(
    dialog.getByRole("button", {
      name: en("interface.RecordDialog.startRecording"),
    }),
  ).toBeEnabled();
  return dialog;
}

test("the test records from the microphone, plays it back once, and drops the clip", async ({
  page,
}) => {
  const dialog = await openPreview(page);
  // The note to use headphones is there before anything starts.
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestHeadphones")),
  ).toBeVisible();
  await expectNoAxeViolations(page, "the recorder before a microphone test");
  await dialog
    .getByRole("button", { name: en("interface.RecordDialog.testMicrophone") })
    .click();
  // Recording: said, with its level and Stop.
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestRecording")),
  ).toBeVisible();
  await expect(
    dialog.getByRole("meter", {
      name: en("interface.RecordDialog.microphoneLevel"),
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: en("interface.RecordDialog.stopTestingMicrophone"),
    }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "while the microphone test records");
  // About three seconds later it plays the clip back, from one address.
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestPlaying")),
  ).toBeVisible({ timeout: 10_000 });
  expect((await addresses(page)).made).toHaveLength(1);
  await expect(
    dialog.getByRole("button", {
      name: en("interface.RecordDialog.stopTestingMicrophone"),
    }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "while the microphone test plays back");
  // It ends by itself: the button is back, and the one address was revoked.
  await expect(
    dialog.getByRole("button", {
      name: en("interface.RecordDialog.testMicrophone"),
    }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestPlaying")),
  ).toHaveCount(0);
  const done = await addresses(page);
  expect(done.revoked).toEqual(done.made);
  // The quality of what the patient hears (Ben: it must be their real voice, not a crappy one):
  // the microphone is asked for 48 kHz, and the clip's recorder is a sound-only Opus recorder
  // asked for 128 kbps or more, on the very microphone track the preview (and so the real
  // recording) uses.
  const asked = await page.evaluate(
    () =>
      Reflect.get(window, "__asked") as {
        recorders: {
          options?: { mimeType?: string; audioBitsPerSecond?: number };
          audioBitsPerSecond: number;
          mimeType: string;
          audioTracks: number;
          videoTracks: number;
          sampleRate?: number;
        }[];
        audioConstraints: { sampleRate?: { ideal?: number } }[];
      },
  );
  expect(asked.audioConstraints).toHaveLength(1);
  expect(asked.audioConstraints[0].sampleRate?.ideal).toBeGreaterThanOrEqual(
    48_000,
  );
  const clip = asked.recorders.filter((recorder) => recorder.videoTracks === 0);
  expect(clip).toHaveLength(1);
  expect(clip[0].audioTracks).toBe(1);
  expect(clip[0].mimeType).toMatch(/opus/);
  expect(clip[0].options?.audioBitsPerSecond).toBeGreaterThanOrEqual(128_000);
  expect(clip[0].audioBitsPerSecond).toBeGreaterThanOrEqual(128_000);
  // Chromium's fake microphone captures at 48 kHz or more.
  expect(clip[0].sampleRate ?? 0).toBeGreaterThanOrEqual(44_100);
  // Nothing went to the vault, and no failure is shown.
  expect(await fakeCalls(page, "vault_video_start")).toHaveLength(0);
  expect(await fakeCalls(page, "vault_video_append")).toHaveLength(0);
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestFailed")),
  ).toHaveCount(0);
});

test("Stop ends the test at once, and closing the dialog while it plays drops the clip", async ({
  page,
}) => {
  const dialog = await openPreview(page);
  const test = () =>
    dialog.getByRole("button", {
      name: en("interface.RecordDialog.testMicrophone"),
    });
  // Stop during the recording: no clip is ever made.
  await test().click();
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestRecording")),
  ).toBeVisible();
  await dialog
    .getByRole("button", {
      name: en("interface.RecordDialog.stopTestingMicrophone"),
    })
    .click();
  await expect(test()).toBeVisible();
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestRecording")),
  ).toHaveCount(0);
  await page.waitForTimeout(3500);
  expect((await addresses(page)).made).toHaveLength(0);

  // Close during the playback: the address is revoked with the dialog.
  await test().click();
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestPlaying")),
  ).toBeVisible({ timeout: 10_000 });
  expect((await addresses(page)).made).toHaveLength(1);
  await dialog.getByRole("button", { name: en("common.cancel") }).click();
  await expect(dialog).toHaveCount(0);
  const after = await addresses(page);
  expect(after.revoked).toEqual(after.made);
  expect(await fakeCalls(page, "vault_video_start")).toHaveLength(0);
  await expectOnlyFakedCommands(page);
});

test("the test's state, its note and a failure fit a 320 px screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const dialog = await openPreview(page);
  await dialog
    .getByRole("button", { name: en("interface.RecordDialog.testMicrophone") })
    .click();
  await expect(
    dialog.getByText(en("interface.RecordDialog.microphoneTestRecording")),
  ).toBeVisible();
  const fits = () =>
    page.evaluate(() => {
      const width = window.innerWidth;
      const wide = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".record-mic-test, .record-mic-test *",
        ),
      ).filter((element) => {
        if (!element.checkVisibility()) return false;
        const box = element.getBoundingClientRect();
        return (
          box.left < -1 ||
          box.right > width + 1 ||
          element.scrollWidth > element.clientWidth + 1
        );
      });
      return {
        sideways:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        wide: wide.map((element) => element.className || element.tagName),
      };
    });
  expect(await fits()).toEqual({ sideways: expect.any(Number), wide: [] });
  expect((await fits()).sideways).toBeLessThanOrEqual(1);
  await dialog
    .getByRole("button", {
      name: en("interface.RecordDialog.stopTestingMicrophone"),
    })
    .click();
});
