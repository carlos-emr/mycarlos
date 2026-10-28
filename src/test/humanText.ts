import {
  computeAccessibleDescription,
  computeAccessibleName,
} from "dom-accessibility-api";
import { expect } from "vitest";

/** For assertions about human-readable copy only. This deliberately removes
 * only Fluent's FSI/PDI delimiters. Raw keys, filenames and typed values use
 * exact assertions; i18n tests separately require isolation for RTL arguments. */
export const visibleText = (value: string) =>
  value.replace(/[\u2068\u2069]/g, "");
export const humanText = (expected: string | RegExp) => (actual: string) =>
  expected instanceof RegExp
    ? new RegExp(expected.source, expected.flags).test(visibleText(actual))
    : visibleText(actual) === visibleText(expected);

/** Preserve non-text fields when comparing a result that contains human copy. */
export function humanValue<T>(value: T): T {
  if (typeof value === "string") return visibleText(value) as T;
  if (Array.isArray(value)) return value.map(humanValue) as T;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, humanValue(child)]),
    ) as T;
  return value;
}

type HumanExpected =
  | string
  | RegExp
  | { asymmetricMatch(actual: unknown): boolean };

function result(actual: string, expected: HumanExpected, contains = false) {
  const visible = visibleText(actual);
  const pass =
    typeof expected === "object" && "asymmetricMatch" in expected
      ? expected.asymmetricMatch(visible)
      : expected instanceof RegExp
        ? new RegExp(expected.source, expected.flags).test(visible)
        : contains
          ? visible.includes(visibleText(expected))
          : visible === visibleText(expected);
  return {
    pass,
    message: () =>
      `Expected human text ${JSON.stringify(visible)} to ${contains ? "contain" : "match"} ${String(expected)}`,
  };
}
expect.extend({
  toHaveHumanTextContent(received: Node, expected: HumanExpected) {
    return result(
      (received.textContent ?? "").replace(/\s+/g, " ").trim(),
      expected,
      true,
    );
  },
  toHaveHumanAccessibleName(received: Element, expected: HumanExpected) {
    return result(computeAccessibleName(received), expected);
  },
  toHaveHumanAccessibleDescription(received: Element, expected: HumanExpected) {
    return result(computeAccessibleDescription(received), expected);
  },
});
declare module "vitest" {
  interface Assertion<T = any> {
    toHaveHumanTextContent(expected: HumanExpected): T;
    toHaveHumanAccessibleName(expected: HumanExpected): T;
    toHaveHumanAccessibleDescription(expected: HumanExpected): T;
  }
}
