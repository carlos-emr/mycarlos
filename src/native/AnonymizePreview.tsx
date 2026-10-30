import {
  useI18n,
  t as translateNow,
  useTextState,
  deferredText,
  type MessageKey,
} from "../i18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useModalFocus } from "../useModalFocus";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  hasVaultErrorCode,
  vaultErrorMessage,
  type KnownIdentifiers,
  type PatientProfile,
  type TextSaveOutcome,
  type VaultRecord,
} from "../vault";
import type { DocumentText } from "../documentText";
import {
  deidentify,
  removeMore,
  type Deidentified,
  type PlaceholderLabels,
  type RemovedKind,
} from "../deidentify/deidentify";

/** The kinds a removal can have, for the labels. */
const KINDS: (RemovedKind | "date")[] = [
  "name",
  "doctor",
  "clinic",
  "healthCard",
  "recordNumber",
  "sin",
  "dateOfBirth",
  "age",
  "address",
  "postalCode",
  "phone",
  "email",
  "web",
  "unclearDate",
  "manual",
  "date",
];

const kindKey = (kind: RemovedKind | "date"): MessageKey =>
  kind === "date"
    ? "interface.AnonymizePreview.movedDate"
    : (`interface.AnonymizePreview.kind.${kind}` as MessageKey);

/** The placeholder words in the app's language ("[NOM 1]"). */
function placeholderLabels(): PlaceholderLabels {
  const labels = {} as PlaceholderLabels;
  for (const kind of KINDS)
    if (kind !== "date")
      labels[kind] = translateNow(
        `interface.AnonymizePreview.placeholder.${kind}` as MessageKey,
      );
  return labels;
}

const pageList = (pages: number[]) =>
  pages.map((page) => String(page + 1)).join(", ");

/** The preview of a document's text with identifying details removed, where
 * the patient reads it, removes more, and saves it as a text file for an AI
 * service of their choice (#72 part B). The remover runs here, on this
 * device; the save goes through native code, which re-checks the text for
 * the vault's own identifiers and writes the fixed first line (AI-02).
 * Nothing is saved without this preview and its confirmation. Computers
 * only, as the reader is. */
