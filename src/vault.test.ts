import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: (value: unknown) => void = () => undefined;
  },
}));

import { setLocaleOverride } from "./i18n";
import {
  boxesWithControlCharacters,
  createVaultBridge,
  NATIVE_READER_ACTIVITY_EVENT,
  isCancelledError,
  isLockedError,
  isMissingVaultError,
  isWrongPdfPassword,
  localDateText,
  namedDamage,
  vaultErrorMessage,
  type VaultRecord,
} from "./vault";

describe("native idle deadline bridge", () => {
  beforeEach(() => invoke.mockReset());

  it("passes native-reader activity without document bytes and stops forwarding on close", async () => {
    let resolve!: () => void;
    invoke.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const listener = vi.fn();
    window.addEventListener(NATIVE_READER_ACTIVITY_EVENT, listener);
    try {
      const opened = createVaultBridge().readNativePdf("FAKE record", "Close");
      const [command, args] = invoke.mock.calls[0];
      expect(command).toBe("vault_read_native_pdf");
      expect(Object.keys(args.request).sort()).toEqual([
        "activity",
        "closeLabel",
        "recordId",
      ]);
      args.request.activity.onmessage(null);
      expect(listener).toHaveBeenCalledOnce();
      resolve();
      await opened;
      args.request.activity.onmessage(null);
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(NATIVE_READER_ACTIVITY_EVENT, listener);
    }
  });

  it("sends the commands and arguments the native side registers", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValue(undefined);
    await bridge.touch();
    await bridge.setAutoLock(3);
    expect(invoke.mock.calls).toEqual([
      ["vault_touch"],
      ["vault_set_auto_lock", { request: { minutes: 3 } }],
    ]);
    invoke.mockResolvedValue({
      longEnough: true,
      notAName: true,
      hardToGuess: true,
    });
    await bridge.passphraseRules("river azimuth cobalt", "Jamie");
    expect(invoke).toHaveBeenLastCalledWith("vault_passphrase_rules", {
      request: {
        passphrase: "river azimuth cobalt",
        initialProfileName: "Jamie",
      },
    });
    invoke.mockResolvedValue({ platform: "ios", architecture: "arm64" });
    await expect(bridge.platform()).resolves.toBe("ios");
    expect(invoke).toHaveBeenLastCalledWith("runtime_info");
  });

  it("sends the shared-file commands the native side registers", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValue(undefined);
    await bridge.listReceived();
    await bridge.acceptReceived();
    await bridge.moveToPerson(["record-1"], "profile-1", ["folder-1"]);
    await bridge.viewPage("record-1", 0, 800);
    await bridge.viewPage("record-1", 1, 800, "FAKE-portal-2026");
    expect(invoke.mock.calls).toEqual([
      ["received_list"],
      ["received_accept"],
      [
        "vault_move_to_person",
        {
          request: {
            recordIds: ["record-1"],
            profileId: "profile-1",
            folderIds: ["folder-1"],
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

  it("sends a photo as one body: its target's length, the target, then the JPEG", async () => {
    const bridge = createVaultBridge();
    const sent: Uint8Array[] = [];
    invoke.mockImplementation(async (_command: string, body: Uint8Array) => {
      sent.push(body.slice());
      return { imported: ["photo-1"], skippedDuplicates: [] };
    });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    await bridge.savePhoto(
      "profile-1",
      ["folder-1"],
      "Photo, 17 paź 2026, 3.05 PM.jpg",
      jpeg,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    // No custom headers: WebView2 does not pass them on.
    expect(invoke.mock.calls[0]).toHaveLength(2);
    expect(invoke.mock.calls[0][0]).toBe("vault_save_photo");
    const [request] = sent;
    const length = new DataView(request.buffer).getUint32(0);
    expect(
      JSON.parse(new TextDecoder().decode(request.slice(4, 4 + length))),
    ).toEqual({
      profileId: "profile-1",
      folderIds: ["folder-1"],
      name: "Photo, 17 paź 2026, 3.05 PM.jpg",
    });
    expect([...request.slice(4 + length)]).toEqual([...jpeg]);
    // Its own copy of the photo is overwritten once the call is over.
    expect([...invoke.mock.calls[0][1]].every((byte) => byte === 0)).toBe(true);
    invoke.mockReset();
    invoke.mockResolvedValue(true);
    await expect(bridge.isPhoto("record-1")).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("vault_is_photo", {
      request: { recordId: "record-1" },
    });
    invoke.mockResolvedValue("data:image/jpeg;base64,/9j/");
    await expect(bridge.viewPhoto("record-1")).resolves.toBe(
      "data:image/jpeg;base64,/9j/",
    );
    expect(invoke).toHaveBeenLastCalledWith("vault_view_photo", {
      request: { recordId: "record-1" },
    });
  });

  it("sends the locked-PDF commands the native side registers (#54)", async () => {
    const bridge = createVaultBridge();
    invoke.mockResolvedValue(true);
    await expect(bridge.isLockedPdf("record-1")).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("vault_is_locked_pdf", {
      request: { recordId: "record-1" },
    });
    invoke.mockResolvedValue({ recordId: "copy-1", originalName: "FAKE" });
    await bridge.unlockPdf("record-1", "FAKE-portal-2026");
    expect(invoke).toHaveBeenLastCalledWith("vault_unlock_pdf", {
      request: { recordId: "record-1", password: "FAKE-portal-2026" },
    });
    expect(isWrongPdfPassword({ code: "pdf_wrong_password" })).toBe(true);
    expect(isWrongPdfPassword({ code: "pdf_unlock_failed" })).toBe(false);
    expect(isWrongPdfPassword(null)).toBe(false);
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

  it("names the boxes to check when what was typed is refused (#69)", () => {
    const refused = {
      code: "invalid",
      message: "Something you typed wasn't accepted. Check it and try again.",
    };
    expect(vaultErrorMessage(refused, ["box.folderName"])).toBe(
      "Check the folder name, then try again.",
    );
    expect(
      vaultErrorMessage(refused, ["box.recoveryKey", "box.newPassphrase"]),
    ).toBe("Check the recovery key and the new passphrase, then try again.");
    expect(
      vaultErrorMessage(refused, [
        "box.name",
        "box.passphrase",
        "box.recoveryKey",
      ]),
    ).toBe(
      "Check the name, the passphrase and the recovery key, then try again.",
    );
    // Without boxes, and for any other failure, the message is as it was.
    expect(vaultErrorMessage(refused)).toBe(refused.message);
    expect(vaultErrorMessage(refused, [])).toBe(refused.message);
    expect(
      vaultErrorMessage({ code: "storage", message: "No." }, ["box.name"]),
    ).toBe("No.");
  });

  it("names at setup only a box whose text the vault refuses (#69)", () => {
    expect(
      boxesWithControlCharacters([
        ["Jamie", "box.name"],
        ["river azimuth cobalt\tsparrow", "box.passphrase"],
      ]),
    ).toEqual(["box.passphrase"]);
    // Nothing typed that the vault refuses: no box takes the blame.
    expect(
      boxesWithControlCharacters([
        ["Jamie", "box.name"],
        ["river azimuth cobalt sparrow", "box.passphrase"],
      ]),
    ).toBeUndefined();
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

describe("errors the app words itself, in the language in use (#46)", () => {
  afterEach(() => setLocaleOverride(null));
  const refused = { code: "invalid", message: "Native text." };

  it("names the boxes to check, joined as the language joins a list", () => {
    setLocaleOverride("fr");
    expect(
      vaultErrorMessage(refused, ["box.recoveryKey", "box.newPassphrase"]),
    ).toBe(
      "Vérifiez la clé de récupération et la nouvelle phrase secrète, puis réessayez.",
    );
    setLocaleOverride("pl");
    expect(
      vaultErrorMessage(refused, [
        "box.name",
        "box.passphrase",
        "box.recoveryKey",
      ]),
    ).toBe(
      "Proszę sprawdzić nazwę, hasło główne i klucz odzyskiwania, a potem spróbować ponownie.",
    );
    setLocaleOverride("es");
    expect(vaultErrorMessage(refused, ["box.folderName"])).toBe(
      "Revise el nombre de la carpeta y vuelva a intentarlo.",
    );
  });

  it("says how long to wait with the language's plural forms", () => {
    setLocaleOverride("pl");
    const wait = (ms: number) =>
      vaultErrorMessage({
        code: "too_many_attempts",
        message: "X",
        retryAfterMs: ms,
      });
    expect(wait(1000)).toBe("X Proszę spróbować ponownie za 1 sekundę.");
    expect(wait(2000)).toBe("X Proszę spróbować ponownie za 2 sekundy.");
    expect(wait(5000)).toBe("X Proszę spróbować ponownie za 5 sekund.");
    setLocaleOverride("pt-BR");
    expect(wait(1000)).toBe("X Tente de novo em 1 segundo.");
  });

  it("words its own fallback, and a backup refused over a damaged document", () => {
    setLocaleOverride("es");
    expect(vaultErrorMessage(null)).toBe(
      "No se pudo completar la operación en la bóveda.",
    );
    setLocaleOverride("pt-BR");
    const vault = {
      profiles: [
        { id: "p1", displayName: "Jamie", createdAtMs: 1 },
        { id: "p2", displayName: "Avery", createdAtMs: 1 },
      ],
      records: [
        {
          id: "record-2",
          profileId: "p2",
          folderIds: [],
          displayName: "FAKE_Scan.pdf",
          sourceLabel: "Manual import",
          mediaType: "application/pdf",
          plaintextSize: 10,
          importedAtMs: Date.UTC(2026, 0, 15, 12),
          available: true,
        },
      ],
    };
    const named = namedDamage(
      { code: "damaged_document", message: "Native.", recordId: "record-2" },
      vault,
    ) as { message: string };
    // The date as the computer writes it, in a Portuguese sentence.
    const date = new Date(Date.UTC(2026, 0, 15, 12)).toLocaleDateString();
    expect(named.message).toContain(
      `Nenhuma cópia de segurança foi salva: o documento “FAKE_Scan.pdf” (adicionado em ${date}, nos documentos de Avery)`,
    );
  });
});
