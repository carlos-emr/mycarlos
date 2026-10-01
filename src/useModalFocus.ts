import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'button, select, input, textarea, a[href], summary, [tabindex], [contenteditable="true"]';

// When one dialog replaces another, the first dialog's cleanup runs while the
// page behind it is still inert, so its opener cannot take focus and focus
// falls to <body>. Remember that opener so the replacing dialog can return to it.
let pendingOpener: HTMLElement | null = null;

export function useModalFocus(
  active: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  close: () => void,
  /** What takes the first focus; otherwise the first control that can. */
  initialFocus?: RefObject<HTMLElement | null>,
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
    const focusable = () => {
      const elements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
          [],
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility === "visible",
      );
      return elements;
    };
    const sameRadioGroup = (a: Element | null, b: Element) =>
      a instanceof HTMLInputElement &&
      b instanceof HTMLInputElement &&
      a.type === "radio" &&
      b.type === "radio" &&
      Boolean(a.name) &&
      a.name === b.name &&
      a.form === b.form;
    const edge = (elements: HTMLElement[], reverse: boolean) => {
      const end = elements[reverse ? elements.length - 1 : 0];
      return (
        elements.find(
          (element) =>
            sameRadioGroup(element, end) &&
            (element as HTMLInputElement).checked,
        ) ?? end
      );
    };
    const focusDialog = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      dialog.focus();
    };
    const firstFocus = initialFocus?.current ?? edge(focusable(), false);
    if (firstFocus) firstFocus.focus();
    else focusDialog();

    const containFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        focusDialog();
        return;
      }
      const first = edge(controls, false);
      const last = edge(controls, true);
      const current = document.activeElement;
      if (!controls.some((element) => element === current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (
        event.shiftKey &&
        (current === first || sameRadioGroup(current, first))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (current === last || sameRadioGroup(current, last))
      ) {
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
