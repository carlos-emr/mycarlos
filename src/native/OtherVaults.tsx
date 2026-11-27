import { useState } from "react";
import { useI18n } from "../i18n";
import type { FoundVaults } from "../vault";

/**
 * "Use a different vault" on the unlock screen (#357): a Vault name field, never a list, since the
 * device keeps no readable name (only a salted hash of each) and a list would also say which names
 * exist. Closed by default and shown on every device, so that showing it says nothing about how
 * many vaults there are. An empty name is the device's own vault: Unlock then behaves as it always
 * did. Inside it, "Find my other vaults" tries the typed passphrase on each folder the device does
 * not know, and names what it finds (all or none).
 *
 * Nothing here says how many vaults exist: the counts below are of the search the patient just
 * asked for, with that passphrase, and the opaque folder ids are never shown.
 */
export function OtherVaults({
  name,
  onName,
  passphrase,
  busy,
  onFind,
  onNameFound,
}: {
  name: string;
  onName: (value: string) => void;
  /** The passphrase typed on the unlock screen, which "Find vaults" tries. */
  passphrase: string;
  busy: boolean;
  /** Runs the search (counted as passphrase tries); null when it could not run. */
  onFind: (passphrase: string) => Promise<FoundVaults | null>;
  /** Saves the names given to the found vaults, all or none: whether it was saved. */
  onNameFound: (vaults: { id: string; name: string }[]) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<FoundVaults | null>(null);
  // The name typed for each found vault, in the order they were found.
  const [names, setNames] = useState<string[]>([]);
  const [saved, setSaved] = useState<"" | "saved" | "failed">("");
  const find = async () => {
    setSaved("");
    setResult(null);
    const found = await onFind(passphrase);
    if (!found) return;
    setResult(found);
    setNames(found.found.map(() => ""));
  };
  const save = async () => {
    if (!result) return;
    const ok = await onNameFound(
      result.found.map((id, index) => ({ id, name: names[index].trim() })),
    );
    setSaved(ok ? "saved" : "failed");
    if (ok) {
      setResult(null);
      setNames([]);
    }
  };
  const everyNameGiven = names.every((value) => value.trim().length > 0);
  return (
    <details className="vault-reset other-vaults">
      <summary>{t("unlock.otherVault.summary")}</summary>
      <label>
        {t("unlock.otherVault.name")}
        <input
          autoComplete="off"
          spellCheck={false}
          aria-describedby="other-vault-hint"
          value={name}
          onChange={(event) => onName(event.target.value)}
        />
      </label>
      <p id="other-vault-hint">{t("unlock.otherVault.hint")}</p>
      <h2 className="vault-reset-heading">{t("unlock.otherVault.find")}</h2>
      <p>{t("unlock.otherVault.findHelp")}</p>
      <button
        className="button"
        type="button"
        disabled={busy || !passphrase}
        onClick={() => void find()}
      >
        {t("unlock.otherVault.findButton")}
      </button>
      {result && (
        <div role="status" className="other-vaults-result">
          {result.found.length > 0 ? (
            <p>
              {t("unlock.otherVault.found", { count: result.found.length })}
            </p>
          ) : (
            <p>{t("unlock.otherVault.none")}</p>
          )}
          {result.notOpened > 0 && (
            <p>
              {t("unlock.otherVault.notOpened", { count: result.notOpened })}
            </p>
          )}
          {result.empty > 0 && (
            <p>{t("unlock.otherVault.empty", { count: result.empty })}</p>
          )}
        </div>
      )}
      {result && result.found.length > 0 && (
        <fieldset className="other-vaults-names">
          <legend>{t("unlock.otherVault.nameTitle")}</legend>
          {result.found.map((id, index) => (
            <label key={id}>
              {t("unlock.otherVault.nameLabel", {
                number: index + 1,
                count: result.found.length,
              })}
              <input
                autoComplete="off"
                spellCheck={false}
                value={names[index] ?? ""}
                onChange={(event) =>
                  setNames((current) =>
                    current.map((value, at) =>
                      at === index ? event.target.value : value,
                    ),
                  )
                }
              />
            </label>
          ))}
          <button
            className="button primary"
            type="button"
            disabled={busy || !everyNameGiven}
            onClick={() => void save()}
          >
            {t("unlock.otherVault.save")}
          </button>
        </fieldset>
      )}
      {saved === "saved" && <p role="status">{t("unlock.otherVault.named")}</p>}
      {saved === "failed" && (
        <p role="alert">{t("unlock.otherVault.nameFailed")}</p>
      )}
    </details>
  );
}
