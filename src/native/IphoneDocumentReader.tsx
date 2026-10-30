import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";
import { hasVaultErrorCode, type VaultRecord } from "../vault";

/** iPhone uses a native PDF view with no vault bridge. No document bytes enter
 * this component; it owns only the pending open and its cancellation. */
export function IphoneDocumentReader({
  record,
  read,
  cancel,
  onClose,
}: {
  record: VaultRecord;
  read: (recordId: string, closeLabel: string) => Promise<void>;
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
  useModalFocus(true, dialog, onClose, close);

  useEffect(() => {
    let current = true;
    setError("");
    void actions.current.read(record.id, closeLabel).then(
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
            ? t("reader.iphone.tooLarge")
            : t("reader.iphone.failed"),
        );
      },
    );
    return () => {
      current = false;
      void actions.current.cancel().catch(() => undefined);
    };
  }, [record.id, closeLabel, t]);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="iphone-reader-title"
        aria-describedby="iphone-reader-source"
        className="record-dialog native-reader"
      >
        <header className="dialog-head">
          <h2 id="iphone-reader-title">{record.displayName}</h2>
          <button ref={close} className="button" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        <p id="iphone-reader-source">{record.sourceLabel}</p>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <p role="status">{t("reader.iphone.opening")}</p>
        )}
      </section>
    </div>
  );
}
