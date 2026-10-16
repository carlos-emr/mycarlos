import { useEffect, useState } from "react";
import type { PassphraseRules } from "../vault";

// The vault counts a new passphrase's characters (Unicode code points) after
// NFC normalization, so the same visible text is judged alike from any keyboard.
export const MIN_PASSPHRASE_CHARS = 15;
export const tooShortPassphrase = (value: string) =>
  [...value.normalize("NFC")].length < MIN_PASSPHRASE_CHARS;

/** How long typing must pause before the vault judges the passphrase. */
export const RULES_CHECK_DELAY_MS = 300;

/** Asks the vault which rules a new passphrase meets (#69). */
export type CheckPassphraseRules = (
  passphrase: string,
  profile: string,
) => Promise<PassphraseRules>;

/**
 * The vault's answers about the passphrase being typed: whether it is free
 * of any word of the name, and hard to guess. Asked once typing pauses, never
 * while `paused` (Create was pressed). Null: not known yet. Every change to
 * the passphrase or the name calls `forget`, so that an answer is only ever
 * about what is typed now; no copy of the passphrase is kept to compare.
 */
export function useNewPassphraseRules(
  check: CheckPassphraseRules | undefined,
  passphrase: string,
  profile: string,
  paused: boolean,
) {
  const [rules, setRules] = useState<PassphraseRules | null>(null);
  useEffect(() => {
    if (!check || paused || !passphrase) return;
    let current = true;
    const timer = window.setTimeout(() => {
      check(passphrase, profile).then(
        (answer) => {
          if (current) setRules(answer);
        },
        // Unanswered rules stay unknown: Create still has the vault judge.
        () => undefined,
      );
    }, RULES_CHECK_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [check, paused, passphrase, profile]);
  return { rules, forget: () => setRules(null) };
}

function Rule({ met, children }: { met: boolean; children: string }) {
  return (
    <li data-met={met}>
      <span className="passphrase-rule-mark" aria-hidden="true">
        {met ? "✓" : "○"}
      </span>
      {children}
      <span className="sr-only">{met ? ", done" : ", not yet"}</span>
    </li>
  );
}

/** The rules for a new passphrase, shown before typing, each ticking itself
 * as it is met (#69). */
export function PassphraseChecklist({
  id,
  passphrase,
  rules,
}: {
  id: string;
  passphrase: string;
  rules: PassphraseRules | null;
}) {
  return (
    <div className="passphrase-checklist" id={id}>
      <p>Your passphrase needs to be:</p>
      <ul>
        <Rule met={Boolean(passphrase) && !tooShortPassphrase(passphrase)}>
          {`At least ${MIN_PASSPHRASE_CHARS} characters`}
        </Rule>
        <Rule met={Boolean(rules?.hardToGuess)}>Not easy to guess</Rule>
        <Rule met={Boolean(rules?.notAName)}>Not your name</Rule>
      </ul>
      <p>
        Spaces are allowed, so a few unrelated words make a good one. myCarlos
        checks these rules on this computer.
      </p>
    </div>
  );
}
