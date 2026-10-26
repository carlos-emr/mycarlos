import { useEffect, useRef, useState } from "react";
import {
  deferredText,
  formatDate,
  t as translateNow,
  useI18n,
  type MessageKey,
  type UiText,
} from "../i18n";
import {
  isLockedError,
  vaultErrorMessage,
  type AuditHistoryEntry,
  type VaultBridge,
} from "../vault";

const eventLabels: Record<AuditHistoryEntry["event"], MessageKey> = {
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
};

const howLabels: Record<string, MessageKey> = {
  picked: "interface.history.how.picked",
  passphrase: "interface.history.how.passphrase",
  recoveryKey: "interface.history.how.recoveryKey",
  patient: "interface.history.how.patient",
  damaged: "interface.history.how.damaged",
};

const formatTimestamp = (timestamp: number) =>
  formatDate(timestamp, { dateStyle: "medium", timeStyle: "short" });

function folderPath(
  folders: string[] | null,
  total: number | null,
): string | null {
  if (folders === null) return null;
  const names = folders.length
    ? folders.join(", ")
    : translateNow("interface.history.rootFolder");
  const more = total === null ? 0 : total - folders.length;
  return more > 0
    ? `${names}, ${translateNow("interface.history.moreFolders", { count: more })}`
    : names;
}

function previousSession(value: string | null): string | null {
  if (!value) return null;
  if (value.includes("notRecorded"))
    return translateNow("interface.history.sessionNotRecorded");
  const match = /^lockedAt:(\d+):(app|nativeDeadline|manual|idle)$/.exec(value);
  if (!match) return value;
  return translateNow(
    match[2] === "app" || match[2] === "manual"
      ? "interface.history.sessionLockedByPerson"
      : "interface.history.sessionLockedAutomatically",
    { date: formatTimestamp(Number(match[1])) },
  );
}

function details(entry: AuditHistoryEntry): [MessageKey, string][] {
  const rows: [MessageKey, string][] = [];
  if (entry.name) rows.push(["interface.history.name", entry.name]);
  if (entry.oldName)
    rows.push(["interface.history.previousName", entry.oldName]);
  const from = folderPath(entry.from, entry.fromTotal);
  if (from) rows.push(["interface.history.from", from]);
  const to = folderPath(entry.to, entry.toTotal);
  if (to) rows.push(["interface.history.to", to]);
  if (entry.how) {
    const key = Object.hasOwn(howLabels, entry.how)
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

/** Read-only view of the encrypted audit history. Native code returns rows
 * only after verifying the complete chain. */
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
  const [entries, setEntries] = useState<AuditHistoryEntry[] | null>(null);
  const [error, setError] = useState<UiText>("");
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    let current = true;
    void bridge.history().then(
      (verifiedEntries) => {
        if (current) setEntries(verifiedEntries);
      },
      (cause: unknown) => {
        if (!current) return;
        if (isLockedError(cause)) {
          void onLockRef.current();
          return;
        }
        setEntries(null);
        setError(deferredText(() => vaultErrorMessage(cause)));
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
        </div>
      </div>
      {error ? (
        <p className="purpose-note warning" role="alert">
          {typeof error === "string" ? error : error.render()}
        </p>
      ) : entries === null ? (
        <p className="status-line" role="status" aria-live="polite">
          {translateNow("interface.history.loading")}
        </p>
      ) : entries.length === 0 ? (
        <p>{translateNow("interface.history.empty")}</p>
      ) : (
        <>
          <p className="status-line" role="status">
            {translateNow("interface.history.events", {
              count: entries.length,
            })}
          </p>
          <ol className="audit-history-list">
            {[...entries].reverse().map((entry) => (
              <li key={entry.seq}>
                <article className="audit-history-entry">
                  <h2>{translateNow(eventLabels[entry.event])}</h2>
                  <p className="audit-history-date">
                    {formatTimestamp(entry.atMs)}
                  </p>
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
            ))}
          </ol>
        </>
      )}
    </main>
  );
}