export function AnonymizePreview({
  record,
  people,
  clinicNames,
  readText,
  cancelRead,
  knownDetails,
  pickDestination,
  saveText,
  exportHeader,
  onClose,
}: {
  record: VaultRecord;
  /** Every profile but Shared with me's: their names and birth dates are
   * removed wherever they stand. */
  people: PatientProfile[];
  /** Clinic names the vault knows: verified senders and linked portals. */
  clinicNames: string[];
  readText: (password?: string) => Promise<DocumentText>;
  cancelRead: () => void;
  knownDetails: () => Promise<KnownIdentifiers>;
  pickDestination: (ticket: string) => Promise<string | null>;
  saveText: (
    pickId: string,
    ticket: string,
    text: string,
  ) => Promise<TextSaveOutcome>;
  /** The fixed first line of the file, shown so the patient knows. */
  exportHeader: string;
  onClose: () => void;
}) {
  useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState<DocumentText | null>(null);
  // The automatic result, then one entry per removal the patient made.
  const [history, setHistory] = useState<Deidentified[]>([]);
  const current = history[history.length - 1] ?? null;
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [wrongTries, setWrongTries] = useState(0);
  const [error, setError] = useTextState();
  const [notice, setNotice] = useTextState();
  const [phrase, setPhrase] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const close = useCallback(() => {
    cancelRead();
    onClose();
  }, [cancelRead, onClose]);
  useModalFocus(true, dialogRef, close, closeRef);

  const read = useCallback(
    async (password?: string) => {
      setError("");
      try {
        const [read, known] = await Promise.all([
          readText(password),
          knownDetails(),
        ]);
        const knownNames = [
          ...people.flatMap((person) => [
            person.displayName,
            ...(person.fullName ? [person.fullName] : []),
          ]),
          ...known.names,
        ];
        const knownBirthDates = [
          ...people.flatMap((person) =>
            person.birthDate ? [person.birthDate] : [],
          ),
          ...known.birthDates,
        ];
        const result = deidentify(read.joined, {
          knownNames,
          knownBirthDates,
          knownClinics: [...clinicNames, ...known.clinicNames],
          knownDoctors: known.doctorNames,
          labels: placeholderLabels(),
        });
        setText(read);
        setTicket(read.ticket);
        setHistory([result]);
        setAsking(false);
        setTyped("");
      } catch (failure) {
        if (hasVaultErrorCode(failure, "cancelled")) return;
        if (hasVaultErrorCode(failure, "pdfLocked")) {
          setAsking(true);
          return;
        }
        if (hasVaultErrorCode(failure, "pdfWrongPassword")) {
          setAsking(true);
          setWrongTries((tries) => tries + 1);
          setTyped("");
          return;
        }
        setError(
          deferredText(
            () =>
              `${translateNow("interface.AnonymizePreview.readFailed")} ${vaultErrorMessage(failure)}`,
          ),
        );
      }
    },
    [readText, knownDetails, people, clinicNames, setError],
  );
  useEffect(() => {
    void read();
    // Read once, when the preview opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const giveDocumentPassword = (event: FormEvent) => {
    event.preventDefault();
    if (!typed) return;
    void read(typed);
  };

  /** Removes a range of the shown text, as a new step the patient can undo. */
  const remove = (
    sentStart: number,
    sentEnd: number,
    options: { over?: boolean } = {},
  ) => {
    if (!current) return false;
    try {
      const next = removeMore(current, sentStart, sentEnd, options);
      setHistory((steps) => [...steps, next]);
      return true;
    } catch {
      return false;
    }
  };

  /** The selection, as a range of the shown text, when it lies in it. */
  const selectedRange = (): [number, number] | null => {
    const selection = window.getSelection();
    const container = textRef.current;
    if (!selection || selection.rangeCount === 0 || !container) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed || !container.contains(range.commonAncestorContainer))
      return null;
    const offsetOf = (node: Node, offset: number): number | null => {
      const element =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as Element);
      const start =
        element?.closest<HTMLElement>("[data-start]")?.dataset.start;
      if (start === undefined) return null;
      return Number(start) + (node.nodeType === Node.TEXT_NODE ? offset : 0);
    };
    const start = offsetOf(range.startContainer, range.startOffset);
    const end = offsetOf(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    return [start, end];
  };

  const removeSelected = () => {
    const range = selectedRange();
    if (!range) {
      setNotice(
        deferredText(() =>
          translateNow("interface.AnonymizePreview.selectFirst"),
        ),
      );
      return;
    }
    if (remove(range[0], range[1])) {
      window.getSelection()?.removeAllRanges();
      setNotice(
        deferredText(() =>
          translateNow("interface.AnonymizePreview.removedPlaces", {
            count: 1,
          }),
        ),
      );
    } else
      setNotice(
        deferredText(() =>
          translateNow("interface.AnonymizePreview.selectFirst"),
        ),
      );
  };

  /** Removes every place a word or phrase stands, outside the placeholders. */
  const removePhrase = (event: FormEvent) => {
    event.preventDefault();
    const wanted = phrase.trim().toLowerCase();
    if (!wanted || !current) return;
    let step = current;
    let count = 0;
    const lower = step.toSend.toLowerCase();
    const places: number[] = [];
    for (
      let at = lower.indexOf(wanted);
      at >= 0;
      at = lower.indexOf(wanted, at + 1)
    )
      places.push(at);
    // From the end, so earlier offsets stay right.
    for (const at of places.reverse()) {
      try {
        step = removeMore(step, at, at + wanted.length);
        count += 1;
      } catch {
        // Inside a placeholder already: nothing to remove there.
      }
    }
    if (count === 0) {
      setNotice(
        deferredText(() =>
          translateNow("interface.AnonymizePreview.phraseNotFound"),
        ),
      );
      return;
    }
    setHistory((steps) => [...steps, step]);
    setPhrase("");
    setNotice(
      deferredText(() =>
        translateNow("interface.AnonymizePreview.removedPlaces", { count }),
      ),
    );
  };

  const undo = () => {
    setHistory((steps) => (steps.length > 1 ? steps.slice(0, -1) : steps));
    setNotice("");
  };

  const save = async () => {
    setConfirming(false);
    if (!current || !ticket) return;
    setSaving(true);
    setError("");
    try {
      const pickId = await pickDestination(ticket);
      if (!pickId) {
        setNotice(
          deferredText(() =>
            translateNow("interface.AnonymizePreview.saveCancelled"),
          ),
        );
        return;
      }
      const outcome = await saveText(pickId, ticket, current.toSend);
      if (outcome.saved) {
        setTicket(null);
        setNotice(
          deferredText(() => translateNow("interface.AnonymizePreview.saved")),
        );
        return;
      }
      // What native code still found: taken out, placeholders and moved
      // dates whole, for the patient to check and save again.
      let step = current;
      for (const hit of [...outcome.hits].sort((a, b) => b.start - a.start)) {
        try {
          step = removeMore(step, hit.start, hit.end, { over: true });
        } catch {
          // Out of the text: nothing to do.
        }
      }
      setHistory((steps) => [...steps, step]);
      setNotice(
        deferredText(() =>
          translateNow("interface.AnonymizePreview.refused", {
            count: outcome.hits.length,
          }),
        ),
      );
    } catch (failure) {
      setError(deferredText(() => vaultErrorMessage(failure)));
    } finally {
      setSaving(false);
    }
  };

  /** The shown text as runs: plain text, and each removal as a mark. */
  const runs: { start: number; text: string; kind?: RemovedKind | "date" }[] =
    [];
  if (current) {
    let at = 0;
    for (const part of current.onDevice.removed) {
      if (part.sentStart > at)
        runs.push({
          start: at,
          text: current.toSend.slice(at, part.sentStart),
        });
      runs.push({
        start: part.sentStart,
        text: part.replacement,
        kind: part.kind,
      });
      at = part.sentEnd;
    }
    if (at < current.toSend.length)
      runs.push({ start: at, text: current.toSend.slice(at) });
  }
  const possibleNames = current?.onDevice.possibleNames ?? [];
  const busy = !current || saving;

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-reader native-anonymize"
        role="dialog"
        aria-modal="true"
        aria-labelledby="anonymize-title"
        aria-describedby="anonymize-how"
      >
        <header className="dialog-head native-reader-head">
          <div>
            <h2 id="anonymize-title">
              {translateNow("interface.AnonymizePreview.title")}
            </h2>
            <p>{record.displayName}</p>
          </div>
          <button
            ref={closeRef}
            className="button"
            type="button"
            onClick={close}
          >
            {translateNow("interface.AnonymizePreview.close")}
          </button>
        </header>
        <div className="native-anonymize-notes">
          <p id="anonymize-how">
            {translateNow("aiHelper.notice.limitsBody")}{" "}
            {translateNow("interface.AnonymizePreview.howMarked")}
          </p>
          {text && text.truncated && (
            <p>
              {translateNow("interface.AnonymizePreview.truncated", {
                count: text.pages.length,
              })}
            </p>
          )}
          {text && text.emptyPages.length > 0 && (
            <p>
              {translateNow("interface.AnonymizePreview.emptyPages", {
                pages: pageList(text.emptyPages),
              })}
            </p>
          )}
          {text && text.cutPages.length > 0 && (
            <p>
              {translateNow("interface.AnonymizePreview.cutPages", {
                pages: pageList(text.cutPages),
              })}
            </p>
          )}
          {text && text.failedPages.length > 0 && (
            <p>
              {translateNow("interface.AnonymizePreview.failedPages", {
                pages: pageList(text.failedPages),
              })}
            </p>
          )}
          {current && current.onDevice.cleaning.replacedRuns > 0 && (
            <p>
              {translateNow("interface.AnonymizePreview.replaced", {
                count: current.onDevice.cleaning.replacedRuns,
              })}
            </p>
          )}
        </div>
        {asking && (
          <form
            className="native-reader-password"
            onSubmit={giveDocumentPassword}
          >
            <p id="anonymize-password-help">
              {translateNow(
                "interface.DocumentReader.thisDocumentIsLockedWithItsOwn",
              )}
            </p>
            <label htmlFor="anonymize-password">
              {translateNow("interface.DocumentReader.documentPassword")}
            </label>
            <input
              id="anonymize-password"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              aria-describedby={
                wrongTries
                  ? "anonymize-password-help anonymize-password-error"
                  : "anonymize-password-help"
              }
              aria-invalid={wrongTries ? true : undefined}
              onChange={(event) => setTyped(event.target.value)}
            />
            {wrongTries > 0 && (
              <p id="anonymize-password-error" role="alert" key={wrongTries}>
                {translateNow(
                  "interface.DocumentReader.thatPasswordDidNotOpenTheDocument",
                )}
              </p>
            )}
            <button className="button primary" disabled={!typed}>
              {translateNow("interface.DocumentReader.open")}
            </button>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {!current && !asking && !error && (
          <p className="native-dialog-status" role="status">
            {translateNow("interface.AnonymizePreview.reading")}
          </p>
        )}
        {current && (
          <>
            <p className="native-anonymize-header">
              <span>
                {translateNow("interface.AnonymizePreview.headerNote")}
              </span>{" "}
              <span className="native-anonymize-fixed">{exportHeader}</span>
            </p>
            <div
              className="native-anonymize-text"
              ref={textRef}
              tabIndex={0}
              role="region"
              aria-label={translateNow("interface.AnonymizePreview.textRegion")}
            >
              {runs.map((run) =>
                run.kind ? (
                  <mark
                    key={run.start}
                    data-start={run.start}
                    data-kind={run.kind}
                    className={
                      run.kind === "date" ? "native-anonymize-moved" : undefined
                    }
                  >
                    {run.text}
                    <span className="sr-only">
                      {" ("}
                      {run.kind === "date"
                        ? translateNow(kindKey("date"))
                        : translateNow(
                            "interface.AnonymizePreview.removedKind",
                            {
                              kind: translateNow(kindKey(run.kind)),
                            },
                          )}
                      {")"}
                    </span>
                  </mark>
                ) : (
                  <span key={run.start} data-start={run.start}>
                    {run.text}
                  </span>
                ),
              )}
            </div>
            {possibleNames.length > 0 && (
              <div className="native-anonymize-possible">
                <h3>
                  {translateNow("interface.AnonymizePreview.possibleNames")}
                </h3>
                <ul>
                  {possibleNames.map((possible) => (
                    <li key={possible.sentStart}>
                      <button
                        className="button"
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          remove(possible.sentStart, possible.sentEnd)
                        }
                      >
                        {translateNow("interface.AnonymizePreview.removeWord", {
                          word: possible.original,
                        })}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <form className="native-anonymize-tools" onSubmit={removePhrase}>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={removeSelected}
              >
                {translateNow("interface.AnonymizePreview.removeSelected")}
              </button>
              <label htmlFor="anonymize-phrase">
                {translateNow("interface.AnonymizePreview.phrase")}
              </label>
              <input
                id="anonymize-phrase"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={phrase}
                disabled={busy}
                onChange={(event) => setPhrase(event.target.value)}
              />
              <button className="button" disabled={busy || !phrase.trim()}>
                {translateNow("interface.AnonymizePreview.removePhrase")}
              </button>
              <button
                className="button"
                type="button"
                disabled={busy || history.length < 2}
                onClick={undo}
              >
                {translateNow("interface.AnonymizePreview.undo")}
              </button>
            </form>
            {notice && (
              <p className="native-dialog-status" role="status">
                {notice}
              </p>
            )}
            <footer className="native-dialog-actions">
              <button
                className="button primary"
                type="button"
                disabled={busy || !ticket}
                onClick={() => setConfirming(true)}
              >
                {translateNow("interface.AnonymizePreview.save")}
              </button>
            </footer>
          </>
        )}
      </section>
      {confirming && (
        <ConfirmDialog
          title={translateNow("interface.AnonymizePreview.confirmTitle")}
          confirmLabel={translateNow("interface.AnonymizePreview.save")}
          onConfirm={() => void save()}
          onCancel={() => setConfirming(false)}
        >
          {translateNow("interface.AnonymizePreview.confirmBody")}
        </ConfirmDialog>
      )}
    </div>
  );
}
