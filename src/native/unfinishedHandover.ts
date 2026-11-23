// A handover (#360) whose key was shown and not used. A lock ends it (so does myCarlos
// closing, or leaving the app on a phone), and the key it showed then opens nothing:
// the patient may have copied it or written it down, so the next unlock says so. Kept in
// webview storage to outlast myCarlos closing. It holds no key and names no person.
const STORAGE_KEY = "mycarlos.unfinishedHandover.v1";

export function rememberUnfinishedHandover(unfinished: boolean): void {
  try {
    if (unfinished) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without webview storage the patient is not told after the next unlock; the key's
    // own screen says that leaving ends it.
  }
}

/** Whether a handover was left unfinished; it is forgotten once taken. */
export function takeUnfinishedHandover(): boolean {
  try {
    const found = window.localStorage.getItem(STORAGE_KEY) === "1";
    window.localStorage.removeItem(STORAGE_KEY);
    return found;
  } catch {
    return false;
  }
}
