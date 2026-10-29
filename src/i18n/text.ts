import { useState, useSyncExternalStore } from "react";
import { getLocale, subscribeLocale, t, type Params } from "./core";
import type { MessageKey } from "./locales";

/** Deferred app copy. Values remain separate from translation templates, so
 * braces in a patient's name or a file name are always ordinary text. */
export type UiText = string | { readonly render: () => string };
export const deferredText = (render: () => UiText): UiText => ({
  render: () => resolveText(render()),
});
export const resolveText = (value: UiText): string =>
  typeof value === "string" ? value : value.render();
export const message = (
  key: MessageKey,
  params?: Params | (() => Params),
): UiText =>
  deferredText(() => t(key, typeof params === "function" ? params() : params));
export const joinText = (...parts: (UiText | null | undefined)[]): UiText =>
  deferredText(() =>
    parts
      .map((part) => (part == null ? "" : resolveText(part)))
      .filter(Boolean)
      .join(" "),
  );

/** Keeps action results reactive without remounting their form or losing
 * typed secrets. Callers store descriptors, and render only the first item. */
export function useTextState(initial: UiText = "") {
  useSyncExternalStore(subscribeLocale, getLocale, getLocale);
  const [value, setValue] = useState<UiText>(initial);
  return [resolveText(value), setValue, value] as const;
}

/** A frontend refusal retains its message identity while a dialog is open. */
export class UiError extends Error {
  constructor(readonly uiText: UiText) {
    super(resolveText(uiText));
  }
}
