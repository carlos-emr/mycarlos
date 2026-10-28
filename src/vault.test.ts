import { humanValue } from "./test/humanText";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { setLocaleOverride } from "./i18n";
import { setDeviceLocale } from "./test/deviceLocale";
import {
  boxesWithControlCharacters,
  createVaultBridge,
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

  it("keeps the link and approval action in one native call and preserves partial state", async () => {
    const bridge = createVaultBridge();
    const request = {
      portalBase: "https://portal.example.test/patient",
      code: "FAKE0001-FAKE7-Q2M4K",
      deviceName: "FAKE receiving device",
      profileId: null,
    };
    const result = {
      link: { id: "FAKE original link", deviceKeyId: "FAKE original key" },
      approvalError: {
        code: "portal_link_incomplete",
        message: "FAKE lost reply",
      },
    };
    invoke.mockResolvedValue(result);
    await expect(bridge.connectPortal!(request)).resolves.toEqual(result);
    expect(invoke.mock.calls).toEqual([["vault_portal_connect", { request }]]);
  });

  it("checks one device's approval in one read-only native call (#131)", async () => {
    const bridge = createVaultBridge();
    const result = {
      link: { id: "FAKE link", deviceKeyId: "FAKE key" },
      expiresInMs: 120_000,
      issue: null,
    };
    invoke.mockResolvedValue(result);
    await expect(bridge.refreshDeviceApproval!("FAKE link")).resolves.toEqual(
      result,
    );
    expect(invoke.mock.calls).toEqual([
      ["vault_refresh_device_approval", { linkId: "FAKE link" }],
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
    expect(humanValue(named.message)).toMatch(
      humanValue(
        /^No backup was saved: the document "FAKE_Scan\.pdf" \(added .+, in Avery's records\)/,
      ),
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
    expect(humanValue(vaultErrorMessage(named))).toMatch(
      humanValue(
        /^No backup was saved: the document .* An empty file \(0 bytes\) may be left\.$/,
      ),
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
      humanValue(
        vaultErrorMessage({
          code: "storage",
          message: "No backup was saved.",
          note: "An empty file (0 bytes) may be left.",
        }),
      ),
    ).toBe(
      humanValue("No backup was saved. An empty file (0 bytes) may be left."),
    );
    expect(
      humanValue(vaultErrorMessage({ code: "storage", message: "No." })),
    ).toBe(humanValue("No."));
  });

  it("names the boxes to check when what was typed is refused (#69)", () => {
    const refused = {
      code: "invalid",
      message: "Something you typed wasn't accepted. Check it and try again.",
    };
    expect(humanValue(vaultErrorMessage(refused, ["box.folderName"]))).toBe(
      humanValue("Check the folder name, then try again."),
    );
    expect(
      humanValue(
        vaultErrorMessage(refused, ["box.recoveryKey", "box.newPassphrase"]),
      ),
    ).toBe(
      humanValue(
        "Check the recovery key and the new passphrase, then try again.",
      ),
    );
    expect(
      humanValue(
        vaultErrorMessage(refused, [
          "box.name",
          "box.passphrase",
          "box.recoveryKey",
        ]),
      ),
    ).toBe(
      humanValue(
        "Check the name, the passphrase and the recovery key, then try again.",
      ),
    );
    // Without boxes, and for any other failure, the message is as it was.
    expect(humanValue(vaultErrorMessage(refused))).toBe(
      humanValue(refused.message),
    );
    expect(humanValue(vaultErrorMessage(refused, []))).toBe(
      humanValue(refused.message),
    );
    expect(
      humanValue(
        vaultErrorMessage({ code: "storage", message: "No." }, ["box.name"]),
      ),
    ).toBe(humanValue("No."));
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
    expect(humanValue(vaultErrorMessage(waiting))).toBe(
      humanValue(`${waiting.message} Try again in 5 seconds.`),
    );
    expect(
      humanValue(vaultErrorMessage({ ...waiting, retryAfterMs: 900 })),
    ).toMatch(humanValue(/Try again in 1 second\.$/));
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
      humanValue(
        vaultErrorMessage(refused, ["box.recoveryKey", "box.newPassphrase"]),
      ),
    ).toBe(
      humanValue(
        "Vérifiez la clé de récupération et la nouvelle phrase secrète, puis réessayez.",
      ),
    );
    setLocaleOverride("pl");
    expect(
      humanValue(
        vaultErrorMessage(refused, [
          "box.name",
          "box.passphrase",
          "box.recoveryKey",
        ]),
      ),
    ).toBe(
      humanValue(
        "Proszę sprawdzić nazwę, hasło główne i klucz odzyskiwania, a potem spróbować ponownie.",
      ),
    );
    setLocaleOverride("es");
    expect(humanValue(vaultErrorMessage(refused, ["box.folderName"]))).toBe(
      humanValue("Revise el nombre de la carpeta y vuelva a intentarlo."),
    );
  });

  it("says a clinic portal asked to wait, and for how long if it said (#131)", () => {
    const asked = { code: "portal_rate_limited", message: "Native text." };
    setLocaleOverride("fr");
    expect(vaultErrorMessage(asked)).toBe(
      "Le portail de la clinique a demandé à myCarlos d’attendre avant de réessayer.",
    );
    expect(
      vaultErrorMessage({ code: "approval_reply_invalid", message: "Native." }),
    ).toBe(
      "La réponse du portail de la clinique au sujet de cette demande n’a pas pu être vérifiée. Elle n’a donc pas été utilisée. Communiquez avec votre clinique.",
    );
    expect(
      vaultErrorMessage({ code: "approval_still_open", message: "Native." }),
    ).toBe(
      "Cette demande d’approbation est toujours ouverte sur le portail de la clinique. Attendez qu’elle prenne fin avant d’en créer une nouvelle.",
    );
    setLocaleOverride("en");
    expect(vaultErrorMessage({ ...asked, retryAfterMs: 30_000 })).toBe(
      "The clinic portal asked myCarlos to wait before trying again. Try again in 30 seconds.",
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
    expect(humanValue(wait(1000))).toBe(
      humanValue("X Proszę spróbować ponownie za 1 sekundę."),
    );
    expect(humanValue(wait(2000))).toBe(
      humanValue("X Proszę spróbować ponownie za 2 sekundy."),
    );
    expect(humanValue(wait(5000))).toBe(
      humanValue("X Proszę spróbować ponownie za 5 sekund."),
    );
    setLocaleOverride("pt-BR");
    expect(humanValue(wait(1000))).toBe(
      humanValue("X Tente de novo em 1 segundo."),
    );
  });

  it("words its own fallback, and a backup refused over a damaged document", () => {
    setLocaleOverride("es");
    expect(humanValue(vaultErrorMessage(null))).toBe(
      humanValue("No se pudo completar la operación en la bóveda."),
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
    expect(humanValue(named.message)).toContain(
      humanValue(
        `Nenhuma cópia de segurança foi salva: o documento “FAKE_Scan.pdf” (adicionado em ${date}, nos documentos de Avery)`,
      ),
    );
    // A Canadian computer writes 2026-01-15 whatever language myCarlos uses
    // (Ben, 21 Oct, kept 28 Oct), and the message is worded when it is read.
    setDeviceLocale("en-CA");
    for (const locale of ["fr", "pt-BR"] as const) {
      setLocaleOverride(locale);
      expect(named.message, locale).toContain("2026-01-15");
    }
  });
});

describe("localized native presentation contracts", () => {
  it("sends only the selected locale and operation data to native confirmations", async () => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
    setLocaleOverride("fr");
    const bridge = createVaultBridge();
    await bridge.confirmRecoveryKey([{ index: 0, value: "FAKE" }]);
    await bridge.saveRecoveryKit();
    await bridge.pickRestoreSource();
    await bridge.restore("pick", { passphrase: "FAKE" }, true);
    await bridge.pickImportFiles("person", []);
    await bridge.reset("RESET MYCARLOS VAULT");
    expect(invoke.mock.calls).toEqual([
      [
        "vault_recovery_key_confirm",
        { locale: "fr", request: { groups: [{ index: 0, value: "FAKE" }] } },
      ],
      ["vault_recovery_kit_save", { locale: "fr" }],
      ["vault_restore_pick", { locale: "fr" }],
      [
        "vault_restore",
        {
          locale: "fr",
          request: { pickId: "pick", passphrase: "FAKE", replace: true },
        },
      ],
      [
        "vault_import_pick",
        { locale: "fr", request: { profileId: "person", folderIds: [] } },
      ],
      [
        "vault_reset",
        { locale: "fr", request: { confirmation: "RESET MYCARLOS VAULT" } },
      ],
    ]);
  });
  it("retains a damaged document identity and resolves its existing message again on language change", () => {
    setLocaleOverride("en");
    const error = namedDamage(
      { code: "damaged_document", recordId: "record", message: "Native" },
      {
        profiles: [
          { id: "person", displayName: "FAKE {where}", createdAtMs: 1 },
        ],
        records: [
          {
            id: "record",
            profileId: "person",
            folderIds: [],
            displayName: "FAKE_{where}.pdf",
            sourceLabel: "Manual import",
            mediaType: "application/pdf",
            plaintextSize: 1,
            importedAtMs: Date.UTC(2026, 0, 15, 12),
            available: false,
          },
        ],
      },
    ) as { message: string };
    expect(humanValue(error.message)).toContain(
      humanValue('No backup was saved: the document "FAKE_{where}.pdf"'),
    );
    setLocaleOverride("pt-BR");
    expect(humanValue(error.message)).toContain(
      humanValue("Nenhuma cópia de segurança foi salva"),
    );
    expect(humanValue(error.message)).toContain(humanValue("FAKE_{where}.pdf"));
    expect(humanValue(vaultErrorMessage(error))).toBe(
      humanValue(error.message),
    );
  });

  it("says a vault or backup a newer myCarlos saved needs an update, not that it is damaged", () => {
    const vault = { code: "vault_newer_format", message: "Native text." };
    const backup = { code: "backup_newer_format", message: "Native text." };
    expect(vaultErrorMessage(vault)).toBe(
      "This vault was saved by a newer version of myCarlos. Update myCarlos to open it. Nothing was changed.",
    );
    expect(vaultErrorMessage(backup)).toBe(
      "This backup was saved by a newer version of myCarlos. Update myCarlos to restore it. Nothing on this device was changed.",
    );
    setLocaleOverride("fr");
    expect(vaultErrorMessage(vault)).toBe(
      "Ce coffre-fort a été enregistré par une version plus récente de myCarlos. Mettez myCarlos à jour pour l’ouvrir. Rien n’a été modifié.",
    );
    setLocaleOverride("es");
    expect(vaultErrorMessage(backup)).toBe(
      "Esta copia de seguridad se guardó con una versión más reciente de myCarlos. Actualice myCarlos para restaurarla. No se cambió nada en este dispositivo.",
    );
    setLocaleOverride("pl");
    expect(vaultErrorMessage(vault)).toBe(
      "Ten sejf został zapisany przez nowszą wersję myCarlos. Proszę zaktualizować myCarlos, aby go otworzyć. Nic nie zostało zmienione.",
    );
    setLocaleOverride("pt-BR");
    expect(vaultErrorMessage(backup)).toBe(
      "Esta cópia de segurança foi salva por uma versão mais recente do myCarlos. Atualize o myCarlos para restaurá-la. Nada foi alterado neste dispositivo.",
    );
    // Any other code keeps the native text, and a code that only looks
    // like an object key is not one.
    expect(vaultErrorMessage({ code: "corrupt", message: "Native." })).toBe(
      "Native.",
    );
    expect(vaultErrorMessage({ code: "toString", message: "Native." })).toBe(
      "Native.",
    );
  });
});
