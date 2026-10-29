import { readFileSync } from "node:fs";
import { FluentBundle, FluentResource } from "@fluent/bundle";
import { fluentId, type MessageKey } from "../../src/i18n/locales/fluent/keys";
import type { Locale } from "../../src/i18n/types";

const bundles = new Map<Locale, FluentBundle>();

// Only for assertions about spoken human copy. Keep raw announcement capture,
// input values, filenames and machine fields untouched.
export const visibleHumanText = (text: string): string =>
  text.replace(/[\u2068\u2069]/g, "");

// Playwright's runner is Node, outside Vite's ?raw module loader. Read the
// shipped resources here; the application still uses its production loader.
export function translate(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  let bundle = bundles.get(locale);
  if (!bundle) {
    bundle = new FluentBundle(locale);
    const source = readFileSync(
      new URL(`../../src/i18n/locales/fluent/${locale}.ftl`, import.meta.url),
      "utf8",
    );
    const errors = bundle.addResource(new FluentResource(source));
    if (errors.length) throw new Error(`Invalid test catalogue: ${locale}`);
    bundles.set(locale, bundle);
  }
  const message = bundle.getMessage(fluentId(key));
  if (!message?.value)
    throw new Error(`Missing test message: ${locale}/${key}`);
  const errors: Error[] = [];
  const text = bundle.formatPattern(message.value, params, errors);
  if (errors.length)
    throw new Error(`Cannot format test message: ${locale}/${key}`);
  return text;
}

// A description can combine several labelled hints. Match this exact message
// inside it, escaping all regex syntax in both catalogue copy and arguments.
export function messagePattern(...args: Parameters<typeof translate>): RegExp {
  return new RegExp(translate(...args).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
