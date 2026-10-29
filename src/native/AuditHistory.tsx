import { useEffect, useRef, useState } from "react";
import {
  deferredText,
  t as translateNow,
  useI18n,
  type MessageKey,
  type UiText,
} from "../i18n";
import {
  isLockedError,
  isCancelledError,
  vaultErrorMessage,
  type AuditHistoryEntry,
  type AuditHistoryView,
  type VaultBridge,
} from "../vault";

/** A title for each event the vault records (history.rs `HistoryEvent`). A test checks
 * that every event there has one; an event from a newer build is "Other event". */
export const eventLabels: Record<AuditHistoryEntry["event"], MessageKey> = {
  created: "interface.history.event.created",
  historyStarted: "interface.history.event.historyStarted",
  unlocked: "interface.history.event.unlocked",
  imported: "interface.history.event.imported",
  renamed: "interface.history.event.renamed",
  moved: "interface.history.event.moved",
  hidden: "interface.history.event.hidden",
  restored: "interface.history.event.restored",
  copySaved: "interface.history.event.copySaved",
  recoveryKeySet: "interface.history.event.recoveryKeySet",
  backupSaved: "interface.history.event.backupSaved",
  backupRestored: "interface.history.event.backupRestored",
  passphraseChanged: "interface.history.event.passphraseChanged",
  profileCreated: "interface.history.event.profileCreated",
  folderCreated: "interface.history.event.folderCreated",
  folderRenamed: "interface.history.event.folderRenamed",
  folderMoved: "interface.history.event.folderMoved",
  setAside: "interface.history.event.setAside",
  profileDetailsChanged: "interface.history.event.profileDetailsChanged",
  portalLinkStarted: "interface.history.event.portalLinkStarted",
  portalLinked: "interface.history.event.portalLinked",
  deviceApprovalRequested: "interface.history.event.deviceApprovalRequested",
  deviceApprovalVerified: "interface.history.event.deviceApprovalVerified",
  deviceApprovalStatusChanged:
    "interface.history.event.deviceApprovalStatusChanged",
  deviceApprovalRequestRestarted:
    "interface.history.event.deviceApprovalRequestRestarted",
  deliveryFiled: "interface.history.event.deliveryFiled",
  deliveryReceiptSettled: "interface.history.event.deliveryReceiptSettled",
};

/** The title of an entry's event; never the formatting-failure text, even for an
 * event this build does not know. */
export function eventTitle(event: string): MessageKey {
  return Object.hasOwn(eventLabels, event)
    ? eventLabels[event as AuditHistoryEntry["event"]]
    : "interface.history.event.other";
}

/** Words for each `how` the vault records. A how this build does not know is shown as
 * it is. A test checks the values history.rs and the vault can write. */
export const howLabels: Record<string, MessageKey> = {
  picked: "interface.history.how.picked",
  passphrase: "interface.history.how.passphrase",
  recoveryKey: "interface.history.how.recoveryKey",
  patient: "interface.history.how.patient",
  damaged: "interface.history.how.damaged",
  camera: "interface.history.how.camera",
  replaced: "interface.history.how.replaced",
  personFolder: "interface.history.how.personFolder",
  // A device approval request's state (portal_approval.rs `ApprovalState::code`).
  pending: "interface.history.how.pending",
  challenge_ready: "interface.history.how.challengeReady",
  accepted: "interface.history.how.accepted",
  refused: "interface.history.how.refused",
  expired: "interface.history.how.expired",
  cancelled: "interface.history.how.cancelled",
  // What the portal said to a pickup confirmation (delivery.rs `settle_receipt`).
  picked_up: "interface.history.how.pickedUp",
  delivery_not_found: "interface.history.how.deliveryNotFound",
};

/** Dates keep the computer's own format, whatever language myCarlos uses (D130), as
 * RecordDetails shows them. */
const formatTimestamp = (timestamp: number) =>
  new Date(timestamp).toLocaleString();

function folderPath(
  folders: string[] | null,
  total: number | null,
  rootLabel: MessageKey = "interface.history.rootFolder",
): string | null {
  if (folders === null) return null;
  const names = folders.length ? folders.join(", ") : translateNow(rootLabel);
  const more = total === null ? 0 : total - folders.length;
  return more > 0
    ? `${names}, ${translateNow("interface.history.moreFolders", { count: more })}`
    : names;
}

function previousSession(value: string | null): string | null {
  if (!value) return null;
  if (value === "notRecorded")
    return translateNow("interface.history.sessionNotRecorded");
  const match =
    /^lockedAt:(\d+):(app|nativeDeadline|manual|idle)(;notRecorded)?$/.exec(
      value,
    );
  if (!match) return value;
  const known = translateNow(
    match[2] === "app"
      ? "interface.history.sessionLockedByApp"
      : match[2] === "manual"
        ? "interface.history.sessionLockedByPerson"
        : "interface.history.sessionLockedAutomatically",
    { date: formatTimestamp(Number(match[1])) },
  );
  return match[3]
    ? `${known}. ${translateNow("interface.history.laterSessionNotRecorded")}`
    : known;
}

