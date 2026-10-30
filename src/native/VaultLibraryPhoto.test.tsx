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
  type VaultBridge,
  type VaultRecord,
  type VaultSnapshot,
} from "../vault";
import { VaultLibrary } from "./VaultLibrary";

const NAME = /^Photo, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}\.\d{2} [AP]M\.jpg$/;
const PHOTO_URL = "data:image/jpeg;base64,/9j/FAKE";

const record = (id: string, displayName: string, folderIds: string[] = []) =>
  ({
    id,
    profileId: "profile-1",
    folderIds,
    displayName,
    sourceLabel: "Manual import — unverified",
    mediaType: "application/octet-stream",
    plaintextSize: 2048,
    importedAtMs: Date.UTC(2026, 9, 17, 19, 5),
    available: true,
  }) satisfies VaultRecord;

const base: VaultSnapshot = {
  profiles: [{ id: "profile-1", displayName: "FAKE Patient", createdAtMs: 1 }],
  folders: [
    {
      id: "folder-cards",
      profileId: "profile-1",
      parentId: null,
      name: "FAKE Cards",
      createdAtMs: 1,
    },
  ],
  records: [],
  recovery: null,
};

let getUserMedia: ReturnType<typeof vi.spyOn>;
const painters: number[] = [];
beforeEach(() => {
  window.localStorage.setItem("mycarlos.cameraExplained.v1", "1");
  getUserMedia = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const context = canvas.getContext("2d")!;
      const paint = () => context.fillRect(0, 0, 64, 48);
      paint();
      painters.push(window.setInterval(paint, 40));
      return canvas.captureStream(15);
    });
});
afterEach(() => {
  getUserMedia.mockRestore();
  for (const timer of painters.splice(0)) window.clearInterval(timer);
  window.localStorage.removeItem("mycarlos.cameraExplained.v1");
});

// The library as VaultApp shows it: the snapshot a refresh returns is the one
// shown next.
function renderLibrary(
  initial: VaultSnapshot,
  bridgeOverrides: Partial<VaultBridge> = {},
  cameraPlatform: string | null = "windows",
  initialNotice = "",
  trackBusy = false,
) {
  let current = initial;
  const bridge = {
    platform: vi.fn().mockResolvedValue("windows"),
    savePhoto: vi.fn(async () => {
      current = {
        ...current,
        records: [
          ...current.records,
          record("photo-1", "Photo, 17 Oct 2026, 3.05 PM.jpg", [
            "folder-cards",
          ]),
        ],
      };
      return { imported: ["photo-1"], skippedDuplicates: [] };
    }),
    isPhoto: vi.fn(async () => true),
    isLockedPdf: vi.fn(async () => false),
    viewPhoto: vi.fn(async () => PHOTO_URL),
    snapshot: vi.fn(async () => current),
    ...bridgeOverrides,
  } as unknown as VaultBridge;
  const runFailure = vi.fn<(failure: unknown) => void>();
  function Harness() {
    const [snapshot, setSnapshot] = useState(initial);
    const [notice, setNotice] = useTextState(initialNotice);
    const [busy, setBusy] = useState(false);
    return (
      <VaultLibrary
        bridge={bridge}
        snapshot={snapshot}
        busy={busy}
        notice={notice}
        setNotice={setNotice}
        // As VaultApp's: a failure is reported as the notice.
        run={async (operation) => {
          if (trackBusy) setBusy(true);
          try {
            await operation();
          } catch (error) {
            runFailure(error);
            setNotice(vaultErrorMessage(error));
          } finally {
            if (trackBusy) setBusy(false);
          }
        }}
        refresh={async () => {
          setSnapshot(current);
          return current;
        }}
        onLock={vi.fn().mockResolvedValue(undefined)}
        autoLockMinutes={5}
        onAutoLockMinutes={vi.fn()}
        cameraPlatform={cameraPlatform}
      />
    );
  }
  render(<Harness />);
  return Object.assign(bridge, { runFailure });
}

