import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  createVaultBridge,
  isCancelledError,
  isLockedError,
  isMissingVaultError,
  namedDamage,
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

  it("leaves any other error, or a document it cannot find, as it was", () => {
    const vault = { profiles: [], records: [record("record-1", "p1")] };
    expect(namedDamage(damaged, vault)).toBe(damaged);
    const other = { code: "storage", message: "No." };
    expect(namedDamage(other, vault)).toBe(other);
  });
});
