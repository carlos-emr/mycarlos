import { humanText, visibleText } from "../test/humanText";
import { useTextState } from "../i18n";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  vaultErrorMessage,
  type VaultBridge,
  type VaultRecord,
  type VaultSnapshot,
} from "../vault";
import { VaultLibrary } from "./VaultLibrary";

// Gap tests (24 Nov): what the library passes to the screens it opens, and what it does with their
// answers. The screens themselves are tested in their own files; here each is a stand-in that
// calls what the library handed it, so the library's own wiring is what is under test.
type SavedHandler = (recordId: string | null, endedBy: string) => void;
const seen = vi.hoisted(() => ({
  record: null as { onSaved: SavedHandler; onClose: () => void } | null,
  preview: null as Record<string, (...args: never[]) => unknown> | null,
  android: null as Record<string, (...args: never[]) => unknown> | null,
  reader: null as Record<string, unknown> | null,
}));

vi.mock("./RecordDialog", () => ({
  RecordDialog: (props: { onSaved: SavedHandler; onClose: () => void }) => {
    seen.record = props;
    return <div role="dialog" aria-label="FAKE recording dialog" />;
  },
}));
vi.mock("./AnonymizePreview", () => ({
  AnonymizePreview: (props: Record<string, (...args: never[]) => unknown>) => {
    seen.preview = props;
    return <div role="dialog" aria-label="FAKE anonymize preview" />;
  },
}));
vi.mock("./AndroidDocumentReader", () => ({
  AndroidDocumentReader: (
    props: Record<string, (...args: never[]) => unknown>,
  ) => {
    seen.android = props;
    return <div role="dialog" aria-label="FAKE android reader" />;
  },
}));
vi.mock("./DocumentReader", () => ({
  DocumentReader: (props: Record<string, unknown>) => {
    seen.reader = props;
    return <div role="dialog" aria-label="FAKE document reader" />;
  },
}));
vi.mock("./AiSettings", () => ({
  AiSettings: (): ReactNode => <h2>FAKE AI settings</h2>,
}));

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

const record = (
  id: string,
  displayName: string,
  extra: Partial<VaultRecord> = {},
) =>
  ({
    id,
    profileId: "profile-1",
    folderIds: [],
    displayName,
    sourceLabel: "Manual import — unverified",
    mediaType: "application/pdf",
    plaintextSize: 2048,
    importedAtMs: Date.UTC(2026, 10, 20, 15, 5),
    available: true,
    ...extra,
  }) satisfies VaultRecord;

const base: VaultSnapshot = {
  capture: { epoch: "00000000-0000-4000-8000-000000000185", sequence: 1 },
  profiles: [{ id: "profile-1", displayName: "FAKE Patient", createdAtMs: 1 }],
  folders: [],
  records: [],
  recovery: null,
};

// The webview records MP4, so that Record a video is offered.
class Recorder extends EventTarget {
  static isTypeSupported = (type: string) => type.startsWith("video/mp4");
}
beforeEach(() => {
  seen.record = null;
  seen.preview = null;
  seen.android = null;
  seen.reader = null;
  vi.stubGlobal("MediaRecorder", Recorder);
});
afterEach(() => vi.unstubAllGlobals());

function renderLibrary(
  initial: VaultSnapshot,
  {
    bridge: overrides = {},
    props = {},
    onLock = vi.fn().mockResolvedValue(undefined),
  }: {
    bridge?: Partial<VaultBridge>;
    props?: Partial<Parameters<typeof VaultLibrary>[0]>;
    onLock?: () => Promise<void>;
  } = {},
) {
  let current = initial;
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    isPhoto: vi.fn(async () => false),
    isLockedPdf: vi.fn(async () => false),
    isVideo: vi.fn(async () => false),
    videoStart: vi.fn(async () => ({ recordingId: "recording-1" })),
    videoPending: vi.fn(async () => ({ recordings: [], unreadable: 0 })),
    snapshot: vi.fn(async () => captureSnapshot(current)),
    aiModelStatus: vi.fn(async () => ({ state: "notInstalled" })),
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
        onLock={onLock}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
        cameraPlatform="windows"
        {...props}
      />
    );
  }
  render(<Harness />);
  return {
    bridge,
    onLock,
    /** What the vault holds once the recording is saved. */
    vaultNow: (next: VaultSnapshot) => {
      current = next;
    },
  };
}

const status = () => document.body.textContent ?? "";
const said = (text: string) => visibleText(status()).includes(text);

