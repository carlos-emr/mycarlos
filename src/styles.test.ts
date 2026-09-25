import { describe, expect, it } from "vitest";
import css from "./styles.css?raw";

const declarations = (property: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector, body]) =>
    [...body.matchAll(new RegExp(`(?:^|[;\\s])${property}:([^;}]+)`, "g"))].map(
      ([, value]) => ({ selector: selector.trim(), value: value.trim() }),
    ),
  );
const fontSizes = declarations("font-size");

describe("text sizes", () => {
  it("are plain rem values, so zoom and the root text size scale them", () => {
    expect(fontSizes.length).toBeGreaterThan(0);
    expect(
      fontSizes.filter(({ value }) => !/^\d*\.?\d+rem$/.test(value)),
    ).toEqual([]);
  });

  it("are not set through the font shorthand", () => {
    const fonts = declarations("font");
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter(({ value }) => value !== "inherit")).toEqual([]);
  });

  it("move to the narrower layout sooner when larger, via em breakpoints", () => {
    const widths = [...css.matchAll(/@media[^{]*width:\s*([^)\s]+)/g)].map(
      ([, width]) => width,
    );
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.filter((width) => !width.endsWith("em"))).toEqual([]);
  });

  it("are at least 14px at the default text size", () => {
    const decorative = new Set([".check.checked::after"]);
    expect(
      fontSizes.filter(
        ({ selector, value }) =>
          !decorative.has(selector) && parseFloat(value) * 16 < 14,
      ),
    ).toEqual([]);
  });
});