describe("taking a photo from the library", () => {
  it("does not reopen Rename when the details close during the photo check", async () => {
    let answer!: (photo: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    renderLibrary(
      { ...base, records: [record("other", "Other.jpg")] },
      {
        isPhoto: vi.fn(() => pending),
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Other.jpg") }),
    );
    const details = screen.getByRole("dialog", {
      name: humanText("Other.jpg"),
    });
    fireEvent.click(
      within(details).getByRole("button", {
        name: humanText("Rename document"),
      }),
    );
    fireEvent.click(
      within(details).getByRole("button", {
        name: humanText("Close document details"),
      }),
    );
    await act(async () => answer(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps an unknown unreadable document's metadata-only rename available", async () => {
    renderLibrary(
      { ...base, records: [record("other", "Other.txt")] },
      {
        isPhoto: vi.fn().mockRejectedValue({
          code: "storage",
          message: "FAKE unavailable object",
        }),
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Other.txt") }),
    );
    const details = screen.getByRole("dialog", {
      name: humanText("Other.txt"),
    });
    fireEvent.click(
      within(details).getByRole("button", {
        name: humanText("Rename document"),
      }),
    );
    expect(
      await screen.findByRole("textbox", { name: humanText("File name") }),
    ).toHaveValue("Other.txt");
  });

  it("opens with no message left over from the library", async () => {
    renderLibrary(base, {}, "windows", "Vault unlocked.");
    expect(screen.getByText(humanText("Vault unlocked."))).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    );
    const camera = screen.getByRole("dialog", {
      name: humanText("Take a photo"),
    });
    await waitFor(() =>
      expect(within(camera).getByRole("status")).not.toHaveHumanTextContent(
        "Vault unlocked.",
      ),
    );
    expect(screen.queryByText(humanText("Vault unlocked."))).toBeNull();
  });

  it("shows a save that failed in the camera window, which stays open", async () => {
    renderLibrary(base, {
      savePhoto: vi.fn(async () => {
        throw { code: "storage", message: "FAKE" };
      }),
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    );
    const camera = screen.getByRole("dialog", {
      name: humanText("Take a photo"),
    });
    const shutter = within(camera).getByRole("button", {
      name: humanText("Take photo"),
    });
    await waitFor(() => expect(shutter).toBeEnabled());
    fireEvent.click(shutter);
    fireEvent.click(
      within(camera).getByRole("button", { name: humanText("Use photo") }),
    );
    await waitFor(() =>
      expect(within(camera).getByRole("status")).toHaveHumanTextContent(
        vaultErrorMessage({ code: "storage", message: "FAKE" }),
      ),
    );
    expect(camera).toBeVisible();
  });

  it("is offered on a computer", () => {
    renderLibrary(base);
    expect(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    ).toBeEnabled();
  });

  it("keeps the library out of reach while open, and gives the focus back", async () => {
    renderLibrary(base);
    const take = screen.getByRole("button", {
      name: humanText("Take a photo"),
    });
    take.focus();
    fireEvent.click(take);
    const camera = screen.getByRole("dialog", {
      name: humanText("Take a photo"),
    });
    expect(take.closest("[inert]")).not.toBeNull();
    await waitFor(() =>
      expect(
        within(camera).getByRole("button", { name: humanText("Take photo") }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      within(camera).getByRole("button", { name: humanText("Cancel") }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(take.closest("[inert]")).toBeNull();
    await waitFor(() => expect(take).toHaveFocus());
  });

  it("is not offered on a phone or tablet", () => {
    renderLibrary(base, {}, null);
    expect(
      screen.queryByRole("button", { name: humanText("Take a photo") }),
    ).toBeNull();
  });

  it("is not offered while the vault is read-only", () => {
    renderLibrary({ ...base, recovery: "writeFailed" });
    expect(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    ).toBeDisabled();
  });

  it("saves into the open folder, then opens the new photo to be renamed", async () => {
    const bridge = renderLibrary(base);
    const sidebar = screen.getByRole("navigation", {
      name: humanText("Record library"),
    });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: humanText(/^FAKE Cards/) }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    );
    const camera = screen.getByRole("dialog", {
      name: humanText("Take a photo"),
    });
    const shutter = within(camera).getByRole("button", {
      name: humanText("Take photo"),
    });
    await waitFor(() => expect(shutter).toBeEnabled());
    fireEvent.click(shutter);
    fireEvent.click(
      within(camera).getByRole("button", { name: humanText("Use photo") }),
    );

    await waitFor(() => expect(bridge.savePhoto).toHaveBeenCalledTimes(1));
    const [profileId, folderIds, name, jpeg] = vi.mocked(bridge.savePhoto).mock
      .calls[0];
    expect(profileId).toBe("profile-1");
    expect(folderIds).toEqual(["folder-cards"]);
    expect(name).toMatch(NAME);
    expect(jpeg).toBeInstanceOf(Uint8Array);
    // Overwritten once the save settled.
    expect(jpeg.every((byte) => byte === 0)).toBe(true);

    const details = await screen.findByRole("dialog", {
      name: humanText("Photo, 17 Oct 2026, 3.05 PM.jpg"),
    });
    expect(
      screen.queryByRole("dialog", { name: humanText("Take a photo") }),
    ).toBeNull();
    expect(
      within(details).getByRole("button", {
        name: humanText("Rename document"),
      }),
    ).toBeEnabled();
    await waitFor(() =>
      expect(within(details).getByRole("status")).toHaveHumanTextContent(
        "Photo, 17 Oct 2026, 3.05 PM.jpg was saved in myCarlos.",
      ),
    );

    fireEvent.click(
      within(details).getByRole("button", {
        name: humanText("Rename document"),
      }),
    );
    const nameField = await screen.findByRole("textbox", {
      name: humanText("File name"),
    });
    expect(nameField).toHaveValue("Photo, 17 Oct 2026, 3.05 PM");
    expect(nameField).toHaveHumanAccessibleDescription(
      "This changes the name in myCarlos and the suggested export name. The .jpg extension stays the same.",
    );
  });

  it("says when the same photo is already in the vault", async () => {
    renderLibrary(base, {
      savePhoto: vi.fn(async () => ({
        imported: [],
        skippedDuplicates: ["Photo, 17 Oct 2026, 3.05 PM.jpg"],
      })),
    });
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Take a photo") }),
    );
    const shutter = screen.getByRole("button", {
      name: humanText("Take photo"),
    });
    await waitFor(() => expect(shutter).toBeEnabled());
    fireEvent.click(shutter);
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Use photo") }),
    );
    expect(
      await screen.findByText(
        humanText(
          "This photo is already in the vault, so it was not saved again.",
        ),
      ),
    ).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("viewing a photo", () => {
  const withRecords: VaultSnapshot = {
    ...base,
    records: [
      record("card", "FAKE insurance card"),
      record("results", "FAKE results.pdf"),
    ],
  };

  const openDetails = (name: string) => {
    fireEvent.click(
      screen.getByRole("button", { name: humanText(`Details for ${name}`) }),
    );
    return screen.getByRole("dialog", { name });
  };

  it.each([
    ["a different record", "FAKE results.pdf"],
    ["the same record reopened", "FAKE insurance card"],
  ])(
    "keeps details for %s when an earlier photo request finishes",
    async (_case, target) => {
      let finish!: (url: string) => void;
      const viewPhoto = vi
        .fn<(id: string) => Promise<string>>()
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue(PHOTO_URL);
      renderLibrary(withRecords, { viewPhoto }, "windows", "", true);
      const original = openDetails("FAKE insurance card");
      const view = await within(original).findByRole("button", {
        name: humanText("View photo"),
      });
      fireEvent.click(view);
      expect(view).toBeDisabled();
      const close = within(original).getByRole("button", {
        name: humanText("Close document details"),
      });
      expect(close).toBeEnabled();
      fireEvent.click(close);
      expect(screen.queryByRole("dialog")).toBeNull();

      // Metadata remains readable while the previous native read is busy.
      expect(
        screen.getByRole("button", {
          name: humanText(`Details for ${target}`),
        }),
      ).toBeEnabled();
      const reopened = openDetails(target);
      expect(reopened).toHaveAttribute(
        "aria-describedby",
        "native-record-about",
      );
      await act(async () => finish(PHOTO_URL));

      expect(screen.getByRole("dialog", { name: target })).toBe(reopened);
      expect(reopened).toHaveAttribute(
        "aria-describedby",
        "native-record-about",
      );
      expect(
        screen.queryByRole("img", { name: humanText(/^Photo:/) }),
      ).toBeNull();
      expect(viewPhoto).toHaveBeenCalledExactlyOnceWith("card");
      expect(
        within(reopened).getByRole("button", {
          name: humanText("Close document details"),
        }),
      ).toHaveFocus();
      let detailsToClose = reopened;
      if (target === "FAKE insurance card") {
        // Discarding the old request must not disable a new, explicit view intent.
        const viewAgain = await within(reopened).findByRole("button", {
          name: humanText("View photo"),
        });
        expect(viewAgain).toBeEnabled();
        fireEvent.click(viewAgain);
        const photo = await screen.findByRole("img", {
          name: humanText("Photo: FAKE insurance card"),
        });
        expect(viewPhoto).toHaveBeenNthCalledWith(2, "card");
        fireEvent.click(
          within(photo.closest<HTMLElement>('[role="dialog"]')!).getByRole(
            "button",
            { name: humanText("Close") },
          ),
        );
        detailsToClose = screen.getByRole("dialog", { name: target });
        expect(detailsToClose).toHaveAttribute(
          "aria-describedby",
          "native-record-about",
        );
      }
      fireEvent.click(
        within(detailsToClose).getByRole("button", {
          name: humanText("Close document details"),
        }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(
        screen
          .getByRole("button", {
            name: humanText("Details for FAKE insurance card"),
          })
          .closest("[inert]"),
      ).toBeNull();
    },
  );

  it.each([
    ["not_a_photo", false],
    ["locked", true],
    ["cancelled", true],
    ["missing", true],
  ] as const)(
    "handles a dismissed photo's %s failure without losing application state signals",
    async (code, delegated) => {
      let reject!: (failure: unknown) => void;
      const viewPhoto = vi.fn(
        (_id: string) =>
          new Promise<string>((_resolve, rejectRead) => {
            reject = rejectRead;
          }),
      );
      const bridge = renderLibrary(
        withRecords,
        { viewPhoto },
        "windows",
        "",
        true,
      );
      const original = openDetails("FAKE insurance card");
      fireEvent.click(
        await within(original).findByRole("button", {
          name: humanText("View photo"),
        }),
      );
      fireEvent.click(
        within(original).getByRole("button", {
          name: humanText("Close document details"),
        }),
      );
      const current = openDetails("FAKE results.pdf");
      const failure = { code, message: "FAKE dismissed photo read failed" };
      await act(async () => reject(failure));

      if (delegated) {
        // The real VaultApp runner owns native auto-lock/missing-vault transitions.
        // This harness observes delegation; it does not simulate those transitions.
        expect(bridge.runFailure).toHaveBeenCalledExactlyOnceWith(failure);
      } else {
        expect(bridge.runFailure).not.toHaveBeenCalled();
        expect(screen.getByRole("dialog", { name: "FAKE results.pdf" })).toBe(
          current,
        );
        expect(within(current).getByRole("status")).toBeEmptyDOMElement();
        expect(
          within(current).getByRole("button", {
            name: humanText("Close document details"),
          }),
        ).toHaveFocus();
      }
      expect(viewPhoto).toHaveBeenCalledExactlyOnceWith("card");
    },
  );

  it("is offered when the vault says the file is a JPEG, whatever its name, and fetched only to be shown", async () => {
    const bridge = renderLibrary(withRecords);
    const details = openDetails("FAKE insurance card");
    const view = await within(details).findByRole("button", {
      name: humanText("View photo"),
    });
    expect(bridge.isPhoto).toHaveBeenCalledWith("card");
    // The details only ask whether it is a photo; the photo stays native.
    expect(bridge.viewPhoto).not.toHaveBeenCalled();
    fireEvent.click(view);
    expect(bridge.viewPhoto).toHaveBeenCalledWith("card");

    // The viewer replaces the details, under the same name.
    const photo = await screen.findByRole("img", {
      name: humanText("Photo: FAKE insurance card"),
    });
    const viewer = photo.closest<HTMLElement>('[role="dialog"]')!;
    expect(viewer).toHaveHumanAccessibleName("FAKE insurance card");
    expect(photo).toHaveAttribute("src", PHOTO_URL);
    await waitFor(() =>
      expect(
        within(viewer).getByRole("button", { name: humanText("Close") }),
      ).toHaveFocus(),
    );
    expect(
      within(viewer).getByRole("button", { name: humanText("Zoom out") }),
    ).toBeDisabled();
    fireEvent.click(
      within(viewer).getByRole("button", { name: humanText("Zoom in") }),
    );
    expect(within(viewer).getByRole("status")).toHaveHumanTextContent(
      "Zoomed to 150%.",
    );
    fireEvent.click(
      within(viewer).getByRole("button", { name: humanText("Close") }),
    );
    expect(
      screen.getByRole("dialog", { name: humanText("FAKE insurance card") }),
    ).toHaveAttribute("aria-describedby", "native-record-about");
    // Closed, the photo is dropped; showing it again fetches it again.
    expect(
      screen.queryByRole("img", { name: humanText(/^Photo: /) }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("View photo") }),
    );
    await screen.findByRole("img", {
      name: humanText("Photo: FAKE insurance card"),
    });
    expect(bridge.viewPhoto).toHaveBeenCalledTimes(2);
  });

  it("says why when a file that starts as a photo cannot be shown", async () => {
    renderLibrary(withRecords, {
      viewPhoto: vi.fn(async () => {
        throw { code: "not_a_photo", message: "FAKE This is not a photo." };
      }),
    });
    const details = openDetails("FAKE insurance card");
    fireEvent.click(
      await within(details).findByRole("button", {
        name: humanText("View photo"),
      }),
    );
    await waitFor(() =>
      expect(within(details).getByRole("status")).toHaveHumanTextContent(
        "FAKE This is not a photo.",
      ),
    );
    expect(
      screen.queryByRole("img", { name: humanText(/^Photo: /) }),
    ).toBeNull();
  });

  it("is not offered when the file is not a photo, and a PDF is not asked about", async () => {
    const bridge = renderLibrary(withRecords, {
      isPhoto: vi.fn(async () => false),
      isLockedPdf: vi.fn(async () => false),
    });
    openDetails("FAKE insurance card");
    await waitFor(() => expect(bridge.isPhoto).toHaveBeenCalledWith("card"));
    expect(
      screen.queryByRole("button", { name: humanText("View photo") }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Close document details") }),
    );

    openDetails("FAKE results.pdf");
    expect(bridge.isPhoto).toHaveBeenCalledTimes(1);
    expect(bridge.viewPhoto).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: humanText("View photo") }),
    ).toBeNull();
  });
});
