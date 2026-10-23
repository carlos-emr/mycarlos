import { useEffect, useRef, type RefObject } from "react";

const available = (element: Element) =>
  element.isConnected &&
  !element.matches(":disabled") &&
  !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
  element.getClientRects().length > 0 &&
  getComputedStyle(element).visibility === "visible";

/** Recover focus lost when a library action disables or removes its trigger.
 * Dialogs keep their own focus rules; deliberate focus elsewhere always wins. */
export function useLibraryFocus(
  root: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLElement | null>,
  blocked: boolean,
  location: string,
) {
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const remember = (event?: FocusEvent) => {
      const element = event?.target ?? document.activeElement;
      if (
        element instanceof HTMLElement &&
        root.current?.contains(element) &&
        available(element)
      )
        trigger.current = element;
    };
    remember();
    document.addEventListener("focusin", remember, true);
    return () => document.removeEventListener("focusin", remember, true);
  }, [root]);

  useEffect(() => {
    if (blocked) return;
    // Wait for disabled controls and modal cleanup to finish their commit.
    // Superseding navigation, a dialog, a lock or unmount cancels this frame.
    const frame = window.requestAnimationFrame(() => {
      const library = root.current;
      const focused = document.activeElement;
      if (
        !library ||
        !available(library) ||
        !document.hasFocus() ||
        (focused instanceof Element &&
          focused !== document.body &&
          focused !== document.documentElement &&
          available(focused)) ||
        Array.from(
          document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
        ).some(available)
      )
        return;
      const previous = trigger.current;
      const target =
        previous && library.contains(previous) && available(previous)
          ? previous
          : heading.current;
      if (target && library.contains(target) && available(target))
        target.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [root, heading, blocked, location]);
}
