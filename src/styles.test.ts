import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

// Declarations of the form `selector { ... font-size: X ... }`, as pairs.
const fontSizes = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(
  ([, selector, body]) =>
    [...body.matchAll(/font-size:\s*([^;}\s]+)/g)].map(([, size]) => ({
      selector: selector.trim(),
      size,
    })),
);

describe("text sizes", () => {
  it("scale with the reader's zoom and text-size settings", () => {
    expect(fontSizes.length).toBeGreaterThan(0);
    // Pixel sizes ignore a larger default text size; rem sizes follow it.
    expect(fontSizes.filter(({ size }) => !size.endsWith("rem"))).toEqual([]);
  });

  it("are at least 14px at the default text size", () => {
    // The tick drawn inside a 19px checkbox is decoration, not text.
    const decorative = new Set([".check.checked::after"]);
    expect(
      fontSizes.filter(
        ({ selector, size }) =>
          !decorative.has(selector) &&
          parseFloat(size) * (size.endsWith("rem") ? 16 : 1) < 14,
      ),
    ).toEqual([]);
  });
});
