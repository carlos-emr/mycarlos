import { useId, type ComponentPropsWithRef } from "react";

type Props = Omit<ComponentPropsWithRef<"input">, "value" | "type"> & {
  value: string;
  type?: "password" | "text";
  secretKind?: "password" | "recovery key";
};

/** Keep the browser's protected input semantics. Only the count, never the
 * secret, goes into the hover text or accessible description. Native screen
 * reader password echo remains controlled by the reader and needs device tests.
 * A secret shown as text is not handed to the spell checker, autocorrection or
 * capitalization (#69); a caller may still choose its capitalization, as the
 * recovery key does. */
export function SecretInput({
  value,
  type = "password",
  secretKind = "password",
  "aria-describedby": describedBy,
  ...props
}: Props) {
  const countId = useId();
  const countedValue =
    secretKind === "password" ? value.normalize("NFC") : value;
  const count = `${Array.from(countedValue).length} character ${secretKind}`;
  const description = type === "password" ? count : `${count}, shown`;
  return (
    <span className="secret-input">
      <input
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
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
