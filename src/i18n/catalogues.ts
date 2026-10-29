import { FluentBundle, FluentResource } from "@fluent/bundle";
import en from "./locales/fluent/en.ftl?raw";
import es from "./locales/fluent/es.ftl?raw";
import fr from "./locales/fluent/fr.ftl?raw";
import pl from "./locales/fluent/pl.ftl?raw";
import ptBR from "./locales/fluent/pt-BR.ftl?raw";
import zhCN from "./locales/fluent/zh-CN.ftl?raw";
import zhTW from "./locales/fluent/zh-TW.ftl?raw";
import type { Locale } from "./types";
import { MESSAGE_KEYS, fluentId } from "./locales/fluent/keys";
import formattingErrors from "./locales/fluent/formatting-errors.json" with { type: "json" };

export const formattingFailure = (locale: Locale): string =>
  Object.prototype.hasOwnProperty.call(formattingErrors, locale)
    ? formattingErrors[locale]
    : formattingErrors.en;

export const CATALOGUE_SOURCES: Record<Locale, string> = {
  en,
  es,
  fr,
  pl,
  "pt-BR": ptBR,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

const bundles = new Map<string, FluentBundle>();

export function fluentBundle(
  locale: Locale,
  useIsolating = true,
): FluentBundle {
  const cacheKey = `${locale}/${useIsolating}`;
  const cached = bundles.get(cacheKey);
  if (cached) return cached;

  const bundle = new FluentBundle([locale], { useIsolating });
  const errors = bundle.addResource(
    new FluentResource(CATALOGUE_SOURCES[locale]),
  );
  if (errors.length)
    throw new Error(
      `Invalid Fluent resource for ${locale}: ${errors.join("; ")}`,
    );
  for (const key of MESSAGE_KEYS) {
    if (!bundle.getMessage(fluentId(key))?.value)
      throw new Error(`Missing bundled message: ${locale}/${key}`);
  }
  bundles.set(cacheKey, bundle);
  return bundle;
}
