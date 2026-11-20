import { useState } from "react";
import type { PatientModelRow } from "../ai/types";
import { useI18n } from "../i18n";
import { ConfirmDialog } from "./ConfirmDialog";

/** These rows have no catalog index. Never turn a patient hash into one. */
export function PatientModelRows({
  rows,
  busy,
  unsupported = false,
  onAction,
}: {
  rows: PatientModelRow[];
  busy: boolean;
  unsupported?: boolean;
  onAction: (
    command: "ai_model_use" | "ai_model_remove" | "ai_model_trial",
    sha256: string,
  ) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [removing, setRemoving] = useState<PatientModelRow | null>(null);
  if (!rows.length) return null;
  const name = (row: PatientModelRow) =>
    t("ai.patient.name", { number: row.number });
  return (
    <section aria-label={t("ai.patient.title")}>
      <h3>{t("ai.patient.title")}</h3>
      <p>{t("ai.patient.warning")}</p>
      {rows.map((row) => (
        <section
          key={row.sha256}
          className="native-ai-model-entry"
          aria-label={name(row)}
        >
          <h4>{name(row)}</h4>
          <p>
            {Math.round(row.sizeBytes / 1_000_000).toLocaleString(locale)} MB
          </p>
          <p>
            {t(
              row.state === "damaged"
                ? "ai.model.damaged"
                : row.trial === "passed"
                  ? "ai.patient.passed"
                  : row.trial === "model"
                    ? "ai.patient.model"
                    : row.trial === "template"
                      ? "ai.patient.template"
                      : row.trial === "context"
                        ? "ai.patient.context"
                        : "ai.patient.notTried",
            )}
          </p>
          {row.inUse && (
            <p>
              <strong>{t("ai.models.inUse")}</strong>
            </p>
          )}
          <button
            type="button"
            className="button"
            disabled={
              unsupported || row.state !== "installed" || row.trial !== "passed"
            }
            aria-disabled={busy || row.inUse}
            aria-pressed={row.inUse}
            aria-label={`${t("ai.patient.use")} ${name(row)}`}
            onClick={() =>
              !busy && !row.inUse && void onAction("ai_model_use", row.sha256)
            }
          >
            {t("ai.patient.use")}
          </button>
          <button
            type="button"
            className="button"
            disabled={unsupported || row.state === "damaged"}
            aria-disabled={busy}
            aria-label={`${t("ai.patient.trial")} ${name(row)}`}
            onClick={() => !busy && void onAction("ai_model_trial", row.sha256)}
          >
            {t("ai.patient.trial")}
          </button>
          <button
            type="button"
            className="button"
            aria-disabled={busy}
            aria-label={`${t("ai.models.remove")} ${name(row)}`}
            onClick={() => !busy && setRemoving(row)}
          >
            {t("ai.models.remove")}
          </button>
        </section>
      ))}
      {removing && (
        <ConfirmDialog
          title={`${t("ai.models.remove")} ${name(removing)}`}
          confirmLabel={t("ai.models.remove")}
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const hash = removing.sha256;
            setRemoving(null);
            void onAction("ai_model_remove", hash);
          }}
        >
          {t("ai.model.removeConfirm")}
        </ConfirmDialog>
      )}
    </section>
  );
}
