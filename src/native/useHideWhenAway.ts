import { useEffect, useRef } from "react";

/**
 * Calls `hide` whenever the app may be about to leave the screen: its page is hidden, its window
 * loses the focus, its page is put away, or it is frozen. iOS and Android take the app switcher's
 * picture BEFORE `visibilitychange`, so a passphrase shown as text could be in that picture; blur,
 * pagehide and freeze come first. Only for hiding what is shown: never to clear what was typed
 * (switching to another window to copy a key must not lose it).
 */
export function useHideWhenAway(hide: () => void) {
  const latest = useRef(hide);
  useEffect(() => {
    latest.current = hide;
  });
  useEffect(() => {
    const away = () => latest.current();
    const whenHidden = () => {
      if (document.visibilityState === "hidden") away();
    };
    document.addEventListener("visibilitychange", whenHidden);
    document.addEventListener("freeze", away);
    window.addEventListener("pagehide", away);
    window.addEventListener("blur", away);
    return () => {
      document.removeEventListener("visibilitychange", whenHidden);
      document.removeEventListener("freeze", away);
      window.removeEventListener("pagehide", away);
      window.removeEventListener("blur", away);
    };
  }, []);
}
