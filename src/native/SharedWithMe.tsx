import { useEffect, useRef, useState } from "react";
import type { PatientProfile, ReceivedFile, VaultFolder } from "../vault";
import { Icon } from "../Icon";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * "Shared with me" (#61, Ben's review): files shared to myCarlos from another
 * app, or opened with it on a computer, wait here, one row each, until the
 * patient adds one (choosing the person and folder) or declines it. Nothing
 * of a file is in the vault until it is added.
 */
export function SharedWithMe({
  files,
  profiles,
  folders,
  defaultProfileId,
  computer,
  notPdfId,
  notice,
  paused,
  disabled,
  onAdd,
  onDecline,
}: {
  files: ReceivedFile[];
  profiles: PatientProfile[];
  folders: VaultFolder[];
  /** The person whose records are open: the first choice of where to add. */
  defaultProfileId: string;
  /** On a computer a file comes by being opened with myCarlos; on a phone,
   * from another app's Share. */
  computer: boolean;
  /** A file an add refused as not a PDF: it can only be declined. */
  notPdfId: string | null;
  notice: string;
  /** Changes are paused (the vault is read-only), so every button here is
   * off; the records section says why. */
  paused: boolean;
  disabled: boolean;
  /** Settles once the add is over, and the list says whether the file left. */
  onAdd: (
    id: string,
    profileId: string,
    folderId: string | null,
  ) => Promise<void> | void;
  onDecline: (id: string) => void;
}) {
  // The one file whose "Add to" choice is open, if any.
  const [adding, setAdding] = useState<string | null>(null);
  const [confirmDecline, setConfirmDecline] = useState<ReceivedFile | null>(
    null,
  );
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // A file that was added or declined leaves the list; the focus goes to the
  // page's heading instead of being lost with its row.
  const count = files.length;
  const previousCount = useRef(count);
  useEffect(() => {
    if (count < previousCount.current) headingRef.current?.focus();
    previousCount.current = count;
  }, [count]);
  // When the Add choice closes on a row that stays (Cancel, or an add that
  // was refused), focus goes back to that row's first button: on Cancel at
  // once, after an add once it is over and the buttons are on again. A row
  // that left gives the heading focus instead.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  useEffect(() => {
    if (returnTo === null || disabled) return;
    rows.current.get(returnTo)?.querySelector("button")?.focus();
    setReturnTo(null);
  }, [returnTo, disabled, files]);
  const origin = computer ? "Opened with myCarlos" : "Shared from another app";
  return (
    <main className="library-main native-shared" aria-labelledby="shared-title">
      <div className="main-head">
        <div>
          <h1 id="shared-title" ref={headingRef} tabIndex={-1}>
            Shared with me
          </h1>
          <p>
            {count === 0
              ? "Nothing is waiting."
              : count === 1
                ? "1 file is waiting."
                : `${count} files are waiting.`}
          </p>
        </div>
      </div>
      <p className="native-shared-intro">
        {computer
          ? "Files you open with myCarlos wait here."
          : "Files you share to myCarlos from another app wait here."}{" "}
        They are not in your records until you add them.
      </p>
      {paused && (
        <div className="purpose-note warning">
          <Icon name="info" />
          <span>
            <strong>Changes are paused.</strong> Files can't be added or
            declined for now. My records says why, and what to do.
          </span>
        </div>
      )}
      <p className="status-line" role="status" aria-live="polite">
        {notice}
      </p>
      {count === 0 ? (
        <p className="native-shared-empty">
          {computer
            ? "To add a PDF this way, open it with myCarlos from your computer's files."
            : "To add a PDF this way, choose Share in the app that has it, then myCarlos."}
        </p>
      ) : (
        <ul className="native-shared-list" aria-label="Files waiting">
          {files.map((file) => (
            <li
              key={file.id}
              className="native-shared-row"
              ref={(row) => {
                if (row) rows.current.set(file.id, row);
                else rows.current.delete(file.id);
              }}
            >
              <div className="native-shared-file">
                <strong>{file.name}</strong>
                <small>
                  {origin} · will be marked "{file.sourceLabel}"
                </small>
                {file.id === notPdfId && (
                  <small className="native-shared-refused">
                    Not a PDF document: myCarlos can't add it.
                  </small>
                )}
              </div>
              <div className="native-shared-actions">
                {file.id !== notPdfId && adding !== file.id && (
                  <button
                    className="button primary"
                    type="button"
                    aria-label={`Add ${file.name}…`}
                    disabled={disabled}
                    onClick={() => setAdding(file.id)}
                  >
                    Add…
                  </button>
                )}
                {adding !== file.id && (
                  <button
                    className="button"
                    type="button"
                    aria-label={`Decline ${file.name}`}
                    disabled={disabled}
                    onClick={() => setConfirmDecline(file)}
                  >
                    Decline
                  </button>
                )}
              </div>
              {adding === file.id && (
                <AddTo
                  file={file}
                  profiles={profiles}
                  folders={folders}
                  defaultProfileId={defaultProfileId}
                  disabled={disabled}
                  onCancel={() => {
                    setAdding(null);
                    setReturnTo(file.id);
                  }}
                  onAdd={(profileId, folderId) => {
                    setAdding(null);
                    void Promise.resolve(
                      onAdd(file.id, profileId, folderId),
                    ).finally(() => setReturnTo(file.id));
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {confirmDecline && (
        <ConfirmDialog
          title={`Decline ${confirmDecline.name}?`}
          confirmLabel="Decline"
          onCancel={() => setConfirmDecline(null)}
          onConfirm={() => {
            const id = confirmDecline.id;
            setConfirmDecline(null);
            onDecline(id);
          }}
        >
          It is not added, and myCarlos forgets it. The app that shared it still
          has it.
        </ConfirmDialog>
      )}
    </main>
  );
}

/** Where one file goes: the person, then a folder of theirs or none. */
function AddTo({
  file,
  profiles,
  folders,
  defaultProfileId,
  disabled,
  onCancel,
  onAdd,
}: {
  file: ReceivedFile;
  profiles: PatientProfile[];
  folders: VaultFolder[];
  defaultProfileId: string;
  disabled: boolean;
  onCancel: () => void;
  onAdd: (profileId: string, folderId: string | null) => void;
}) {
  const [profileId, setProfileId] = useState(defaultProfileId);
  const [folderId, setFolderId] = useState("");
  const theirFolders = folders
    .filter((folder) => folder.profileId === profileId)
    .sort((left, right) => left.name.localeCompare(right.name));
  const personRef = useRef<HTMLSelectElement | null>(null);
  useEffect(() => personRef.current?.focus(), []);
  return (
    <form
      className="native-shared-add"
      aria-label={`Add ${file.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(profileId, folderId || null);
      }}
    >
      <label>
        Whose records
        <select
          ref={personRef}
          value={profileId}
          disabled={disabled}
          onChange={(event) => {
            setProfileId(event.target.value);
            setFolderId("");
          }}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Folder
        <select
          value={folderId}
          disabled={disabled}
          onChange={(event) => setFolderId(event.target.value)}
        >
          <option value="">No folder (My records)</option>
          {theirFolders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      <div className="native-shared-add-actions">
        <button className="button primary" type="submit" disabled={disabled}>
          Add
        </button>
        <button
          className="button"
          type="button"
          disabled={disabled}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
