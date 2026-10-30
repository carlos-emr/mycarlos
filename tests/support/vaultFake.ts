import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
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

// Fixed synthetic UUIDs, in the wire format accepted by native Uuid fields.
const UUID_PREFIX = "00000000-0000-4000-8000-";
export const fakeUuid = (index: number) =>
  UUID_PREFIX + index.toString(16).padStart(12, "0");
export const FAKE_IDS = {
  profile: fakeUuid(1),
  folder: fakeUuid(2),
  letters: fakeUuid(3),
  record: fakeUuid(4),
  letter: fakeUuid(5),
  locked: fakeUuid(6),
  unlocked: fakeUuid(7),
  shared: fakeUuid(8),
  clinicLetter: fakeUuid(9),
  link: fakeUuid(101),
  exportPick: fakeUuid(1000),
  backupPick: fakeUuid(1000),
  restorePick: fakeUuid(1000),
  importPick: fakeUuid(1000),
};

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
/** The recovery key the fake's vault has unless a spec gives its own. */
export const FAKE_VAULT_KEY = fakeRecoveryKey("the vault's key");

/** Regex-escapes catalogue text for a pattern a spec builds around it. */
export const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const en = (key: MessageKey, params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);

/** My records' heading, once the library is open. */
export const myRecords = (page: Page) =>
  page.getByRole("heading", { name: en("sidebar.myRecords"), exact: true });

/** The sidebar. */
export const sidebar = (page: Page) =>
  page.getByRole("navigation", { name: en("sidebar.label"), exact: true });

/** Opens a document's details from My records. */
export async function openDetails(page: Page, name: string) {
  await expect(myRecords(page)).toBeVisible();
  await page.getByRole("button", { name, exact: true }).click();
  const details = page.getByRole("dialog", { name, exact: true });
  await expect(
    details.getByRole("button", {
      name: en("interface.RecordDetails.closeDocumentDetails"),
      exact: true,
    }),
  ).toBeVisible();
  return details;
}

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
  /** The backup file a restore would choose: what it replaces on this
   * device, whether the vault here differs, the documents it holds (FAKE
   * names), and the passphrase it was made with (the vault's by default). */
  backup?: {
    replaces: "nothing" | "sameVault" | "otherVault" | "unreadable";
    differs?: boolean;
    documents: string[];
    passphrase?: string;
  };
  /** The vault opens in recovery mode: these documents' encrypted files are
   * missing, so changes are paused until they are hidden as damaged. */
  missingFiles?: string[];
  /** More people in the vault, with the details clinic documents carry. */
  people?: { displayName: string; fullName?: string; birthDate?: string }[];
  /** Files another app shared to myCarlos, waiting to be added (#61). */
  received?: string[];
  /** What the vault finds on a shared document, by its name: the name and
   * birth date written on it, for the person suggestion. */
  identities?: Record<string, { name: string; birthDate?: string }>;
  /** The history opens damaged: entries before `checkedFromMs` are gone,
   * the later ones proven by the pinned end (D129/D146). */
  damagedHistory?: boolean;
}

