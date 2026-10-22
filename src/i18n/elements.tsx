import { Fragment, type ReactNode } from "react";

/** Puts React elements, such as a styled label, where a translated text has
 * `{name}` placeholders that `t` left as written because they had no value.
 * The text around them stays plain text for React: nothing is read as HTML,
 * and a placeholder with no element here is left as written, so a gap is
 * visible rather than blank. Use it only on texts whose filled-in values are
 * the app's own (dates, counts): a value the patient typed that contained
 * `{name}` would be read as a placeholder here. */
export function withElements(
  text: string,
  elements: Record<string, ReactNode>,
): ReactNode {
  return text.split(/\{(\w+)\}/).map((part, index) => {
    // split() with a group puts each placeholder's name at an odd index.
    if (index % 2 === 0) return part;
    return (
      <Fragment key={index}>
        {Object.prototype.hasOwnProperty.call(elements, part)
          ? elements[part]
          : `{${part}}`}
      </Fragment>
    );
  });
}