describe("the recording the library is told has ended", () => {
  const saved = record("video-1", "FAKE Video.mp4");
  const open = async (
    props: Parameters<typeof renderLibrary>[1] = {},
    snapshot: VaultSnapshot = base,
  ) => {
    const view = renderLibrary(snapshot, props);
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Record a video") }),
    );
    await screen.findByRole("dialog", { name: "FAKE recording dialog" });
    return view;
  };

  it("says an unfinished recording is kept, and closes the dialog", async () => {
    await open();
    await act(async () => seen.record!.onSaved(null, "unfinished"));
    expect(
      screen.queryByRole("dialog", { name: "FAKE recording dialog" }),
    ).toBeNull();
    await waitFor(() =>
      expect(
        said(
          "There was no more room, so the video could not be finished. It is kept as an unfinished recording",
        ),
      ).toBe(true),
    );
  });

  it("says nothing was recorded when no video was saved, or the vault does not list it", async () => {
    await open();
    await act(async () => seen.record!.onSaved(null, "asked"));
    await waitFor(() =>
      expect(said("Nothing was recorded, so no video was saved.")).toBe(true),
    );
  });

  it.each([
    ["asked", "Video saved: FAKE Video.mp4"],
    [
      "hidden",
      "Recording stopped because myCarlos was hidden. What was recorded was saved: FAKE Video.mp4",
    ],
    [
      "slow",
      "Recording stopped because the video could not be saved fast enough. What was recorded was saved: FAKE Video.mp4",
    ],
    ["space", "Saved. There was no more room: FAKE Video.mp4"],
    [
      "failed",
      "Recording stopped because part of it could not be saved. What was saved before that is kept: FAKE Video.mp4",
    ],
    [
      "stopped",
      "Recording stopped because the device reported a problem. What was recorded was saved: FAKE Video.mp4",
    ],
  ])(
    "opens the saved video's details and says how it ended (%s)",
    async (endedBy, words) => {
      const { vaultNow } = await open();
      vaultNow({ ...base, records: [saved] });
      await act(async () => seen.record!.onSaved("video-1", endedBy));
      // The new document's details are open, so that it can be renamed at once.
      expect(
        await screen.findByRole("dialog", {
          name: humanText("FAKE Video.mp4"),
        }),
      ).toBeVisible();
      await waitFor(() => expect(said(words)).toBe(true));
    },
  );
});

