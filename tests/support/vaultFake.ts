import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { MessageKey } from "../../src/i18n/locales/fluent/keys";
import type { VaultStart } from "./a11y";
import { translate } from "./fluent";

// A fake native side for specs that follow a whole flow to its outcome:
// reading a document, unlocking, saving a copy, hiding, clinic documents and
// recovery keys. Its vault and its answers are copied from `fakeVault` in
// tests/support/a11y.ts, which stays as it is (other specs, and open PRs,
// rely on it). Unlike that one, this fake:
// - records every command with its arguments (fakeCalls), so that a spec can
//   check what the screens asked the native side to do;
// - refuses as the native side does, in its error shape (`PublicError` in
//   src-tauri/src/lib.rs: code, English message, messageKey): a wrong
//   passphrase, a document locked with its own password, a recovery key
//   typed back wrong;
// - can be given the next answer to a command (scriptFake): a refusal, a
//   cancelled picker, or a page still being drawn;
// - keeps its state in sessionStorage, so that it outlives page.reload() as
//   the native vault outlives a reload of its window.
// As in a11y.ts, a command it does not answer is kept in `__unexpectedIpc`
// (kept across reloads too) and thrown, so expectOnlyFakedCommands fails.

/** The passphrase the fake vault opens with: plain words, not a secret. */
export const FAKE_PASSPHRASE = "FAKE passphrase for the fake";
/** The password FAKE Locked.pdf is locked with. */
export const FAKE_DOCUMENT_PASSWORD = "FAKE document password";
/** How many pages every fake document has. */
export const FAKE_PAGE_COUNT = 3;
/** The clinic a fake link is to, and the document a check brings from it. */
export const FAKE_CLINIC = "FAKE Clinic";
export const FAKE_CLINIC_DOCUMENT = "FAKE Clinic letter.pdf";
/** The device code of the first link made, or of the link set up. */
export const FAKE_DEVICE_CODE = "FAKE-DEVICE-1";
/** Labels of the vault's recovery key, and of a key being set up. */
export const FAKE_KEY_LABEL = "FAKE-KEY1";
export const FAKE_NEW_KEY_LABEL = "FAKE-KEY2";

const PAGE_TEXT = "FAKE text of page {page} of {name}";

/** The text the fake gives for a page (from 1) of a document. */
export const fakePageText = (name: string, page: number) =>
  PAGE_TEXT.replace("{page}", String(page)).replace("{name}", name);

/** As the native side names a locked PDF's original once a copy is unlocked
 * (`locked_original_name` in src-tauri/src/lib.rs), for a name ending .pdf. */
export const lockedOriginalName = (name: string) =>
  `${name.replace(/\.pdf$/i, "").trimEnd()} (locked original)${name.match(/\.pdf$/i)?.[0] ?? ""}`;

// Crockford base32, as the vault writes recovery keys (src-tauri/src/vault.rs):
// the digits and letters but I, L, O and U.
const CROCKFORD = Array.from({ length: 36 }, (_, value) =>
  value.toString(36).toUpperCase(),
)
  .filter((symbol) => !"ILOU".includes(symbol))
  .join("");

/**
 * A recovery key as myCarlos shows one (7 groups of 4 letters and digits),
 * derived at run time from `seed`: the same seed gives the same key, and no
 * key is written in the tests. FAKE: it opens nothing but this fake.
 */
export function fakeRecoveryKey(seed: string): string {
  const bytes = createHash("sha256")
    .update(`FAKE myCarlos e2e recovery key seed: ${seed}`)
    .digest();
  const symbols = Array.from(
    bytes.subarray(0, 28),
    (byte) => CROCKFORD[byte % 32],
  ).join("");
  return (symbols.match(/.{4}/g) ?? []).join("-");
}

/** The same key with its last letter or digit changed: a typo. */
export function mistypedKey(key: string): string {
  const last = key.slice(-1);
  const other = CROCKFORD[(CROCKFORD.indexOf(last) + 1) % CROCKFORD.length];
  return key.slice(0, -1) + other;
}