function details(entry: AuditHistoryEntry): [MessageKey, string][] {
  const rows: [MessageKey, string][] = [];
  if (entry.name) rows.push(["interface.history.name", entry.name]);
  if (entry.oldName)
    rows.push(["interface.history.previousName", entry.oldName]);
  const movedFromShared = entry.event === "moved" && entry.how === "shared";
  const from = folderPath(
    entry.from,
    entry.fromTotal,
    movedFromShared
      ? "interface.LibrarySidebar.sharedWithMe"
      : "interface.history.rootFolder",
  );
  if (from) rows.push(["interface.history.from", from]);
  const to = folderPath(
    entry.to,
    entry.toTotal,
    movedFromShared
      ? "interface.history.personRootFolder"
      : "interface.history.rootFolder",
  );
  if (to) rows.push(["interface.history.to", to]);
  if (entry.how) {
    const key =
      entry.how === "shared"
        ? movedFromShared
          ? "interface.history.how.movedFromShared"
          : "interface.history.how.importedShared"
        : Object.hasOwn(howLabels, entry.how)
          ? howLabels[entry.how]
          : undefined;
    rows.push(["interface.history.how", key ? translateNow(key) : entry.how]);
  }
  if (entry.place) rows.push(["interface.history.place", entry.place]);
  const session = previousSession(entry.previousSession);
  if (session) rows.push(["interface.history.previousSession", session]);
  rows.push(["interface.history.appVersion", entry.app]);
  return rows;
}

/** Read-only view of the encrypted audit history. Native code returns only the entries it
 * authenticated from the start of the chain, and says whether they are all of it; when they
 * aren't, a warning comes first (D129). */
export function AuditHistory({
  bridge,
  onBack,
  onLock,
}: {
  bridge: VaultBridge;
  onBack: () => void;
  onLock: () => Promise<void>;
}) {
  useI18n();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;
  const [result, setResult] = useState<{
    bridge: VaultBridge;
    view: AuditHistoryView | null;
    error: UiText;
  } | null>(null);
  // A different native session must never display the previous request's rows
  // or error, including the render before its effect starts.
  const view = result?.bridge === bridge ? result.view : null;
  const entries = view?.entries ?? null;
  const error = result?.bridge === bridge ? result.error : "";
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    void bridge.history().then(
      (verified) => {
        if (current) setResult({ bridge, view: verified, error: "" });
      },
      (cause: unknown) => {
        if (!current) return;
        if (isLockedError(cause) || isCancelledError(cause)) {
          void onLockRef.current();
          return;
        }
        setResult({
          bridge,
          view: null,
          error: deferredText(() => vaultErrorMessage(cause)),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [bridge]);

  return (
    <main className="library-main purpose-screen audit-history">
      <button className="button breadcrumb" type="button" onClick={onBack}>
        <span aria-hidden="true">‹</span>{" "}
        {translateNow("hidden.backToSecurity")}
      </button>
      <div className="main-head">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            {translateNow("interface.history.title")}
          </h1>
          <p>{translateNow("interface.history.intro")}</p>
          <p className="purpose-note">
            {translateNow("interface.history.scopeNote")}
          </p>
        </div>
      </div>
      {error ? (
        <p className="purpose-note warning" role="alert">
          {typeof error === "string" ? error : error.render()}
        </p>
      ) : view === null || entries === null ? (
        <p className="status-line" role="status" aria-live="polite">
          {translateNow("interface.history.loading")}
        </p>
      ) : (
        <>
          {!view.complete && (
            <p className="purpose-note warning" role="alert">
              {damageNotice(view)}
            </p>
          )}
          {entries.length === 0 && view.laterEntries.length === 0 ? (
            view.complete && <p>{translateNow("interface.history.empty")}</p>
          ) : (
            <HistoryList entries={entries} later={view.laterEntries} />
          )}
        </>
      )}
    </main>
  );
}

/** The notice for a history that is not complete, from the native dates only (D146): the gap
 * between the two checked ends, or what lies before or after the only one, or all of it. */
function damageNotice(view: AuditHistoryView): string {
  const until = view.checkedUntilMs;
  const from = view.checkedFromMs;
  if (until !== null && from !== null)
    return translateNow("interface.history.damagedBetween", {
      from: formatTimestamp(until),
      to: formatTimestamp(from),
    });
  if (until !== null)
    return translateNow("interface.history.damaged", {
      date: formatTimestamp(until),
    });
  if (from !== null)
    return translateNow("interface.history.damagedBefore", {
      date: formatTimestamp(from),
    });
  return translateNow("interface.history.damagedAll");
}

function HistoryList({
  entries,
  later,
}: {
  entries: AuditHistoryEntry[];
  later: AuditHistoryEntry[];
}) {
  return (
    <>
      <p className="status-line" role="status">
        {translateNow("interface.history.events", {
          count: entries.length + later.length,
        })}
      </p>
      <ol className="audit-history-list">
        {[...later].reverse().map(historyItem)}
        {later.length > 0 && entries.length > 0 && (
          <li key="gap" className="audit-history-gap">
            <p className="purpose-note warning">
              {translateNow("interface.history.gap")}
            </p>
          </li>
        )}
        {[...entries].reverse().map(historyItem)}
      </ol>
    </>
  );
}

function historyItem(entry: AuditHistoryEntry) {
  return (
    <li key={entry.seq}>
      <article className="audit-history-entry">
        <h2>{translateNow(eventTitle(entry.event))}</h2>
        <p className="audit-history-date">{formatTimestamp(entry.atMs)}</p>
        <dl>
          {details(entry).map(([label, value], index) => (
            <div key={`${label}-${index}`}>
              <dt>{translateNow(label)}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </article>
    </li>
  );
}
