import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import type {
  VideoImportProgress,
  VideoImportResult,
  VideoRefusal,
} from "../vault";
import { AddVideo, canAddVideo, type AddVideoBridge } from "./AddVideo";

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

describe("Add a video", () => {
  it("is offered only by a bridge that can add one", () => {
    expect(canAddVideo({})).toBe(false);
    expect(canAddVideo({ pickImportVideo: async () => null })).toBe(false);
    expect(canAddVideo(bridgeFor({ result: "duplicate" }))).toBe(true);
  });

  it("picks, adds into the open folder, says so, tells the library and gives the focus back", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const bridge = bridgeFor({ result: "imported", recordId: "record-9" });
    const onAdded = renderAdd(bridge);
    const button = screen.getByRole("button", { name: "Add a video" });
    // What it does is the description, so the name stays the visible word.
    expect(button).toHaveAccessibleDescription(/place and device details/);
    await user.click(button);
    expect(bridge.pickImportVideo).toHaveBeenCalledWith("person-1", [
      "folder-1",
    ]);
    expect(bridge.importPickedVideo).toHaveBeenCalledWith(
      "pick-1",
      "person-1",
      ["folder-1"],
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "The video was added.",
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
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
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
      expect(await screen.findByRole("status")).toHaveTextContent(words);
      expect(onAdded).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("gives every reason a refusal can have its own words, as an alert", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const seen = new Set<string>();
    for (const reason of REASONS) {
      const onAdded = renderAdd(bridgeFor({ result: "refused", reason }));
      await user.click(screen.getByRole("button", { name: "Add a video" }));
      const alert = await screen.findByRole("alert");
      const text = alert.textContent ?? "";
      expect(text.length).toBeGreaterThan(30);
      expect(seen.has(text)).toBe(false);
      seen.add(text);
      expect(onAdded).not.toHaveBeenCalled();
      cleanup();
    }
    expect(seen.size).toBe(REASONS.length);
    // The two the patient can act on say what to do.
    const hevc = translate("en", "interface.AddVideo.hevc");
    expect(hevc).toContain("H.264 MP4");
  });

  it("shows the progress while it works, with Cancel, and then the answer", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    let finish: (value: VideoImportResult) => void = () => undefined;
    const bridge = bridgeFor(
      new Promise<VideoImportResult>((resolve) => {
        finish = resolve;
      }),
    );
    bridge.videoImportProgress
      .mockResolvedValueOnce({ stage: "checking", doneBytes: 5, totalBytes: 0 })
      .mockResolvedValue({ stage: "storing", doneBytes: 50, totalBytes: 100 });
    renderAdd(bridge);
    const add = screen.getByRole("button", { name: "Add a video" });
    await user.click(add);
    // While it works the button waits, a bar shows how far it has come, and Cancel is there.
    expect(add).toBeDisabled();
    const bar = await screen.findByRole("progressbar", {
      name: "Adding the video",
    });
    expect(
      await screen.findByText("Checking the video…", {}, { timeout: 3000 }),
    ).toBeVisible();
    await vi.waitFor(() => expect(bar).toHaveAttribute("value", "50"), {
      timeout: 3000,
    });
    expect(
      screen.getByText(
        translate("en", "interface.AddVideo.storing", { percent: 50 }),
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.videoImportCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Cancelling…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    finish({ result: "cancelled" });
    // The "Cancelling…" line goes with the bar; the answer replaces it.
    expect(
      await screen.findByText("Cancelled. Nothing was added."),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Cancelled. Nothing was added.",
    );
    expect(within(document.body).queryByRole("progressbar")).toBeNull();
    expect(add).toBeEnabled();
  });

  it("reports a failure in the vault's own words and lets the patient try again", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const bridge = bridgeFor({ result: "duplicate" });
    bridge.importPickedVideo.mockRejectedValue({ code: "no_space" });
    renderAdd(bridge);
    const add = screen.getByRole("button", { name: "Add a video" });
    await user.click(add);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.length).toBeGreaterThan(10);
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

  for (const locale of LOCALES) {
    it(`speaks ${locale}: the button, the progress words and every refusal`, () => {
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
      // Every refusal and status text exists in this language (not the key, not blank).
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
        "interface.AddVideo.cancelling",
        "interface.AddVideo.added",
        "interface.AddVideo.duplicate",
        "interface.AddVideo.cancelled",
        "interface.AddVideo.cancel",
        "interface.AddVideo.hint",
      ] as const) {
        const text = translate(locale, key);
        expect(text.length).toBeGreaterThan(1);
        expect(text).not.toContain("interface.AddVideo");
      }
      expect(
        translate(locale, "interface.AddVideo.storing", { percent: 42 }),
      ).toContain("42");
    });
  }
});
