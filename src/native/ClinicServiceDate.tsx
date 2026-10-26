import { useI18n } from "../i18n";

/** Undefined means this is not a clinic delivery; empty is an explicit unknown. */
export function ClinicServiceDate({ value }: { value: string | undefined }) {
  const { t } = useI18n();
  if (value === undefined) return null;
  return (
    <small>
      {t("portal.serviceDate", {
        date: value === "" ? t("portal.dateNotRecorded") : value,
      })}
    </small>
  );
}
