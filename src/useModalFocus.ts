import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

// When one dialog replaces another, the first dialog's cleanup runs while the
// page behind it is still inert, so its opener cannot take focus and focus
// falls to <body>. Remember that opener so the replacing dialog can return to it.
let pendingOpener: HTMLElement | null = null;

export function useModalFocus(
  active: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  closeRef.current = close;

  useEffect(() => {
    if (!active) return;
    const focused = document.activeElement;
    returnFocusRef.current =
      focused instanceof HTMLElement && focused !== document.body
        ? focused
        : pendingOpener;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
          [],
      );
    focusable()[0]?.focus();

    const containFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", containFocus);
    return () => {
      window.removeEventListener("keydown", containFocus);
      const opener = returnFocusRef.current;
      opener?.focus();
      pendingOpener =
        opener && document.activeElement !== opener ? opener : null;
    };
  }, [active, dialogRef]);
}
