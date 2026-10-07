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
    const available = (element: HTMLElement) =>
      !element.matches(":disabled") &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible";
    const focusable = () => {
      const elements = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
          [],
      ).filter((element) => element.tabIndex >= 0 && available(element));
      // A checked radio is its group's Tab stop. Filter the other members
      // in place so controls between radios keep their DOM order.
      return elements.filter(
        (element) =>
          !elements.some(
            (other) =>
              other !== element &&
              sameRadioGroup(element, other) &&
              (other as HTMLInputElement).checked,
          ),
      );
    };
    const sameRadioGroup = (a: Element | null, b: Element) =>
      a instanceof HTMLInputElement &&
      b instanceof HTMLInputElement &&
      a.type === "radio" &&
      b.type === "radio" &&
      Boolean(a.name) &&
      a.name === b.name &&
      a.form === b.form;
    const edge = (elements: HTMLElement[], reverse: boolean) =>
      elements[reverse ? elements.length - 1 : 0];
    const atBoundary = (
      current: Element | null,
      elements: HTMLElement[],
      reverse: boolean,
    ) => {
      const boundary = edge(elements, reverse);
      if (current === boundary) return true;
      if (!sameRadioGroup(current, boundary)) return false;
      const index = elements.findIndex((element) => element === current);
      // With no selection, browsers can enter at either end of a radio
      // group. Only treat contiguous members as the same boundary: an
      // intervening button must remain reachable.
      const between = reverse
        ? elements.slice(index)
        : elements.slice(0, index + 1);
      return between.every((element) => sameRadioGroup(element, boundary));
    };
    const focusDialog = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
      dialog.focus();
    };
    const requested = initialFocus?.current;
    // An explicitly supplied heading may have tabindex=-1. Keep that support,
    // but do not let a disabled or hidden initial control leave focus outside.
    const firstFocus =
      requested &&
      dialogRef.current?.contains(requested) &&
      available(requested)
        ? requested
        : edge(focusable(), false);
    firstFocus?.focus();
    if (!dialogRef.current?.contains(document.activeElement)) focusDialog();

    // A Tab that left the dialog all the same comes back to its far end, as
    // a wrap would.
    let leaving: "first" | "last" | null = null;
    let leavingTimer: number | undefined;
    const bringBack = () => {
      const end = edge(focusable(), leaving === "last");
      leaving = null;
      if (end) end.focus();
      else focusDialog();
    };
    // The Tab's own first move of the focus decides: no later, unrelated
    // move is pulled back.
    const keepInside = (event: FocusEvent) => {
      if (!leaving) return;
      if (
        event.target instanceof Node &&
        !dialogRef.current?.contains(event.target)
      )
        bringBack();
      else leaving = null;
    };

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
      } else if (event.shiftKey && atBoundary(current, controls, false)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && atBoundary(current, controls, true)) {
        event.preventDefault();
        first.focus();
      } else {
        // Left to the browser. Its order through a radio group with nothing
        // selected depends on which member had the focus before, so with a
        // control between members this Tab can still leave the dialog.
        leaving = event.shiftKey ? "last" : "first";
        window.clearTimeout(leavingTimer);
        leavingTimer = window.setTimeout(() => {
          // Out of the page, where no focusin comes.
          if (leaving && !dialogRef.current?.contains(document.activeElement))
            bringBack();
          leaving = null;
        });
      }
    };
    window.addEventListener("keydown", containFocus);
    document.addEventListener("focusin", keepInside, true);
    return () => {
      window.removeEventListener("keydown", containFocus);
      document.removeEventListener("focusin", keepInside, true);
      window.clearTimeout(leavingTimer);
      const opener = returnFocusRef.current;
      opener?.focus();
      pendingOpener =
        opener && document.activeElement !== opener ? opener : null;
    };
  }, [active, dialogRef]);
}
