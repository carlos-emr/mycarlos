import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";
import { RecordSource } from "./RecordSource";
import {
  hasVaultErrorCode,
  type AndroidReaderLabels,
  type VaultRecord,
} from "../vault";

/** Android shows a stored PDF in a native PdfRenderer window with no vault bridge (#358). No
 * document bytes enter this component: it owns only the pending open and its cancellation, and
 * says plainly when the document cannot be shown. */
export function AndroidDocumentReader({
  record,
  read,
  cancel,
  onClose,
}: {
  record: VaultRecord;
  read: (recordId: string, labels: AndroidReaderLabels) => Promise<void>;
  cancel: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLElement | null>(null);
  const close = useRef<HTMLButtonElement | null>(null);
  const actions = useRef({ read, cancel, onClose });
  actions.current = { read, cancel, onClose };
  const closeLabel = t("photo.close");
  // The reader's own words: the page texts keep {page} and {total} for the native side to fill.
  const labels = useMemo<AndroidReaderLabels>(
    () => ({
      close: closeLabel,
      previous: t("reader.android.previous"),
      next: t("reader.android.next"),
      zoomIn: t("reader.android.zoomIn"),
      zoomOut: t("reader.android.zoomOut"),
      page: t("reader.android.page", { page: "{page}", total: "{total}" }),
      pageStatus: t("reader.android.pageStatus", {
        page: "{page}",
        total: "{total}",
      }),
    }),
    [closeLabel, t],
  );
  useModalFocus(true, dialog, onClose, close);

  useEffect(() => {
    let current = true;
    setError("");
    void actions.current.read(record.id, labels).then(
      () => {
        if (current) actions.current.onClose();
      },
      (failure: unknown) => {
        if (!current) return;
        if (hasVaultErrorCode(failure, "cancelled")) {
          actions.current.onClose();
          return;
        }
        setError(
          hasVaultErrorCode(failure, "pdf_mobile_too_large")
            ? t("reader.android.tooLarge")
            : hasVaultErrorCode(failure, "pdf_view_unavailable")
              ? t("reader.android.unavailable")
              : t("reader.android.failed"),
        );
      },
    );
    return () => {
      current = false;
      void actions.current.cancel().catch(() => undefined);
    };
  }, [record.id, labels, t]);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="android-reader-title"
        aria-describedby="android-reader-source"
        className="record-dialog native-reader"
      >
        <header className="dialog-head">
          <h2 id="android-reader-title">{record.displayName}</h2>
          <button ref={close} className="button" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        <p id="android-reader-source">
          <RecordSource record={record} />
        </p>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p role="status">{t("reader.android.opening")}</p>
        )}
      </section>
    </div>
  );
}
