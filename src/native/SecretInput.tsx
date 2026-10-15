import { useId, type ComponentPropsWithRef } from "react";
import { useI18n } from "../i18n";

type Props = Omit<ComponentPropsWithRef<"input">, "value" | "type"> & {
  value: string;
  type?: "password" | "text";
  secretKind?: "password" | "recovery key";
};

/** Keep the browser's protected input semantics. Only the count, never the
 * secret, goes into the hover text or accessible description. Native screen
 * reader password echo remains controlled by the reader and needs device tests. */
export function SecretInput({
  value,
  type = "password",
  secretKind = "password",
  "aria-describedby": describedBy,
  ...props
}: Props) {
  const { t } = useI18n();
  const countId = useId();
  const countedValue =
    secretKind === "password" ? value.normalize("NFC") : value;
  const count = t(
    secretKind === "password"
      ? "secret.count.password"
      : "secret.count.recoveryKey",
    { count: Array.from(countedValue).length },
  );
  const description =
    type === "password"
      ? count
      : t("secret.count.shown", { description: count });
  return (
    <span className="secret-input">
      <input
        {...props}
        type={type}
        value={value}
        title={description}
        aria-describedby={[countId, describedBy].filter(Boolean).join(" ")}
      />
      <small id={countId} className="secret-count">
        {description}
      </small>
    </span>
  );
}