// The refusals the fake makes itself, by message key, in English as the
// native side sends them (the screens show the messageKey's own text).
const NATIVE_MESSAGES: MessageKey[] = [
  "native.error.07",
  "native.error.08",
  "native.error.11",
  "native.error.12",
  "native.error.13",
  "native.error.14",
  "native.error.16",
  "native.error.18",
  "native.error.19",
  "native.error.23",
  "native.error.24",
  "native.error.25",
  "native.error.26",
  "native.error.38",
  "native.error.40",
  "native.error.36",
  "native.error.41",
  "native.error.42",
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
        sourceKind?: "manual";
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
        profiles: {
          id: string;
          displayName: string;
          createdAtMs: number;
          fullName?: string;
          birthDate?: string;
        }[];
        folders: {
          id: string;
          profileId: string;
          parentId: string | null;
          name: string;
          createdAtMs: number;
        }[];
        records: FakeRecord[];
        recovery: "lostObjects" | null;
        recoveryKeySetAtMs: number | null;
        recoveryKeyLabel: string | null;
        portalLinkingEnabled?: boolean;
        portalLinks?: Link[];
        sharedProfileId?: string;
      };
      type Outcome = { resolve?: unknown; reject?: unknown; pending?: true };
      type HistoryEntry = {
        seq: number;
        atMs: number;
        app: string;
        event: string;
        name: string | null;
        oldName: string | null;
        from: string[] | null;
        fromTotal: number | null;
        to: string[] | null;
        toTotal: number | null;
        how: string | null;
        place: string | null;
        previousSession: string | null;
      };
      type State = {
        status: string;
        passphrase: string;
        recoveryKey: string | null;
        pendingKey: string | null;
        /** Documents locked with their own password, by record id. */
        documentPasswords: Record<string, string>;
        checks: number;
        nextRecordId: number;
        nextPickId: number;
        picks: Record<
          string,
          {
            kind: string;
            recordId?: string;
            profileId?: string | null;
            folderIds?: string[];
          }
        >;
        /** The files the next import picker "chooses" (FAKE names). */
        importQueue: string[];
        /** Files shared to myCarlos, waiting (#61). */
        received: { id: string; name: string; sourceLabel: string }[];
        /** What the vault wrote down (#71), as the native side would. */
        history: HistoryEntry[];
        /** Backups saved and the one the restore picker chooses. */
        backupsSaved: number;
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
        currentPassphrase?: string;
        displayName?: string;
        details?: { fullName?: string; birthDate?: string };
        confirmed?: string[];
        pickId?: string;
        replace?: boolean;
      };
      type Args = {
        request?: Request;
        linkId?: string;
        recordId?: string;
        locale?: string;
      };

      const copy = <T>(value: T): T =>
        value === undefined ? value : JSON.parse(JSON.stringify(value));

      const makeUuid = (index: number) =>
        setup.uuidPrefix + index.toString(16).padStart(12, "0");
      const link = (n: number, portalBase: string, approved: boolean) => ({
        id: makeUuid(100 + n),
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
            id: setup.ids.record,
            profileId: setup.ids.profile,
            folderIds: [setup.ids.folder],
            displayName: "FAKE Bloodwork.pdf",
            sourceLabel: "Manual import — unverified",
            sourceKind: "manual",
            mediaType: "application/pdf",
            plaintextSize: 2048,
            importedAtMs: Date.UTC(2026, 9, 2, 12),
            available: true,
          },
          {
            id: setup.ids.letter,
            profileId: setup.ids.profile,
            folderIds: [],
            displayName: "FAKE Letter.pdf",
            sourceLabel: "Manual import — unverified",
            sourceKind: "manual",
            mediaType: "application/pdf",
            plaintextSize: 1024,
            importedAtMs: Date.UTC(2026, 9, 3, 12),
            available: true,
          },
        ];
        const documentPasswords: Record<string, string> = {};
        if (setup.lockedPdf) {
          records.push({
            id: setup.ids.locked,
            profileId: setup.ids.profile,
            folderIds: [],
            displayName: "FAKE Locked.pdf",
            sourceLabel: "Manual import — unverified",
            sourceKind: "manual",
            mediaType: "application/pdf",
            plaintextSize: 3072,
            importedAtMs: Date.UTC(2026, 9, 4, 12),
            available: true,
          });
          documentPasswords[setup.ids.locked] = setup.documentPassword;
        }
        for (const record of records) {
          if (setup.missingFiles.includes(record.displayName))
            record.available = false;
        }
        const hasKey = setup.start !== "absent" && setup.recoveryKey !== null;
        const snapshot: Snapshot = {
          profiles: [
            {
              id: setup.ids.profile,
              displayName: "FAKE Patient",
              createdAtMs: 1,
            },
          ],
          folders: [
            {
              id: setup.ids.folder,
              profileId: setup.ids.profile,
              parentId: null,
              name: "FAKE Results",
              createdAtMs: Date.UTC(2026, 9, 1, 12),
            },
            {
              id: setup.ids.letters,
              profileId: setup.ids.profile,
              parentId: null,
              name: "FAKE Letters",
              createdAtMs: Date.UTC(2026, 9, 1, 13),
            },
          ],
          records,
          recovery: setup.missingFiles.length ? "lostObjects" : null,
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
        for (const [index, person] of setup.people.entries()) {
          snapshot.profiles.push({
            id: makeUuid(500 + index + 1),
            displayName: person.displayName,
            createdAtMs: 3 + index,
            ...(person.fullName ? { fullName: person.fullName } : {}),
            ...(person.birthDate ? { birthDate: person.birthDate } : {}),
          });
        }
        const history: HistoryEntry[] = [
          {
            seq: 1,
            atMs: Date.UTC(2026, 9, 1, 12),
            app: "FAKE 0.1.0",
            event: "created",
            name: "FAKE Patient",
            oldName: null,
            from: null,
            fromTotal: null,
            to: null,
            toTotal: null,
            how: null,
            place: null,
            previousSession: null,
          },
        ];
        return {
          nextRecordId: 401,
          nextPickId: 1000,
          picks: {},
          importQueue: [],
          backupsSaved: 0,
          received: setup.received.map((name, index) => ({
            id: makeUuid(600 + index + 1),
            name,
            sourceLabel: "Shared to myCarlos",
          })),
          history,
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

      const fakeRecord = (
        displayName: string,
        profileId: string,
        folderIds: string[],
      ): FakeRecord => ({
        id: makeUuid(state.nextRecordId++),
        profileId,
        folderIds,
        displayName,
        sourceLabel: "Manual import — unverified",
        sourceKind: "manual",
        mediaType: "application/pdf",
        plaintextSize: 1024,
        importedAtMs: Date.now(),
        available: true,
      });
      const wrote = (event: string, fields: Partial<HistoryEntry> = {}) => {
        state.history.push({
          seq: state.history.length + 1,
          atMs: Date.now(),
          app: "FAKE 0.1.0",
          event,
          name: null,
          oldName: null,
          from: null,
          fromTotal: null,
          to: null,
          toTotal: null,
          how: null,
          place: null,
          previousSession: null,
          ...fields,
        });
      };
      const sharedProfile = () => {
        const snapshot = state.snapshot;
        if (!snapshot.sharedProfileId) {
          snapshot.sharedProfileId = setup.ids.shared;
          snapshot.profiles.push({
            id: setup.ids.shared,
            displayName: "FAKE shared files",
            createdAtMs: 2,
          });
        }
        return snapshot.sharedProfileId;
      };
      const refuseLocked = () => {
        if (state.status !== "unlocked")
          throw refuse("locked", "native.error.14");
      };
      const refusePaused = () => {
        refuseLocked();
        if (state.snapshot.recovery !== null)
          throw refuse("recovery_mode", "native.error.40");
      };
      const profileOf = (id: string | null | undefined) => {
        const found = state.snapshot.profiles.find((p) => p.id === id);
        if (!found) throw refuse("not_found", "native.error.18");
        return found;
      };

      // Promises and command guards belong to this window, not sessionStorage.
      const pendingViews = new Set<(reason: unknown) => void>();
      let cancelledViews = 0;
      let checkingDocuments = false;
      const cancelViews = () => {
        const stopped = [...pendingViews];
        pendingViews.clear();
        cancelledViews += stopped.length;
        for (const reject of stopped)
          reject(refuse("cancelled", "native.error.36"));
      };
      // Native request deserialization rejects malformed Uuid arguments before
      // executing a command, including a command with a scripted answer.
      const validateIds = (args: Args) => {
        const uuid =
          /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
        const check = (value: unknown) => {
          if (typeof value !== "string" || !uuid.test(value))
            throw new Error("invalid UUID in native request");
        };
        const request = (args.request ?? {}) as Record<string, unknown>;
        for (const field of [
          "recordId",
          "profileId",
          "folderId",
          "parentId",
          "pickId",
        ])
          if (request[field] != null) check(request[field]);
        for (const field of ["recordIds", "folderIds", "confirmed"])
          if (Array.isArray(request[field]))
            for (const id of request[field]) check(id);
        if (args.linkId != null) check(args.linkId);
        if ("recordId" in args && args.recordId != null) check(args.recordId);
      };

      const makePick = (
        kind: string,
        target: {
          recordId?: string;
          profileId?: string | null;
          folderIds?: string[];
        } = {},
      ) => {
        const id = makeUuid(state.nextPickId++);
        state.picks[id] = { kind, ...copy(target) };
        return id;
      };
      const pick = (id: string | undefined, kind: string, consume: boolean) => {
        const found = id ? state.picks[id] : undefined;
        if (id && consume) delete state.picks[id];
        if (!found || found.kind !== kind)
          throw refuse("not_found", "native.error.18");
        return found;
      };

      const answer = async (command: string, args: Args): Promise<unknown> => {
        const queued = state.script[command]?.shift();
        if (queued) {
          save();
          if (queued.pending) {
            if (command === "vault_view_page")
              return new Promise((_resolve, reject) =>
                pendingViews.add(reject),
              );
            return new Promise(() => undefined);
          }
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
          // Files shared to myCarlos wait until the vault is unlocked (#61).
          case "received_list":
            return {
              files: copy(state.received),
              notice: { dropped: 0, refusedShares: 0 },
            };
          case "received_accept": {
            refuseLocked();
            const imported: string[] = [];
            const skippedDuplicates: string[] = [];
            const notPdf: string[] = [];
            for (const file of state.received.splice(0)) {
              if (!/\.pdf$/i.test(file.name)) {
                notPdf.push(file.name);
                continue;
              }
              const profileId = sharedProfile();
              if (
                snapshot.records.some(
                  (r) =>
                    r.profileId === profileId && r.displayName === file.name,
                )
              ) {
                skippedDuplicates.push(file.name);
                continue;
              }
              const record = fakeRecord(file.name, profileId, []);
              record.sourceLabel = file.sourceLabel;
              snapshot.records.push(record);
              imported.push(record.id);
              wrote("imported", { name: file.name, how: "shared" });
            }
            return { imported, skippedDuplicates, notPdf };
          }
          case "vault_shared_identity": {
            refuseLocked();
            // Sent with the id beside `request`, as the link commands are.
            const record = recordById(args.recordId ?? request.recordId);
            return copy(setup.identities[record.displayName] ?? null);
          }
          case "vault_history": {
            refuseLocked();
            const entries = copy(state.history);
            if (!setup.damagedHistory)
              return {
                entries,
                laterEntries: [],
                complete: true,
                checkedUntilMs: null,
                checkedFromMs: null,
              };
            // The start is damaged: only what the pinned end proves shows.
            const later = entries.slice(1);
            return {
              entries: [],
              laterEntries: later,
              complete: false,
              checkedUntilMs: null,
              checkedFromMs: later[0]?.atMs ?? null,
            };
          }
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
                id: setup.ids.profile,
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
            wrote("unlocked", { how: "passphrase" });
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
            cancelViews();
            // A key being set up does not outlive the session.
            state.status = "locked";
            state.picks = {};
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
              ) {
                if (
                  JSON.stringify(record.folderIds) ===
                  JSON.stringify(request.folderIds ?? [])
                )
                  continue;
                const folderName = (id: string) =>
                  snapshot.folders.find((f) => f.id === id)?.name ?? id;
                wrote("moved", {
                  name: record.displayName,
                  from: record.folderIds.map(folderName),
                  to: (request.folderIds ?? []).map(folderName),
                });
                record.folderIds = [...(request.folderIds ?? [])];
              }
            return;
          case "vault_create_folder": {
            const id = makeUuid(300 + snapshot.folders.length + 1);
            snapshot.folders.push({
              id,
              profileId: request.profileId ?? setup.ids.profile,
              parentId: request.parentId ?? null,
              name: request.name ?? "",
              createdAtMs: Date.UTC(2026, 9, 5, 12),
            });
            wrote("folderCreated", { name: request.name ?? "" });
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
            if (
              snapshot.records.some(
                (candidate) => candidate.id === setup.ids.unlocked,
              )
            )
              throw refuse("pdf_already_unlocked", "native.error.25");
            const unlocked: FakeRecord = {
              ...copy(record),
              id: setup.ids.unlocked,
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
            cancelViews();
            return;
          case "vault_export_pick":
            refuseLocked();
            return makePick("export", { recordId: request.recordId });
          case "vault_export_picked": {
            const chosen = pick(request.pickId, "export", true);
            if (chosen.recordId !== request.recordId)
              throw refuse("invalid", "native.error.19");
            recordById(request.recordId);
            return;
          }
          case "vault_rename_record": {
            refusePaused();
            const record = recordById(request.recordId);
            if (record.displayName === request.name) return;
            wrote("renamed", {
              name: request.name ?? "",
              oldName: record.displayName,
            });
            record.displayName = request.name ?? "";
            return;
          }
          case "vault_hide_record": {
            const record = recordById(request.recordId);
            if (record.hidden) return;
            wrote("hidden", { name: record.displayName, how: "patient" });
            record.hidden = { atMs: Date.now(), reason: "patient" };
            return;
          }
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
              snapshot.sharedProfileId = setup.ids.shared;
              snapshot.profiles.push({
                id: setup.ids.shared,
                displayName: "FAKE shared files",
                createdAtMs: 2,
              });
            }
            snapshot.records.push({
              id: setup.ids.clinicLetter,
              profileId: setup.ids.shared,
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
          // --- Security: encrypted backup ---
          case "vault_backup_pick":
            refusePaused();
            return makePick("backup");
          case "vault_backup_picked":
            pick(request.pickId, "backup", true);
            refusePaused();
            state.backupsSaved += 1;
            wrote("backupSaved", {
              place: "FAKE Backups/myCarlos backup.mycarlosbackup",
            });
            return {
              name: `myCarlos backup FAKE ${setup.keyLabel}.mycarlosbackup`,
              bytes: 4096 * state.backupsSaved,
            };
          // --- The unlock screen: restore from a backup ---
          case "vault_restore_pick":
            if (!setup.backup) throw refuse("not_found", "native.error.18");
            return makePick("restore");
          case "vault_restore_inspect":
          case "vault_restore": {
            pick(request.pickId, "restore", false);
            if (state.status === "unlocked")
              throw refuse("invalid", "native.error.19");
            const backup = setup.backup;
            if (!backup) throw refuse("not_found", "native.error.18");
            if (request.recoveryKey !== undefined) {
              if (
                !state.recoveryKey ||
                symbolsOf(request.recoveryKey) !== symbolsOf(state.recoveryKey)
              )
                throw refuse("wrong_recovery_key", "native.error.07");
            } else if (
              request.passphrase !== (backup.passphrase ?? state.passphrase)
            )
              throw refuse("wrong_passphrase", "native.error.08");
            if (command === "vault_restore_inspect")
              return {
                replaces: backup.replaces,
                differsFromThisDevice: backup.differs ?? false,
                documentCount: backup.documents.length,
              };
            // The restore itself: the backup's vault takes this one's place,
            // locked, opening with the backup's passphrase.
            if (request.replace !== (backup.replaces !== "nothing"))
              throw refuse("changed", "native.error.42");
            pick(request.pickId, "restore", true);
            state.picks = {};
            state.status = "locked";
            state.passphrase = backup.passphrase ?? state.passphrase;
            snapshot.records = backup.documents.map((name) =>
              fakeRecord(name, setup.ids.profile, []),
            );
            snapshot.recovery = null;
            return true;
          }
          // --- Security: change the passphrase ---
          case "vault_change_passphrase":
            refusePaused();
            if (request.currentPassphrase !== state.passphrase)
              throw refuse("wrong_passphrase", "native.error.16");
            state.passphrase = request.newPassphrase ?? "";
            return;
          // --- People ---
          case "vault_create_profile": {
            refusePaused();
            const id = makeUuid(200 + snapshot.profiles.length + 1);
            snapshot.profiles.push({
              id,
              displayName: request.displayName ?? "",
              createdAtMs: Date.now(),
              ...(request.details?.fullName
                ? { fullName: request.details.fullName }
                : {}),
              ...(request.details?.birthDate
                ? { birthDate: request.details.birthDate }
                : {}),
            });
            return id;
          }
          case "vault_rename_profile":
            refusePaused();
            profileOf(request.profileId).displayName =
              request.displayName ?? "";
            return;
          case "vault_update_profile_details": {
            refusePaused();
            const person = profileOf(request.profileId);
            delete person.fullName;
            delete person.birthDate;
            if (request.details?.fullName)
              person.fullName = request.details.fullName;
            if (request.details?.birthDate)
              person.birthDate = request.details.birthDate;
            return;
          }
          case "vault_move_to_person": {
            refusePaused();
            const to = profileOf(request.profileId);
            const moved: string[] = [];
            const alreadyThere: string[] = [];
            for (const id of request.recordIds ?? []) {
              const record = snapshot.records.find((r) => r.id === id);
              if (!record) continue;
              const duplicate = snapshot.records.some(
                (r) =>
                  r.id !== id &&
                  r.profileId === to.id &&
                  r.displayName === record.displayName,
              );
              if (duplicate) {
                alreadyThere.push(record.displayName);
                continue;
              }
              record.profileId = to.id;
              record.folderIds = request.folderIds ?? [];
              moved.push(id);
            }
            return { moved, alreadyThere };
          }
          // --- Adding documents (the native picker "chooses" what the test
          // queued with __fakeVault.pickFiles) ---
          case "vault_import_pick":
            refusePaused();
            return state.importQueue.length
              ? makePick("import", {
                  profileId: request.profileId,
                  folderIds: request.folderIds ?? [],
                })
              : null;
          case "vault_import_picked": {
            const chosen = pick(request.pickId, "import", true);
            if (
              chosen.profileId !== request.profileId ||
              JSON.stringify(chosen.folderIds) !==
                JSON.stringify(request.folderIds ?? [])
            )
              throw refuse("invalid", "native.error.19");
            refusePaused();
            const imported: string[] = [];
            const skippedDuplicates: string[] = [];
            for (const name of state.importQueue.splice(0)) {
              const duplicate = snapshot.records.find(
                (r) =>
                  r.profileId === request.profileId && r.displayName === name,
              );
              if (duplicate) {
                skippedDuplicates.push(duplicate.id);
                continue;
              }
              const record = fakeRecord(
                name,
                request.profileId ?? setup.ids.profile,
                request.folderIds ?? [],
              );
              snapshot.records.push(record);
              imported.push(record.id);
              wrote("imported", { name, how: "picked" });
            }
            return { imported, skippedDuplicates };
          }
          // --- Recovery mode: hide the documents whose files are missing ---
          case "vault_hide_unavailable_records": {
            refuseLocked();
            const missing = snapshot.records
              .filter((r) => !r.available && r.hidden?.reason !== "damaged")
              .map((r) => r.id);
            const confirmed = [...(request.confirmed ?? [])].sort();
            if (
              JSON.stringify(confirmed) !== JSON.stringify([...missing].sort())
            )
              throw refuse("list_changed", "native.error.38");
            for (const record of snapshot.records) {
              if (missing.includes(record.id))
                record.hidden = { atMs: Date.now(), reason: "damaged" };
            }
            snapshot.recovery = null;
            return missing;
          }
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
        viewDraws: () => ({
          pending: pendingViews.size,
          cancelled: cancelledViews,
        }),
        snapshot: () => copy(state.snapshot),
        script: (command: string, outcome: Outcome) => {
          (state.script[command] ??= []).push(outcome);
          save();
        },
        missingFiles: (names: string[]) => {
          for (const record of state.snapshot.records)
            record.available = !names.includes(record.displayName);
          state.snapshot.recovery = names.length ? "lostObjects" : null;
          save();
        },
        pickFiles: (names: string[]) => {
          state.importQueue = names;
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
          let ownsCheck = false;
          try {
            validateIds(args ?? {});
            if (command === "vault_check_documents") {
              if (checkingDocuments) throw refuse("invalid", "native.error.19");
              checkingDocuments = true;
              ownsCheck = true;
            }
            return await answer(command, args ?? {});
          } finally {
            if (ownsCheck) checkingDocuments = false;
            save();
          }
        },
      });
    },
    {
      ids: FAKE_IDS,
      uuidPrefix: UUID_PREFIX,
      start: setup.start,
      passphrase: FAKE_PASSPHRASE,
      recoveryKey:
        setup.recoveryKey === undefined ? FAKE_VAULT_KEY : setup.recoveryKey,
      newRecoveryKey: setup.newRecoveryKey ?? fakeRecoveryKey("a new key"),
      keyLabel: FAKE_KEY_LABEL,
      newKeyLabel: FAKE_NEW_KEY_LABEL,
      lockedPdf: setup.lockedPdf ?? false,
      documentPassword: FAKE_DOCUMENT_PASSWORD,
      lockedOriginal: lockedOriginalName("{name}.pdf"),
      pageText: PAGE_TEXT,
      pageCount: FAKE_PAGE_COUNT,
      portal: setup.portal ?? null,
      backup: setup.backup ?? null,
      missingFiles: setup.missingFiles ?? [],
      people: setup.people ?? [],
      received: setup.received ?? [],
      identities: setup.identities ?? {},
      damagedHistory: setup.damagedHistory ?? false,
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

/** The FAKE files the next "Choose files to import" picker chooses. */
export async function fakePickFiles(page: Page, names: string[]) {
  await page.evaluate(
    (names) =>
      (
        Reflect.get(window, "__fakeVault") as {
          pickFiles: (names: string[]) => void;
        }
      ).pickFiles(names),
    names,
  );
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
          records: {
            id: string;
            displayName: string;
            profileId: string;
            folderIds: string[];
            hidden?: { atMs: number; reason: "patient" | "damaged" } | null;
          }[];
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

/** Pending helper draws and draws actually cancelled in this window. */
export async function fakeViewDraws(
  page: Page,
): Promise<{ pending: number; cancelled: number }> {
  return page.evaluate(() =>
    (
      Reflect.get(window, "__fakeVault") as {
        viewDraws: () => { pending: number; cancelled: number };
      }
    ).viewDraws(),
  );
}

/** Simulates encrypted files disappearing or returning between native requests. */
export async function fakeMissingFiles(page: Page, names: string[]) {
  await page.evaluate(
    (names) =>
      (
        Reflect.get(window, "__fakeVault") as {
          missingFiles: (names: string[]) => void;
        }
      ).missingFiles(names),
    names,
  );
}
