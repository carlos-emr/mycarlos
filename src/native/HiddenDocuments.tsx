import { Icon } from "../Icon";
import type { VaultRecord } from "../vault";
import { formatBytes, recordKind } from "./recordPresentation";

/**
 * The Hidden list (#71): documents taken out of view, never deleted. Each
 * keeps its encrypted file and comes back with Restore, except one hidden as
 * damaged whose file is still missing.
 */
export function HiddenDocuments({
  records,
  folderNameById,
  rootName = "My records",
  busy,
  readOnly,
  notice,
  onRestore,
}: {
  records: VaultRecord[];
  folderNameById: Map<string, string>;
  rootName?: string;
  busy: boolean;
  readOnly: boolean;
  notice: string;
  onRestore: (record: VaultRecord) => void;
}) {
  const total = records.reduce((sum, record) => sum + record.plaintextSize, 0);
  // Most recently hidden first.
  const sorted = [...records].sort(
    (left, right) => (right.hidden?.atMs ?? 0) - (left.hidden?.atMs ?? 0),
  );
  return (
    <main className="library-main purpose-screen native-hidden">
      <div className="main-head">
        <div>
          <h1>Hidden</h1>
          <p>
            {records.length} document{records.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(total)}
          </p>
        </div>
      </div>
      <div className="purpose-note">
        <Icon name="info" />
        <span>
          Hidden documents stay in your encrypted vault: myCarlos never deletes
          a document. Restore one to put it back where it was.
        </span>
      </div>
      <p className="status-line" role="status" aria-live="polite">
        {notice}
      </p>
      <div
        className="filelist trash-list native-hidden-list"
        aria-label={`${records.length} hidden document${records.length === 1 ? "" : "s"}`}
      >
        <div className="file-head" aria-hidden="true">
          <span />
          <span className="sorted">Name</span>
          <span className="column">Was in</span>
          <span className="column">Hidden</span>
          <span />
        </div>
        {sorted.map((record) => {
          const kind = recordKind(record.displayName);
          const damaged = record.hidden?.reason === "damaged";
          const canRestore = !damaged || record.available;
          const place =
            record.folderIds
              .map((id) => folderNameById.get(id))
              .filter(Boolean)
              .join(", ") || rootName;
          return (
            <article
              className="file-row"
              key={record.id}
              aria-label={`${record.displayName}, hidden`}
            >
              <span className="trash-marker">
                <Icon name="hidden" />
              </span>
              <div className="file-name">
                <span className={`document-icon ${kind.icon}`}>
                  <Icon name={kind.icon} />
                </span>
                <span className="name-copy">
                  <strong>{record.displayName}</strong>
                  <small>
                    {formatBytes(record.plaintextSize)} · {kind.label}
                    {damaged &&
                      (record.available
                        ? " · Its file is back"
                        : " · Damaged: file missing")}
                  </small>
                </span>
              </div>
              <span className="column">{place}</span>
              <span className="column hidden-date">
                {record.hidden
                  ? new Date(record.hidden.atMs).toLocaleDateString()
                  : ""}
              </span>
              {canRestore ? (
                <button
                  className="restore-button"
                  type="button"
                  aria-label={`Restore ${record.displayName}`}
                  disabled={busy || readOnly}
                  onClick={() => onRestore(record)}
                >
                  Restore
                </button>
              ) : (
                <span />
              )}
            </article>
          );
        })}
        {records.length === 0 && (
          <div className="empty-state">
            <Icon name="hidden" />
            <strong>Nothing is hidden</strong>
            <span>Documents you hide are listed here.</span>
          </div>
        )}
      </div>
    </main>
  );
}
