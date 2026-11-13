import { Fragment, type ReactNode } from "react";
import { getLocale, type Params } from "./core";
import { formattingFailure } from "./catalogues";
import richParts from "./locales/fluent/rich-parts.json" with { type: "json" };

export type RichMessageKey = keyof typeof richParts.en;

/** Generated trusted catalogue slots are separate from argument text. Values
 * containing braces or slot names can never become React element placeholders. */
export function withElements(
  key: RichMessageKey,
  elements: Record<string, ReactNode>,
  params: Params = {},
): ReactNode {
  const locale = getLocale();
  const parts = Object.prototype.hasOwnProperty.call(richParts[locale], key)
    ? richParts[locale][key]
    : undefined;
  const has = (object: object, name: string) =>
    Object.prototype.hasOwnProperty.call(object, name);
  if (
    !parts ||
    parts.some(
      (part) =>
        typeof part !== "string" &&
        (!has(elements, part.slot) || elements[part.slot] == null) &&
        (!has(params, part.slot) || params[part.slot] == null),
    )
  ) {
    return formattingFailure(locale);
  }
  return parts.map((part, index) => {
    if (typeof part === "string") return part;
    return (
      <Fragment key={index}>
        {has(elements, part.slot) ? (
          elements[part.slot]
        ) : (
          <bdi>{String(params[part.slot])}</bdi>
        )}
      </Fragment>
    );
  });
}
