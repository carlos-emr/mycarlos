// A handover (#360) whose key was shown and not used. A lock ends it (so does myCarlos
// closing, or leaving the app on a phone), and the key it showed then opens nothing:
// the patient may have copied it or written it down, so the next unlock says so. Kept in
// webview storage to outlast myCarlos closing. It holds no key and names no person.
const STORAGE_KEY = "mycarlos.unfinishedHandover.v1";

/** The key for one vault: with several vaults on a device (#357) each has its own note, so one
 * vault's unfinished handover is never told at another's unlock. `scope` is that vault's
 * slot id; the single-vault app passes none. */
const keyFor = (scope: string) =>
  scope ? `${STORAGE_KEY}.${scope}` : STORAGE_KEY;

export function rememberUnfinishedHandover(
  unfinished: boolean,
  scope = "",
): void {
  try {
    if (unfinished) window.localStorage.setItem(keyFor(scope), "1");
    else window.localStorage.removeItem(keyFor(scope));
  } catch {
    // Without webview storage the patient is not told after the next unlock; the key's
    // own screen says that leaving ends it.
  }
}

/** Whether a handover was left unfinished; it is forgotten once taken. */
export function takeUnfinishedHandover(scope = ""): boolean {
  try {
    const found = window.localStorage.getItem(keyFor(scope)) === "1";
    window.localStorage.removeItem(keyFor(scope));
    return found;
  } catch {
    return false;
  }
}