/** A refusal as the native side sends it. */
export interface FakeRefusal {
  code: string;
  message: string;
  messageKey: string;
  retryAfterMs?: number;
}

export function refusal(
  code: string,
  messageKey: MessageKey,
  extra: { retryAfterMs?: number } = {},
): FakeRefusal {
  return { code, message: translate("en", messageKey), messageKey, ...extra };
}

/** The next answer to a command: a value, a refusal, or none ever (a page
 * still being drawn). */
export type FakeOutcome =
  | { resolve: unknown }
  | { reject: FakeRefusal }
  | { pending: true };

export interface FakeVaultSetup {
  start: VaultStart;
  /** The vault's recovery key, or null for none. Default: one, derived. */
  recoveryKey?: string | null;
  /** The key a recovery key setup makes. Default: one, derived. */
  newRecoveryKey?: string;
  /** Adds FAKE Locked.pdf, locked with FAKE_DOCUMENT_PASSWORD. */
  lockedPdf?: boolean;
  /** Clinic linking is built in: with no clinic linked yet, or with one
   * linked and approved. */
  portal?: "unlinked" | "linked";
}

// The refusals the fake makes itself, by message key, in English as the
// native side sends them (the screens show the messageKey's own text).
const NATIVE_MESSAGES: MessageKey[] = [
  "native.error.12",
  "native.error.13",
  "native.error.16",
  "native.error.18",
  "native.error.19",
  "native.error.23",
  "native.error.24",
  "native.error.26",
  "native.error.41",
  "native.error.44",
];

/**
 * Installs the fake: one patient, two folders and two documents, as in
 * a11y.ts's fakeVault, opened with FAKE_PASSPHRASE.
 */
