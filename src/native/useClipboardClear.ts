import { useCallback, useEffect, useRef } from "react";

/** How long a copy stays on the clipboard before the app takes it off again. */
export const CLIPBOARD_CLEAR_MS = 60_000;

/**
 * Copies a secret-bearing text to the clipboard and takes it off again: after a minute, or when
 * the screen that copied it goes away, but only if the clipboard still holds exactly that text
 * (anything else the patient copied since is never read or touched). Where the clipboard cannot
 * be read, it is left alone. The clipboard is the web one; the app has no clipboard plugin.
 *
 * `copy` rejects when the write is refused, so the caller can say so; `clear` is also what runs
 * when the owner unmounts. Taking a copy off the clipboard does not remove it from a clipboard
 * history or a cross-device sync the system keeps: the warnings that say so stay.
 */
export function useClipboardClear() {
  const held = useRef<string | null>(null);
  const timer = useRef(0);

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    const text = held.current;
    held.current = null;
    if (!text) return;
    // A clipboard without a readable side throws here, before any promise: left alone too.
    try {
      void navigator.clipboard
        .readText()
        .then((now) =>
          now === text ? navigator.clipboard.writeText("") : undefined,
        )
        .catch(() => undefined);
    } catch {
      // Nothing to read, nothing cleared.
    }
  }, []);

  useEffect(() => clear, [clear]);

  const copy = useCallback(
    async (text: string) => {
      await navigator.clipboard.writeText(text);
      held.current = text;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(clear, CLIPBOARD_CLEAR_MS);
    },
    [clear],
  );

  return { copy, clear };
}