describe("the text the anonymize preview exports", () => {
  const letter = record("letter-1", "FAKE Letter.pdf", {
    verifiedClinicName: "FAKE Verified Clinic",
  });
  const withPortal: VaultSnapshot = {
    ...base,
    records: [letter],
    portalLinks: [
      {
        id: "link-1",
        clinicName: "FAKE Linked Clinic",
        portalBase: "https://portal.example.test",
      },
      { id: "link-2", portalBase: "https://other.example.test" },
    ] as unknown as VaultSnapshot["portalLinks"],
  };

  async function openPreview(bridge: Partial<VaultBridge>) {
    const view = renderLibrary(withPortal, {
      bridge,
      props: { computer: true },
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("FAKE Letter.pdf") }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: humanText("Prepare text for an AI…"),
      }),
    );
    // The first time, the AI notice comes first; Continue goes on to the preview.
    fireEvent.click(
      await screen.findByRole("button", { name: humanText("Continue") }),
    );
    await screen.findByRole("dialog", { name: "FAKE anonymize preview" });
    return view;
  }

  it("hands the preview the clinics it should look for, and asks the native side for each step with the document", async () => {
    const bridge = {
      documentText: vi.fn(async () => ({ text: "FAKE" })),
      cancelDocumentText: vi.fn().mockRejectedValue(new Error("FAKE gone")),
      recordKnownDetails: vi.fn(async () => ({
        names: [],
        birthDates: [],
        doctorNames: [],
        clinicNames: [],
      })),
      pickTextExportDestination: vi.fn(async () => "pick-1"),
      exportTextToPicked: vi.fn(async () => ({ saved: true, hits: [] })),
      copyTextExport: vi.fn(async () => ({ approved: "FAKE text", hits: [] })),
    } as unknown as Partial<VaultBridge>;
    await openPreview(bridge);
    const preview = seen.preview as unknown as {
      clinicNames: string[];
      readText: (password?: string) => Promise<unknown>;
      cancelRead: () => void;
      knownDetails: () => Promise<unknown>;
      pickDestination: (ticket: string) => Promise<unknown>;
      saveText: (
        pickId: string,
        ticket: string,
        text: string,
        kept?: { start: number; end: number }[],
      ) => Promise<unknown>;
      copyText: (
        ticket: string,
        text: string,
        kept?: { start: number; end: number }[],
      ) => Promise<unknown>;
      onClose: () => void;
    };
    // The verified clinic of the document, then the linked clinics that have a name.
    expect(preview.clinicNames).toEqual([
      "FAKE Verified Clinic",
      "FAKE Linked Clinic",
    ]);
    await preview.readText("FAKE-pw");
    expect(bridge.documentText).toHaveBeenCalledWith(
      "letter-1",
      expect.any(String),
      "FAKE-pw",
    );
    const readId = vi.mocked(bridge.documentText!).mock.calls[0]![1];
    // A cancel the native side cannot take is not a failure.
    preview.cancelRead();
    await waitFor(() =>
      expect(bridge.cancelDocumentText).toHaveBeenCalledWith(readId),
    );
    await preview.knownDetails();
    expect(bridge.recordKnownDetails).toHaveBeenCalledWith("letter-1");
    await preview.pickDestination("T1");
    expect(bridge.pickTextExportDestination).toHaveBeenCalledWith(
      "letter-1",
      "T1",
    );
    const kept = [{ start: 2, end: 9 }];
    await preview.saveText("pick-1", "T1", "FAKE text", kept);
    expect(bridge.exportTextToPicked).toHaveBeenCalledWith(
      "pick-1",
      "letter-1",
      "T1",
      "FAKE text",
      kept,
    );
    await preview.copyText("T1", "FAKE text", kept);
    expect(bridge.copyTextExport).toHaveBeenCalledWith(
      "letter-1",
      "T1",
      "FAKE text",
      kept,
    );
    act(() => preview.onClose());
    expect(
      screen.queryByRole("dialog", { name: "FAKE anonymize preview" }),
    ).toBeNull();
  });

  describe("the clipboard copy of the text", () => {
    const bridge = {
      documentText: vi.fn(async () => ({ text: "FAKE" })),
      cancelDocumentText: vi.fn(async () => undefined),
      recordKnownDetails: vi.fn(async () => ({
        names: [],
        birthDates: [],
        doctorNames: [],
        clinicNames: [],
      })),
    } as unknown as Partial<VaultBridge>;
    function installBoard() {
      const board = { text: "" };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: vi.fn(async (value: string) => void (board.text = value)),
          readText: vi.fn(async () => board.text),
        },
      });
      return board;
    }
    const settle = () => act(async () => void (await Promise.resolve()));
    afterEach(() => vi.useRealTimers());

    it("outlives the preview, is taken off after five minutes and not a second before, and never touches a newer copy", async () => {
      const board = installBoard();
      await openPreview(bridge);
      const preview = seen.preview as unknown as {
        copyToClipboard: (text: string) => Promise<void>;
        onClose: () => void;
      };
      vi.useFakeTimers();
      await act(() => preview.copyToClipboard("FAKE approved text"));
      expect(board.text).toBe("FAKE approved text");
      // The patient closes the preview, then pastes: the copy is still there.
      act(() => preview.onClose());
      expect(
        screen.queryByRole("dialog", { name: "FAKE anonymize preview" }),
      ).toBeNull();
      await settle();
      await settle();
      expect(board.text).toBe("FAKE approved text");
      await act(async () => void vi.advanceTimersByTime(5 * 60_000 - 1));
      await settle();
      expect(board.text).toBe("FAKE approved text");
      await act(async () => void vi.advanceTimersByTime(1));
      await settle();
      expect(board.text).toBe("");
    });

    it("is taken off when the library goes away because the vault locked", async () => {
      const board = installBoard();
      await openPreview(bridge);
      const preview = seen.preview as unknown as {
        copyToClipboard: (text: string) => Promise<void>;
      };
      await act(() => preview.copyToClipboard("FAKE approved text"));
      expect(board.text).toBe("FAKE approved text");
      // A locked vault replaces the library, which unmounts it.
      cleanup();
      await waitFor(() => expect(board.text).toBe(""));
    });

    it("leaves a newer copy of the patient's own alone when the vault locks", async () => {
      const board = installBoard();
      await openPreview(bridge);
      const preview = seen.preview as unknown as {
        copyToClipboard: (text: string) => Promise<void>;
      };
      await act(() => preview.copyToClipboard("FAKE approved text"));
      board.text = "FAKE something else";
      cleanup();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(board.text).toBe("FAKE something else");
    });
  });
});