export async function fakeVaultWith(page: Page, setup: FakeVaultSetup) {
  await page.addInitScript(
    (setup) => {
      const STORE = "mycarlos-e2e-fake-vault";
      type FakeRecord = {
        id: string;
        profileId: string;
        folderIds: string[];
        displayName: string;
        sourceLabel: string;
        mediaType: string;
        plaintextSize: number;
        importedAtMs: number;
        available: boolean;
        hidden?: { atMs: number; reason: "patient" | "damaged" } | null;
        verifiedClinicName?: string;
      };
      type Link = {
        id: string;
        portalBase: string;
        deviceName: string;
        profileId: string | null;
        clinicName: string | null;
        fingerprints: string[];
        incomplete: boolean;
        deviceKeyId: string;
        deviceFingerprint: string;
        approvalRequested: boolean;
        clinicApproved: boolean;
        approvalStatus: string | null;
      };
      type Snapshot = {
        profiles: { id: string; displayName: string; createdAtMs: number }[];
        folders: {
          id: string;
          profileId: string;
          parentId: string | null;
          name: string;
          createdAtMs: number;
        }[];
        records: FakeRecord[];
        recovery: null;
        recoveryKeySetAtMs: number | null;
        recoveryKeyLabel: string | null;
        portalLinkingEnabled?: boolean;
        portalLinks?: Link[];
        sharedProfileId?: string;
      };
      type Outcome = { resolve?: unknown; reject?: unknown; pending?: true };
      type State = {
        status: string;
        passphrase: string;
        recoveryKey: string | null;
        pendingKey: string | null;
        /** Documents locked with their own password, by record id. */
        documentPasswords: Record<string, string>;
        checks: number;
        snapshot: Snapshot;
        calls: { command: string; args: unknown }[];
        unexpected: string[];
        script: Record<string, Outcome[]>;
      };
      type Request = {
        passphrase?: string;
        initialProfileName?: string;
        recordId?: string;
        recordIds?: string[];
        folderIds?: string[];
        folderId?: string;
        parentId?: string | null;
        name?: string;
        page?: number;
        width?: number;
        password?: string | null;
        recoveryKey?: string;
        newPassphrase?: string;
        groups?: { index: number; value: string }[];
        portalBase?: string;
        code?: string;
        deviceName?: string;
        profileId?: string | null;
      };
      type Args = { request?: Request; linkId?: string; locale?: string };

      const copy = <T>(value: T): T =>
        value === undefined ? value : JSON.parse(JSON.stringify(value));

      const link = (n: number, portalBase: string, approved: boolean) => ({
        id: `FAKE-link-${n}`,
        portalBase,
        deviceName: "FAKE device",
        profileId: null,
        clinicName: setup.clinic,
        fingerprints: [],
        incomplete: false,
        deviceKeyId: `FAKE-DEVICE-${n}`,
        deviceFingerprint: `FAKE FINGERPRINT ${n}`,
        approvalRequested: approved,
        clinicApproved: approved,
        approvalStatus: approved ? "accepted" : null,
      });

      const initial = (): State => {
        const records: FakeRecord[] = [
          {
            id: "record",
            profileId: "profile",
            folderIds: ["folder"],
            displayName: "FAKE Bloodwork.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 2048,
            importedAtMs: Date.UTC(2026, 9, 2, 12),
            available: true,
          },
          {
            id: "letter",
            profileId: "profile",
            folderIds: [],
            displayName: "FAKE Letter.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 1024,
            importedAtMs: Date.UTC(2026, 9, 3, 12),
            available: true,
          },
        ];
        const documentPasswords: Record<string, string> = {};
        if (setup.lockedPdf) {
          records.push({
            id: "locked",
            profileId: "profile",
            folderIds: [],
            displayName: "FAKE Locked.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 3072,
            importedAtMs: Date.UTC(2026, 9, 4, 12),
            available: true,
          });
          documentPasswords.locked = setup.documentPassword;
        }
        const hasKey = setup.start !== "absent" && setup.recoveryKey !== null;
        const snapshot: Snapshot = {
          profiles: [
            { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
          ],
          folders: [
            {
              id: "folder",
              profileId: "profile",
              parentId: null,
              name: "FAKE Results",
              createdAtMs: Date.UTC(2026, 9, 1, 12),
            },
            {
              id: "letters",
              profileId: "profile",
              parentId: null,
              name: "FAKE Letters",
              createdAtMs: Date.UTC(2026, 9, 1, 13),
            },
          ],
          records,
          recovery: null,
          recoveryKeySetAtMs: hasKey ? 1 : null,
          recoveryKeyLabel: hasKey ? setup.keyLabel : null,
        };
        if (setup.portal) {
          snapshot.portalLinkingEnabled = true;
          snapshot.portalLinks =
            setup.portal === "linked"
              ? [link(1, "https://fake-clinic.example.com", true)]
              : [];
        }
        return {
          status: setup.start,
          passphrase: setup.passphrase,
          recoveryKey: hasKey ? setup.recoveryKey : null,
          pendingKey: null,
          documentPasswords,
          checks: 0,
          snapshot,
          calls: [],
          unexpected: [],
          script: {},
        };
      };

      let state: State;
      try {
        const kept = window.sessionStorage.getItem(STORE);
        state = kept ? (JSON.parse(kept) as State) : initial();
      } catch {
        state = initial();
      }
      const save = () => {
        try {
          window.sessionStorage.setItem(STORE, JSON.stringify(state));
        } catch {
          // No storage here (about:blank): nothing to keep.
        }
      };
      save();

      const refuse = (
        code: string,
        messageKey: string,
        extra: Record<string, unknown> = {},
      ) => ({
        code,
        message: setup.messages[messageKey] ?? messageKey,
        messageKey,
        ...extra,
      });
      const recordById = (id: string | undefined) => {
        const found = state.snapshot.records.find((record) => record.id === id);
        if (!found) throw refuse("not_found", "native.error.18");
        return found;
      };
      // As the vault reads a recovery key typed back: case and anything but
      // letters and digits do not matter; I and L are 1, O is 0.
      const symbolsOf = (text: string) =>
        text
          .toUpperCase()
          .replace(/[^\p{L}\p{N}]/gu, "")
          .replace(/[IL]/g, "1")
          .replace(/O/g, "0");
      // A page's picture: drawn here, small; the reader scales it.
      const picture = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 60;
        canvas.height = 80;
        const context = canvas.getContext("2d");
        if (context) {
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, 60, 80);
          context.fillStyle = "#555555";
          context.fillRect(8, 10, 44, 4);
        }
        return canvas.toDataURL("image/png");
      };

      const answer = async (command: string, args: Args): Promise<unknown> => {
        const queued = state.script[command]?.shift();
        if (queued) {
          save();
          if (queued.pending) return new Promise(() => undefined);
          if ("reject" in queued) throw queued.reject;
          return queued.resolve;
        }
        const request: Request = args.request ?? {};
        const snapshot = state.snapshot;
        switch (command) {
          case "runtime_info":
            return { platform: "windows" };
          case "vault_status":
            return state.status;
          // No files are waiting to be shared; the app still polls.
          case "received_list":
            return { files: [], notice: { dropped: 0, refusedShares: 0 } };
          // As a11y.ts: the snapshot is given whenever it is asked for.
          case "vault_snapshot":
            return copy(snapshot);
          case "vault_passphrase_rules":
            return { longEnough: true, notAName: true, hardToGuess: true };
          case "vault_create":
            if (state.status !== "absent")
              throw refuse("already_exists", "native.error.12");
            // A new vault: its one person, and nothing in it yet.
            state.status = "unlocked";
            state.passphrase = request.passphrase ?? "";
            snapshot.profiles = [
              {
                id: "profile",
                displayName: request.initialProfileName ?? "",
                createdAtMs: Date.now(),
              },
            ];
            snapshot.folders = [];
            snapshot.records = [];
            return copy(snapshot);
          case "vault_unlock":
            if (state.status === "absent")
              throw refuse("missing", "native.error.13");
            if (request.passphrase !== state.passphrase)
              throw refuse("wrong_passphrase", "native.error.16");
            state.status = "unlocked";
            return copy(snapshot);
          case "vault_recover":
            if (
              !state.recoveryKey ||
              symbolsOf(request.recoveryKey ?? "") !==
                symbolsOf(state.recoveryKey)
            )
              throw refuse("wrong_recovery_key", "native.error.44");
            state.passphrase = request.newPassphrase ?? "";
            state.status = "unlocked";
            return { passphraseReplaced: true, snapshot: copy(snapshot) };
          case "vault_lock":
            // A key being set up does not outlive the session.
            state.status = "locked";
            state.pendingKey = null;
            return;
          case "vault_recovery_key_begin":
            if (request.passphrase !== state.passphrase)
              throw refuse("wrong_passphrase", "native.error.16");
            state.pendingKey = setup.newRecoveryKey;
            return state.pendingKey;
          case "vault_recovery_key_label":
            return state.pendingKey
              ? setup.newKeyLabel
              : snapshot.recoveryKeyLabel;
          case "vault_recovery_key_cancel":
            state.pendingKey = null;
            return;
          case "vault_recovery_kit_save":
            if (!state.pendingKey) throw refuse("invalid", "native.error.19");
            // The patient chose where, and the kit was written.
            return true;
          case "vault_recovery_key_confirm": {
            const groups = request.groups ?? [];
            const expected = state.pendingKey?.split("-") ?? [];
            const indexes = new Set(groups.map((group) => group.index));
            if (
              expected.length !== 7 ||
              groups.length !== 7 ||
              indexes.size !== 7 ||
              groups.some((group) => !(group.index >= 0 && group.index < 7))
            )
              throw refuse("invalid", "native.error.19");
            if (
              !groups.every(
                (group) => symbolsOf(group.value) === expected[group.index],
              )
            )
              throw refuse("recovery_key_typo", "native.error.41");
            // A key replacing another is confirmed natively: here, yes.
            state.recoveryKey = state.pendingKey;
            state.pendingKey = null;
            snapshot.recoveryKeySetAtMs = Date.now();
            snapshot.recoveryKeyLabel = setup.newKeyLabel;
            return copy(snapshot);
          }
          case "vault_assign_folders":
          case "vault_assign_folders_batch":
            for (const record of snapshot.records)
              if (
                record.id === request.recordId ||
                request.recordIds?.includes(record.id)
              )
                record.folderIds = [...(request.folderIds ?? [])];
            return;
          case "vault_create_folder": {
            const id = `folder-${snapshot.folders.length + 1}`;
            snapshot.folders.push({
              id,
              profileId: "profile",
              parentId: request.parentId ?? null,
              name: request.name ?? "",
              createdAtMs: Date.UTC(2026, 9, 5, 12),
            });
            return id;
          }
          case "vault_update_folder":
            for (const folder of snapshot.folders)
              if (folder.id === request.folderId)
                folder.parentId = request.parentId ?? null;
            return;
          case "vault_is_locked_pdf":
            return Object.hasOwn(
              state.documentPasswords,
              request.recordId ?? "",
            );
          case "vault_unlock_pdf": {
            const record = recordById(request.recordId);
            const password = state.documentPasswords[record.id];
            if (password === undefined)
              throw refuse("pdf_not_locked", "native.error.24");
            if (request.password !== password)
              throw refuse("pdf_wrong_password", "native.error.26");
            // The copy opens without the password, beside the original,
            // which is kept, locked, under a new name.
            const unlocked: FakeRecord = {
              ...copy(record),
              id: `${record.id}-unlocked`,
              importedAtMs: Date.now(),
            };
            snapshot.records.push(unlocked);
            record.displayName = setup.lockedOriginal.replace(
              "{name}",
              record.displayName.replace(/\.pdf$/i, "").trimEnd(),
            );
            return { recordId: unlocked.id, originalName: record.displayName };
          }
          case "vault_view_page": {
            const record = recordById(request.recordId);
            const password = state.documentPasswords[record.id];
            if (password !== undefined) {
              if (request.password == null)
                throw refuse("pdf_locked", "native.error.23");
              if (request.password !== password)
                throw refuse("pdf_wrong_password", "native.error.26");
            }
            const text = setup.pageText
              .replace("{page}", String(Number(request.page) + 1))
              .replace("{name}", record.displayName);
            const width = Number(request.width);
            return {
              pageCount: setup.pageCount,
              width,
              height: Math.round((width * 4) / 3),
              image: picture(),
              text,
              readableText: text,
            };
          }
          case "vault_view_cancel":
            return;
          case "vault_export_pick":
            return "FAKE-export-pick";
          case "vault_export_picked":
            recordById(request.recordId);
            return;
          case "vault_hide_record":
            recordById(request.recordId).hidden = {
              atMs: Date.now(),
              reason: "patient",
            };
            return;
          case "vault_unhide_record":
            recordById(request.recordId).hidden = null;
            return;
          case "vault_portal_link": {
            const links = (snapshot.portalLinks ??= []);
            const made = {
              ...link(links.length + 1, request.portalBase ?? "", false),
              deviceName: request.deviceName ?? "",
              profileId: request.profileId ?? null,
            };
            links.push(made);
            return copy(made);
          }
          case "vault_request_device_approval": {
            const found = snapshot.portalLinks?.find(
              (candidate) => candidate.id === args.linkId,
            );
            if (!found) throw refuse("not_found", "native.error.18");
            found.approvalRequested = true;
            found.approvalStatus = "pending";
            return;
          }
          case "vault_check_documents":
            state.checks += 1;
            if (state.checks > 1)
              return { added: 0, refused: 0, receiptsPending: 0, issues: [] };
            // The first check brings one verified document into Shared with
            // me, made with its first file.
            if (!snapshot.sharedProfileId) {
              snapshot.sharedProfileId = "shared";
              snapshot.profiles.push({
                id: "shared",
                displayName: "FAKE shared files",
                createdAtMs: 2,
              });
            }
            snapshot.records.push({
              id: "clinic-letter",
              profileId: "shared",
              folderIds: [],
              displayName: setup.clinicDocument,
              sourceLabel: "FAKE clinic portal",
              mediaType: "application/pdf",
              plaintextSize: 4096,
              importedAtMs: Date.now(),
              available: true,
              verifiedClinicName: setup.clinic,
            });
            return { added: 1, refused: 0, receiptsPending: 0, issues: [] };
          // Nothing in the fake documents names a person.
          case "vault_shared_identity":
            return null;
          case "vault_touch":
          case "vault_set_auto_lock":
          case "plugin:window|set_theme":
          case "plugin:webview|set_webview_zoom":
            return;
        }
        // Kept as well as thrown: a screen showing an error could still pass.
        state.unexpected.push(command);
        throw new Error(`Unexpected IPC command: ${command}`);
      };

      Reflect.set(window, "__unexpectedIpc", state.unexpected);
      Reflect.set(window, "__fakeVault", {
        calls: () => copy(state.calls),
        snapshot: () => copy(state.snapshot),
        script: (command: string, outcome: Outcome) => {
          (state.script[command] ??= []).push(outcome);
          save();
        },
      });
      Reflect.set(window, "__TAURI_INTERNALS__", {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main", windowLabel: "main" },
        },
        invoke: async (command: string, args?: Args) => {
          state.calls.push({ command, args: copy(args ?? {}) });
          save();
          try {
            return await answer(command, args ?? {});
          } finally {
            save();
          }
        },
      });
    },
    {
      start: setup.start,
      passphrase: FAKE_PASSPHRASE,
      recoveryKey:
        setup.recoveryKey === undefined
          ? fakeRecoveryKey("the vault's key")
          : setup.recoveryKey,
      newRecoveryKey: setup.newRecoveryKey ?? fakeRecoveryKey("a new key"),
      keyLabel: FAKE_KEY_LABEL,
      newKeyLabel: FAKE_NEW_KEY_LABEL,
      lockedPdf: setup.lockedPdf ?? false,
      documentPassword: FAKE_DOCUMENT_PASSWORD,
      lockedOriginal: lockedOriginalName("{name}.pdf"),
      pageText: PAGE_TEXT,
      pageCount: FAKE_PAGE_COUNT,
      portal: setup.portal ?? null,
      clinic: FAKE_CLINIC,
      clinicDocument: FAKE_CLINIC_DOCUMENT,
      messages: Object.fromEntries(
        NATIVE_MESSAGES.map((key) => [key, translate("en", key)]),
      ) as Record<string, string>,
    },
  );
}

