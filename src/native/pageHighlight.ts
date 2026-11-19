/**
 * The quoted words' boxes on a page picture, for "Show in document" (#292).
 *
 * The PDF helper decides where the words are, exactly or not at all
 * (native `page_boxes`); this only checks what comes back and draws it. A
 * box is a fraction of the picture, so it stays on the words at every zoom,
 * Fit width and screen density: the picture is the page at one scale.
 */
import type { PageBoxes } from "../vault";

export type Box = [left: number, top: number, right: number, bottom: number];

/** The most boxes one quote may take (native `page_boxes::MAX_LINES`). */
export const MAX_BOXES = 256;

/** The boxes to draw: all of them, or none when any is not a box on the
 * picture. A part of a quote is never drawn as if it were all of it. */
export function boxesToDraw(answer: PageBoxes | null | undefined): Box[] {
  const rects = answer?.rects;
  if (!Array.isArray(rects) || rects.length === 0 || rects.length > MAX_BOXES)
    return [];
  const fraction = (value: unknown) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
  const valid = rects.every(
    (rect) =>
      Array.isArray(rect) &&
      rect.length === 4 &&
      rect.every(fraction) &&
      rect[0] < rect[2] &&
      rect[1] < rect[3],
  );
  return valid ? rects.map((rect) => [...rect] as Box) : [];
}

/** Where a box sits over the picture, in percent of it. */
export function boxStyle([left, top, right, bottom]: Box) {
  const percent = (value: number) => `${(value * 100).toFixed(4)}%`;
  return {
    left: percent(left),
    top: percent(top),
    width: percent(right - left),
    height: percent(bottom - top),
  };
}

/** Scrolls `scroller` itself so that `target` is in the middle of it, as far
 * as it can scroll. Nothing else moves: not the dialog, not the window. */
export function centreIn(scroller: HTMLElement, target: HTMLElement) {
  const outer = scroller.getBoundingClientRect();
  const inner = target.getBoundingClientRect();
  scroller.scrollTop +=
    inner.top + inner.height / 2 - (outer.top + outer.height / 2);
  scroller.scrollLeft +=
    inner.left + inner.width / 2 - (outer.left + outer.width / 2);
}
