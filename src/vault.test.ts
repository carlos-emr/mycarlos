import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  createVaultBridge,
  isCancelledError,
  isLockedError,
  isMissingVaultError,
  localDateText,
  namedDamage,
  vaultErrorMessage,
  type VaultRecord,
} from "./vault";

describe("native idle deadline bridge", () => {
  beforeEach(() => invoke.mockReset());

  it("sends the commands and arguments the native side registers", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValue(undefined);
    await bridge.touch();
    await bridge.setAutoLock(3);
    expect(invoke.mock.calls).toEqual([
      ["vault_touch"],
      ["vault_set_auto_lock", { request: { minutes: 3 } }],
    ]);
    invoke.mockResolvedValue({ platform: "ios", architecture: "arm64" });
    await expect(bridge.platform()).resolves.toBe("ios");
    expect(invoke).toHaveBeenLastCalledWith("runtime_info");
  });

  it("sends a photo as the raw body, with its folder and name in headers", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValue({ imported: ["photo-1"], skippedDuplicates: [] });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await bridge.savePhoto(
      "profile-1",
      ["folder-1"],
      "Photo, 17 paź 2026, 3.05 PM.jpg",
      jpeg,
    );
    await bridge.savePhoto("profile-1", [], "Photo.jpg", jpeg);
    expect(invoke.mock.calls).toEqual([
      [
        "vault_save_photo",
        jpeg,
        {
          headers: {
            "Mycarlos-Profile-Id": "profile-1",
            "Mycarlos-Folder-Ids": "folder-1",
            "Mycarlos-Photo-Name":
              "Photo%2C%2017%20pa%C5%BA%202026%2C%203.05%20PM.jpg",
          },
        },
      ],
      [
        "vault_save_photo",
        jpeg,
        {
          headers: {
            "Mycarlos-Profile-Id": "profile-1",
            "Mycarlos-Folder-Ids": "",
            "Mycarlos-Photo-Name": "Photo.jpg",
          },
        },
      ],
    ]);
    invoke.mockResolvedValue("data:image/jpeg;base64,/9j/");
    await expect(bridge.viewPhoto("record-1")).resolves.toBe(
      "data:image/jpeg;base64,/9j/",
    );
    expect(invoke).toHaveBeenLastCalledWith("vault_view_photo", {
      request: { recordId: "record-1" },
    });
  });

  it("reads error codes only from objects that carry them", () => {
    for (const check of [
      isLockedError,
      isCancelledError,
      isMissingVaultError,
    ]) {
      expect(check(null)).toBe(false);
      expect(check(undefined)).toBe(false);
      expect(check("locked")).toBe(false);
    }
    expect(isCancelledError({ code: "cancelled" })).toBe(true);
  });
});

describe("a backup refused over a damaged document", () => {
  const record = (id: string, profileId: string): VaultRecord => ({
    id,
    profileId,
    folderIds: [],
    displayName: "FAKE_Scan.pdf",
    sourceLabel: "Manual import",
    mediaType: "application/pdf",
    plaintextSize: 10,
    importedAtMs: Date.UTC(2026, 0, 15, 12),
    available: true,
  });
  const damaged = {
    code: "damaged_document",
    message: "A document in the vault is damaged.",
    recordId: "record-2",
  };

  it("names the document, and whose it is when there is more than one person", () => {
    const vault = {
      profiles: [
        { id: "p1", displayName: "Jamie", createdAtMs: 1 },
        { id: "p2", displayName: "Avery", createdAtMs: 1 },
      ],
      records: [record("record-1", "p1"), record("record-2", "p2")],
    };
    const named = namedDamage(damaged, vault) as { message: string };
    expect(named.message).toMatch(
      /^No backup was saved: the document "FAKE_Scan\.pdf" \(added .+, in Avery's records\)/,
    );
    const alone = namedDamage(damaged, {
      profiles: [vault.profiles[1]],
      records: vault.records,
    }) as { message: string };
    expect(alone.message).not.toContain("records)");
  });

  it("keeps the note about what may be left where it was saved", () => {
    const vault = {
      profiles: [{ id: "p1", displayName: "Jamie", createdAtMs: 1 }],
      records: [record("record-2", "p1")],
    };
    const named = namedDamage(
      { ...damaged, note: "An empty file (0 bytes) may be left." },
      vault,
    );
    expect(vaultErrorMessage(named)).toMatch(
      /^No backup was saved: the document .* An empty file \(0 bytes\) may be left\.$/,
    );
  });

  it("leaves any other error, or a document it cannot find, as it was", () => {
    const vault = { profiles: [], records: [record("record-1", "p1")] };
    expect(namedDamage(damaged, vault)).toBe(damaged);
    const other = { code: "storage", message: "No." };
    expect(namedDamage(other, vault)).toBe(other);
  });
});

describe("error messages", () => {
  it("adds the note about how a failure came about", () => {
    expect(
      vaultErrorMessage({
        code: "storage",
        message: "No backup was saved.",
        note: "An empty file (0 bytes) may be left.",
      }),
    ).toBe("No backup was saved. An empty file (0 bytes) may be left.");
    expect(vaultErrorMessage({ code: "storage", message: "No." })).toBe("No.");
  });

  it("says how long to wait after several wrong tries", () => {
    const waiting = {
      code: "too_many_attempts",
      message:
        "There have been several wrong tries in a row. To slow down anyone guessing, myCarlos waits a little before the next one: what you typed was not checked.",
      retryAfterMs: 4_200,
    };
    expect(vaultErrorMessage(waiting)).toBe(
      `${waiting.message} Try again in 5 seconds.`,
    );
    expect(vaultErrorMessage({ ...waiting, retryAfterMs: 900 })).toMatch(
      /Try again in 1 second\.$/,
    );
  });

  it("gives today on the patient's own calendar", () => {
    expect(localDateText(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});