/** What a command was sent, as the native side received it. */
export type FakeArgs = {
  request?: Record<string, unknown>;
  [key: string]: unknown;
};

/** Every command the page sent the fake, in order, with its arguments. */
async function allCalls(page: Page) {
  return page.evaluate(() =>
    (
      Reflect.get(window, "__fakeVault") as {
        calls: () => { command: string; args: FakeArgs }[];
      }
    ).calls(),
  );
}

/** The arguments of each call of `command`, in order. */
export async function fakeCalls(
  page: Page,
  command: string,
): Promise<FakeArgs[]> {
  return (await allCalls(page))
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

/** The commands sent, in order. */
export async function fakeCommands(page: Page): Promise<string[]> {
  return (await allCalls(page)).map((call) => call.command);
}

/** The vault as the fake native side holds it now. */
export async function fakeSnapshot(page: Page) {
  return page.evaluate(() =>
    (
      Reflect.get(window, "__fakeVault") as {
        snapshot: () => {
          recoveryKeySetAtMs: number | null;
          recoveryKeyLabel: string | null;
          records: { id: string; displayName: string; hidden?: unknown }[];
        };
      }
    ).snapshot(),
  );
}

/** Gives the next call of `command` this answer, before the fake's own. */
export async function scriptFake(
  page: Page,
  command: string,
  outcome: FakeOutcome,
) {
  await page.evaluate(
    ({ command, outcome }) =>
      (
        Reflect.get(window, "__fakeVault") as {
          script: (command: string, outcome: FakeOutcome) => void;
        }
      ).script(command, outcome),
    { command, outcome },
  );
}
