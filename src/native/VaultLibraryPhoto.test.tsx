import {
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

const NAME = /^Photo, \d{1,2} [A-Z][a-z]{2} \d{4}, \d{1,2}\.\d{2} [AP]M\.jpg$/;
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
) {
  let current = initial;
  const bridge = {
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
    viewPhoto: vi.fn(async () => PHOTO_URL),
    snapshot: vi.fn(async () => current),
    ...bridgeOverrides,
  } as unknown as VaultBridge;
  function Harness() {
    const [snapshot, setSnapshot] = useState(initial);
    const [notice, setNotice] = useState(initialNotice);
    return (
      <VaultLibrary
        bridge={bridge}
        snapshot={snapshot}
        busy={false}
        notice={notice}
        setNotice={setNotice}
        // As VaultApp's: a failure is reported as the notice.
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
        cameraPlatform={cameraPlatform}
      />
    );
  }
  render(<Harness />);
  return bridge;
}

describe("taking a photo from the library", () => {
  it("opens with no message left over from the library", async () => {
    renderLibrary(base, {}, "windows", "Vault unlocked.");
    expect(screen.getByText("Vault unlocked.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    const camera = screen.getByRole("dialog", { name: "Take a photo" });
    await waitFor(() =>
      expect(within(camera).getByRole("status")).not.toHaveTextContent(
        "Vault unlocked.",
      ),
    );
    expect(screen.queryByText("Vault unlocked.")).toBeNull();
  });

  it("shows a save that failed in the camera window, which stays open", async () => {
    renderLibrary(base, {
      savePhoto: vi.fn(async () => {
        throw { code: "storage", message: "FAKE" };
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    const camera = screen.getByRole("dialog", { name: "Take a photo" });
    const shutter = within(camera).getByRole("button", { name: "Take photo" });
    await waitFor(() => expect(shutter).toBeEnabled());
    fireEvent.click(shutter);
    fireEvent.click(within(camera).getByRole("button", { name: "Use photo" }));
    await waitFor(() =>
      expect(within(camera).getByRole("status")).toHaveTextContent(
        vaultErrorMessage({ code: "storage", message: "FAKE" }),
      ),
    );
    expect(camera).toBeVisible();
  });

  it("is offered on a computer", () => {
    renderLibrary(base);
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeEnabled();
  });

  it("keeps the library out of reach while open, and gives the focus back", async () => {
    renderLibrary(base);
    const take = screen.getByRole("button", { name: "Take a photo" });
    take.focus();
    fireEvent.click(take);
    const camera = screen.getByRole("dialog", { name: "Take a photo" });
    expect(take.closest("[inert]")).not.toBeNull();
    await waitFor(() =>
      expect(
        within(camera).getByRole("button", { name: "Take photo" }),
      ).toBeEnabled(),
    );
    fireEvent.click(within(camera).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(take.closest("[inert]")).toBeNull();
    await waitFor(() => expect(take).toHaveFocus());
  });

  it("is not offered on a phone or tablet", () => {
    renderLibrary(base, {}, null);
    expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
  });

  it("is not offered while the vault is read-only", () => {
    renderLibrary({ ...base, recovery: "writeFailed" });
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeDisabled();
  });

  it("saves into the open folder, then opens the new photo to be renamed", async () => {
    const bridge = renderLibrary(base);
    const sidebar = screen.getByRole("navigation", { name: "Record library" });
    fireEvent.click(
      within(sidebar).getByRole("button", { name: /^FAKE Cards/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    const camera = screen.getByRole("dialog", { name: "Take a photo" });
    const shutter = within(camera).getByRole("button", { name: "Take photo" });
    await waitFor(() => expect(shutter).toBeEnabled());
    fireEvent.click(shutter);
    fireEvent.click(within(camera).getByRole("button", { name: "Use photo" }));

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
      name: "Photo, 17 Oct 2026, 3.05 PM.jpg",
    });
    expect(screen.queryByRole("dialog", { name: "Take a photo" })).toBeNull();
    expect(
      within(details).getByRole("button", { name: "Rename document" }),
    ).toBeEnabled();
    await waitFor(() =>
      expect(within(details).getByRole("status")).toHaveTextContent(
        "Photo saved as Photo, 17 Oct 2026, 3.05 PM.jpg.",
      ),
    );
  });

  it("says when the same photo is already in the vault", async () => {
    renderLibrary(base, {
      savePhoto: vi.fn(async () => ({
        imported: [],
        skippedDuplicates: ["Photo, 17 Oct 2026, 3.05 PM.jpg"],
      })),
    });
    fireEvent.click(screen.getByRole("button", { name: "Take a photo" }));
    const shutter = screen.getByRole("button", { name: "Take photo" });
    await waitFor(() => expect(shutter).toBeEnabled());
    fireEvent.click(shutter);
    fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
    expect(
      await screen.findByText(
        "This photo is already in the vault, so it was not saved again.",
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
      screen.getByRole("button", { name: `More options for ${name}` }),
    );
    return screen.getByRole("dialog", { name });
  };

  it("is offered when the vault says the file is a JPEG, whatever its name, and fetched only to be shown", async () => {
    const bridge = renderLibrary(withRecords);
    const details = openDetails("FAKE insurance card");
    const view = await within(details).findByRole("button", {
      name: "View photo",
    });
    expect(bridge.isPhoto).toHaveBeenCalledWith("card");
    // The details only ask whether it is a photo; the photo stays native.
    expect(bridge.viewPhoto).not.toHaveBeenCalled();
    fireEvent.click(view);
    expect(bridge.viewPhoto).toHaveBeenCalledWith("card");

    // The viewer replaces the details, under the same name.
    const photo = await screen.findByRole("img", {
      name: "Photo: FAKE insurance card",
    });
    const viewer = photo.closest<HTMLElement>('[role="dialog"]')!;
    expect(viewer).toHaveAccessibleName("FAKE insurance card");
    expect(photo).toHaveAttribute("src", PHOTO_URL);
    await waitFor(() =>
      expect(
        within(viewer).getByRole("button", { name: "Close" }),
      ).toHaveFocus(),
    );
    expect(
      within(viewer).getByRole("button", { name: "Zoom out" }),
    ).toBeDisabled();
    fireEvent.click(within(viewer).getByRole("button", { name: "Zoom in" }));
    expect(within(viewer).getByRole("status")).toHaveTextContent(
      "Zoomed to 150%.",
    );
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("dialog", { name: "FAKE insurance card" }),
    ).toHaveAttribute("aria-describedby", "native-record-about");
    // Closed, the photo is dropped; showing it again fetches it again.
    expect(screen.queryByRole("img", { name: /^Photo: / })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View photo" }));
    await screen.findByRole("img", { name: "Photo: FAKE insurance card" });
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
      await within(details).findByRole("button", { name: "View photo" }),
    );
    await waitFor(() =>
      expect(within(details).getByRole("status")).toHaveTextContent(
        "FAKE This is not a photo.",
      ),
    );
    expect(screen.queryByRole("img", { name: /^Photo: / })).toBeNull();
  });

  it("is not offered when the file is not a photo, and a PDF is not asked about", async () => {
    const bridge = renderLibrary(withRecords, {
      isPhoto: vi.fn(async () => false),
    });
    openDetails("FAKE insurance card");
    await waitFor(() => expect(bridge.isPhoto).toHaveBeenCalledWith("card"));
    expect(screen.queryByRole("button", { name: "View photo" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Close document details" }),
    );

    openDetails("FAKE results.pdf");
    expect(bridge.isPhoto).toHaveBeenCalledTimes(1);
    expect(bridge.viewPhoto).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "View photo" })).toBeNull();
  });
});
