import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  createVaultBridge,
  isCancelledError,
  isLockedError,
  isMissingVaultError,
  isWrongPdfPassword,
  localDateText,
  namedDamage,
  notPdfReceivedId,
  receivedRefusal,
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

  it("sends the shared-file commands the native side registers", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValue(undefined);
    await bridge.listReceived();
    await bridge.importReceived(["shared-1"], "profile-1", ["folder-1"]);
    await bridge.discardReceived(["shared-2"]);
    await bridge.unlockReceived(
      "shared-3",
      "FAKE-portal-2026",
      "profile-1",
      [],
    );
    await bridge.viewPage("record-1", 0, 800);
    await bridge.viewPage("record-1", 1, 800, "FAKE-portal-2026");
    expect(invoke.mock.calls).toEqual([
      ["received_list"],
      [
        "received_import",
        {
          request: {
            ids: ["shared-1"],
            profileId: "profile-1",
            folderIds: ["folder-1"],
          },
        },
      ],
      ["received_discard", { request: { ids: ["shared-2"] } }],
      [
        "received_unlock",
        {
          request: {
            id: "shared-3",
            password: "FAKE-portal-2026",
            profileId: "profile-1",
            folderIds: [],
          },
        },
      ],
      [
        "vault_view_page",
        {
          request: {
            recordId: "record-1",
            page: 0,
            width: 800,
            password: null,
          },
        },
      ],
      [
        "vault_view_page",
        {
          request: {
            recordId: "record-1",
            page: 1,
            width: 800,
            password: "FAKE-portal-2026",
          },
        },
      ],
    ]);
  });

  it("names the shared file an add left out, and why", () => {
    for (const reason of [
      "not_pdf",
      "pdf_locked",
      "pdf_unlock_failed",
      "pdf_unlock_unavailable",
      "pdf_too_large",
    ] as const)
      expect(
        receivedRefusal({ code: reason, message: "FAKE", receivedId: "s-1" }),
      ).toEqual({ id: "s-1", reason });
    expect(receivedRefusal({ code: "pdf_locked", message: "FAKE" })).toBeNull();
    expect(
      receivedRefusal({ code: "storage", message: "FAKE", receivedId: "s-1" }),
    ).toBeNull();
    // A wrong password is asked again, not marked on the file.
    expect(
      receivedRefusal({ code: "pdf_wrong_password", receivedId: "s-1" }),
    ).toBeNull();
    expect(isWrongPdfPassword({ code: "pdf_wrong_password" })).toBe(true);
    expect(isWrongPdfPassword({ code: "pdf_locked" })).toBe(false);
    expect(isWrongPdfPassword(null)).toBe(false);
  });

  it("names the shared file an import refused as not a PDF", () => {
    expect(
      notPdfReceivedId({
        code: "not_pdf",
        message: "FAKE",
        receivedId: "shared-1",
      }),
    ).toBe("shared-1");
    expect(notPdfReceivedId({ code: "not_pdf", message: "FAKE" })).toBeNull();
    expect(
      notPdfReceivedId({ code: "storage", receivedId: "shared-1" }),
    ).toBeNull();
    expect(notPdfReceivedId(null)).toBeNull();
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