describe("the Android reader and the reader's AI wiring", () => {
  const letter = record("letter-1", "FAKE Letter.pdf");
  const withLetter: VaultSnapshot = { ...base, records: [letter] };
  const labels = { page: "FAKE page" } as never;

  it("reads through the bridge, and locks the library when the read says the vault is locked", async () => {
    const onLock = vi.fn().mockResolvedValue(undefined);
    const readAndroidPdf = vi
      .fn()
      .mockRejectedValueOnce({ code: "locked", message: "FAKE locked" })
      .mockRejectedValueOnce(new Error("FAKE other"))
      .mockResolvedValue(undefined);
    const cancelView = vi.fn().mockResolvedValue(undefined);
    renderLibrary(withLetter, {
      bridge: { readAndroidPdf, cancelView } as unknown as Partial<VaultBridge>,
      props: { androidPdfReader: true, computer: false },
      onLock,
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("FAKE Letter.pdf") }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: humanText("Read") }),
    );
    await screen.findByRole("dialog", { name: "FAKE android reader" });
    const reader = seen.android as unknown as {
      read: (id: string, labels: never) => Promise<void>;
      cancel: () => Promise<void>;
      onClose: () => void;
    };
    await expect(reader.read("letter-1", labels)).rejects.toMatchObject({
      code: "locked",
    });
    expect(readAndroidPdf).toHaveBeenCalledWith("letter-1", labels);
    // A locked vault conceals the library at once, through the app's own lock.
    await waitFor(() => expect(onLock).toHaveBeenCalledTimes(1));
    // Any other failure is passed on and locks nothing.
    await expect(reader.read("letter-1", labels)).rejects.toThrow("FAKE other");
    expect(onLock).toHaveBeenCalledTimes(1);
    await reader.cancel();
    expect(cancelView).toHaveBeenCalledOnce();
    act(() => reader.onClose());
    expect(
      screen.queryByRole("dialog", { name: "FAKE android reader" }),
    ).toBeNull();
  });

  it("gives the reader the page boxes and the kept answers of its own document, and opens the AI helper's page from it", async () => {
    const bridge = {
      pageBoxes: vi.fn(async () => []),
      viewPage: vi.fn().mockRejectedValue({ code: "locked" }),
      cancelView: vi.fn().mockRejectedValue(new Error("FAKE gone")),
      documentText: vi.fn(async () => ({ text: "FAKE" })),
      cancelDocumentText: vi.fn().mockRejectedValue(new Error("FAKE gone")),
      aiResults: vi.fn(async () => []),
      readAiResult: vi.fn(async () => "FAKE answer"),
      saveAiResult: vi.fn(async () => undefined),
    } as unknown as Partial<VaultBridge>;
    const onLock = vi.fn().mockResolvedValue(undefined);
    renderLibrary(withLetter, { bridge, props: { computer: true }, onLock });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("FAKE Letter.pdf") }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: humanText("Read") }),
    );
    await screen.findByRole("dialog", { name: "FAKE document reader" });
    const props = seen.reader as unknown as {
      pageBoxes: (
        page: number,
        span: number,
        password?: string,
      ) => Promise<unknown>;
      viewPage: (
        page: number,
        width: number,
        password?: string,
      ) => Promise<unknown>;
      cancelView: () => void;
      onClose: () => void;
      ai: {
        loadText: () => Promise<unknown>;
        cancelText: () => void;
        onOpenPreferences: () => void;
        kept: {
          recordId: string;
          list: () => Promise<unknown>;
          read: (id: string) => Promise<unknown>;
          save: (kept: string, sources: never) => Promise<unknown>;
        };
      };
    };
    await props.pageBoxes(2, 3, "FAKE-pw");
    expect(bridge.pageBoxes).toHaveBeenCalledWith("letter-1", 2, 3, "FAKE-pw");
    // The page read says the vault is locked: the library is concealed.
    await expect(props.viewPage(1, 800)).rejects.toMatchObject({
      code: "locked",
    });
    await waitFor(() => expect(onLock).toHaveBeenCalledTimes(1));
    props.cancelView();
    await waitFor(() => expect(bridge.cancelView).toHaveBeenCalled());
    await props.ai.loadText();
    expect(bridge.documentText).toHaveBeenCalledWith(
      "letter-1",
      expect.any(String),
    );
    props.ai.cancelText();
    await waitFor(() => expect(bridge.cancelDocumentText).toHaveBeenCalled());
    expect(props.ai.kept.recordId).toBe("letter-1");
    await props.ai.kept.list();
    expect(bridge.aiResults).toHaveBeenCalledWith("letter-1");
    await props.ai.kept.read("result-1");
    expect(bridge.readAiResult).toHaveBeenCalledWith("letter-1", "result-1");
    await props.ai.kept.save("kept-1", [] as never);
    expect(bridge.saveAiResult).toHaveBeenCalledWith("letter-1", "kept-1", []);
    // "Set up the model" goes to the AI helper's own page and closes the reader.
    act(() => props.ai.onOpenPreferences());
    expect(
      screen.queryByRole("dialog", { name: "FAKE document reader" }),
    ).toBeNull();
    expect(await screen.findByText("FAKE AI settings")).toBeVisible();
    expect(
      within(document.body).queryByRole("dialog", {
        name: "FAKE document reader",
      }),
    ).toBeNull();
  });
});
