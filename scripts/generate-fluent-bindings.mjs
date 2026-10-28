#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@fluent/syntax";

const root = path.resolve(import.meta.dirname, "..");
const catalogueDirectory = path.join(root, "src/i18n/locales/fluent");
const legacyKeysFile = path.join(catalogueDirectory, "message-keys.json");
const generatedTypeScript = path.join(catalogueDirectory, "keys.ts");
const generatedRust = path.join(root, "src-tauri/src/ui_text_ids.rs");
const locales = ["en", "es", "fr", "pl", "pt-BR", "zh-CN", "zh-TW"];

function sourceLine(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function variablesIn(value) {
  const variables = new Set();
  const visited = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (node.type === "VariableReference") {
      variables.add(node.id.name);
      return;
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(value);
  return [...variables].sort();
}

export function readCatalogue(locale, directory = catalogueDirectory) {
  const filename = path.join(directory, `${locale}.ftl`);
  const source = fs.readFileSync(filename, "utf8");
  if (/[\u202a-\u202e\u2066-\u2069]/u.test(source))
    throw new Error(`${locale}.ftl: literal bidi controls are not allowed`);
  const resource = parse(source);
  const entries = new Map();
  const messages = new Map();

  for (const entry of resource.body) {
    if (entry.type === "Junk") {
      const details = entry.annotations
        .map((annotation) => annotation.message)
        .join("; ");
      throw new Error(
        `${locale}.ftl:${sourceLine(source, entry.span.start)}: ${details || "invalid Fluent syntax"}`,
      );
    }
    if (entry.type !== "Message" && entry.type !== "Term") continue;

    const id = entry.type === "Term" ? `-${entry.id.name}` : entry.id.name;
    if (entries.has(id)) {
      throw new Error(`${locale}.ftl: duplicate Fluent entry "${id}"`);
    }
    const attributeNames = entry.attributes.map((a) => a.id.name);
    if (new Set(attributeNames).size !== attributeNames.length)
      throw new Error(`${locale}.ftl: duplicate attribute in ${id}`);
    const value = {
      kind: entry.type,
      variables: variablesIn([entry.value, entry.attributes]),
      hasValue: entry.value !== null,
      pattern: entry.value,
      references: [],
      attributes: entry.attributes.map((a) => a.id.name).sort(),
    };
    if (entry.type === "Message" && !entry.value)
      throw new Error(`${locale}.ftl: message "${id}" needs a value`);
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (node.type === "TermReference" || node.type === "MessageReference") {
        value.references.push({
          id: `${node.type === "TermReference" ? "-" : ""}${node.id.name}`,
          attribute: node.attribute?.name,
        });
      }
      if (node.type === "FunctionReference" && node.id.name !== "NUMBER")
        throw new Error(`${locale}.ftl: unsupported formatter ${node.id.name}`);
      if (
        node.type === "SelectExpression" &&
        node.selector.type === "VariableReference" &&
        node.selector.id.name === "count"
      ) {
        const allowed = new Set(
          new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
        );
        for (const v of node.variants)
          if (v.key.type === "Identifier" && !allowed.has(v.key.name))
            throw new Error(
              `${locale}.ftl: invalid plural category ${v.key.name}`,
            );
        if (!node.variants.some((v) => v.default && v.key.name === "other"))
          throw new Error(`${locale}.ftl: count selector needs default other`);
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === "object") visit(child);
      }
    };
    visit(entry);
    entries.set(id, value);
    if (entry.type === "Message") messages.set(id, value);
  }

  for (const [id, entry] of entries) {
    for (const reference of entry.references) {
      const target = entries.get(reference.id);
      if (
        !target ||
        (reference.attribute &&
          !target.attributes.includes(reference.attribute))
      )
        throw new Error(
          `${locale}.ftl: missing reference from ${id} to ${reference.id}`,
        );
    }
  }
  const active = new Set(),
    visited = new Set();
  const visitReference = (id) => {
    if (active.has(id))
      throw new Error(`${locale}.ftl: cyclic reference at ${id}`);
    if (visited.has(id)) return;
    active.add(id);
    for (const reference of entries.get(id).references)
      visitReference(reference.id);
    active.delete(id);
    visited.add(id);
  };
  for (const id of entries.keys()) visitReference(id);
  return { entries, messages };
}

export function compareCatalogues(source, translated, locale) {
  const missing = [...source.entries.keys()].filter(
    (id) => !translated.entries.has(id),
  );
  const extra = [...translated.entries.keys()].filter(
    (id) => !source.entries.has(id),
  );
  const wrongKinds = [...source.entries.keys()].filter(
    (id) =>
      translated.entries.has(id) &&
      (source.entries.get(id).kind !== translated.entries.get(id).kind ||
        source.entries.get(id).hasValue !==
          translated.entries.get(id).hasValue ||
        JSON.stringify(source.entries.get(id).attributes) !==
          JSON.stringify(translated.entries.get(id).attributes)),
  );
  const wrongVariables = [...source.entries.keys()]
    .filter((id) => translated.entries.has(id))
    .filter(
      (id) =>
        JSON.stringify(source.entries.get(id).variables) !==
        JSON.stringify(translated.entries.get(id).variables),
    )
    .map((id) => {
      const expected = source.entries.get(id).variables;
      const actual = translated.entries.get(id).variables;
      return `${id} (English: ${expected.join(", ") || "none"}; ${locale}: ${actual.join(", ") || "none"})`;
    });

  const failures = [];
  if (missing.length) failures.push(`missing IDs: ${missing.join(", ")}`);
  if (extra.length) failures.push(`extra IDs: ${extra.join(", ")}`);
  if (wrongKinds.length)
    failures.push(`message/term mismatches: ${wrongKinds.join(", ")}`);
  if (wrongVariables.length)
    failures.push(`variable mismatch: ${wrongVariables.join("; ")}`);
  if (failures.length)
    throw new Error(
      `${locale}.ftl does not match en.ftl: ${failures.join(" | ")}`,
    );
}

function rustVariant(id) {
  const parts = id
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1));
  if (!parts.length || !/^[A-Za-z]/.test(parts[0])) {
    throw new Error(`Cannot form a Rust enum variant from Fluent ID "${id}"`);
  }
  return parts.join("");
}

export function renderTypeScript(messageKeys, idByKey, source) {
  const tuple = messageKeys
    .map((key) => `  ${JSON.stringify(key)},`)
    .join("\n");
  const mappings = messageKeys
    .map(
      (key) => `  ${JSON.stringify(key)}: ${JSON.stringify(idByKey.get(key))},`,
    )
    .join("\n");
  const argumentEntries = messageKeys
    .map((key) => {
      const id = idByKey.get(key);
      const variables = source.messages.get(id).variables;
      const args = variables.length
        ? `{ ${variables.map((name) => `${JSON.stringify(name)}: FluentArgument`).join("; ")} }`
        : "undefined";
      return `  ${JSON.stringify(key)}: ${args};`;
    })
    .join("\n");

  return `/* Generated by scripts/generate-fluent-bindings.mjs. Do not edit. */
export const MESSAGE_KEYS = [
${tuple}
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

const FLUENT_IDS_BY_KEY = {
${mappings}
} as const satisfies Record<MessageKey, string>;
export const fluentId = (key: MessageKey) => FLUENT_IDS_BY_KEY[key];

const MESSAGE_KEY_SET: ReadonlySet<string> = new Set(MESSAGE_KEYS);
export function hasMessageKey(key: unknown): key is MessageKey {
  return typeof key === "string" && MESSAGE_KEY_SET.has(key);
}

export type FluentArgument = string | number | boolean;

/** Variables collected from each message and its attributes in en.ftl. */
export interface MessageArgsByKey {
${argumentEntries}
}

export type MessageArgs<K extends MessageKey> = MessageArgsByKey[K];
export type MessageArgsTuple<K extends MessageKey> = MessageArgs<K> extends undefined
  ? []
  : [args: MessageArgs<K>];
export type FluentTranslate = <K extends MessageKey>(
  id: K,
  ...args: MessageArgsTuple<K>
) => string;
`;
}

function renderRust(messageIds, idByKey, fallback) {
  const variants = messageIds.map((id) => `    ${rustVariant(id)},`).join("\n");
  const all = messageIds
    .map((id) => `        Self::${rustVariant(id)},`)
    .join("\n");
  const arms = messageIds
    .map((id) => {
      const arm = `            Self::${rustVariant(id)} => ${JSON.stringify(id)},`;
      return arm.length <= 100
        ? arm
        : `            Self::${rustVariant(id)} => {\n                ${JSON.stringify(id)}\n            }`;
    })
    .join("\n");
  const fromLegacyKeyArms = [...idByKey]
    .map(([key, id]) => {
      const arm = `            ${JSON.stringify(key)} => Some(Self::${rustVariant(id)}),`;
      return arm.length <= 100
        ? arm
        : `            ${JSON.stringify(key)} => {\n                Some(Self::${rustVariant(id)})\n            }`;
    })
    .join("\n");

  return `// Generated by scripts/generate-fluent-bindings.mjs. Do not edit.
pub const FORMATTING_FAILURE_EN: &str =
    ${JSON.stringify(fallback)};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MessageId {
${variants}
}

impl MessageId {
    pub const ALL: &'static [Self] = &[
${all}
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
${arms}
        }
    }

    pub fn from_legacy_key(key: &str) -> Option<Self> {
        match key {
${fromLegacyKeyArms}
            _ => None,
        }
    }
}
`;
}

export function writeOrCheck(filename, generated, checkOnly) {
  if (checkOnly) {
    if (
      !fs.existsSync(filename) ||
      fs.readFileSync(filename, "utf8") !== generated
    ) {
      throw new Error(
        `${path.relative(root, filename)} is stale; run npm run i18n:generate`,
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, generated);
}

/* CLI options are read only by main, so validator helpers can be tested directly. */
async function main() {
  const checkOnly = process.argv.slice(2).includes("--check");
  const unexpectedArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--check");

  if (unexpectedArguments.length) {
    throw new Error(`Unknown argument(s): ${unexpectedArguments.join(", ")}`);
  }

  const source = readCatalogue("en");
  const catalogues = new Map([["en", source]]);
  for (const locale of locales.slice(1)) {
    const catalogue = readCatalogue(locale);
    compareCatalogues(source, catalogue, locale);
    catalogues.set(locale, catalogue);
  }

  const messageIds = [...source.messages.keys()].sort();
  const variantOwners = new Map();
  for (const id of messageIds) {
    const variant = rustVariant(id);
    const previous = variantOwners.get(variant);
    if (previous)
      throw new Error(
        `Rust enum variant collision: "${previous}" and "${id}" -> ${variant}`,
      );
    variantOwners.set(variant, id);
  }

  const messageKeys = JSON.parse(fs.readFileSync(legacyKeysFile, "utf8"));
  if (
    !Array.isArray(messageKeys) ||
    messageKeys.some((key) => typeof key !== "string") ||
    new Set(messageKeys).size !== messageKeys.length
  ) {
    throw new Error("message-keys.json must contain unique string keys");
  }
  const idByKey = new Map(
    messageKeys.map((key) => [key, key.replaceAll(".", "-")]),
  );
  if (new Set(idByKey.values()).size !== messageKeys.length)
    throw new Error("Legacy keys must map to distinct Fluent IDs");
  const unmapped = messageKeys.filter(
    (key) => !source.messages.has(idByKey.get(key)),
  );
  const unkeyed = messageIds.filter(
    (id) => !messageKeys.some((key) => idByKey.get(key) === id),
  );
  if (unmapped.length || unkeyed.length) {
    throw new Error(
      `Legacy key mapping mismatch; unmapped: ${unmapped.join(", ") || "none"}; unkeyed Fluent IDs: ${unkeyed.join(", ") || "none"}`,
    );
  }

  const richKeys = ["recoveryKey.label", "security.recoveryKey.current"];
  const rich = {},
    fallback = {};
  for (const [locale, catalogue] of catalogues) {
    rich[locale] = {};
    for (const key of richKeys) {
      const pattern = catalogue.messages.get(idByKey.get(key)).pattern;
      rich[locale][key] = pattern.elements.map((element) => {
        if (element.type === "TextElement") return element.value;
        if (
          element.type === "Placeable" &&
          element.expression.type === "VariableReference"
        )
          return { slot: element.expression.id.name };
        throw new Error(
          `${locale}: rich message ${key} supports text and variable slots only`,
        );
      });
    }
    const pattern = catalogue.messages.get("language-error-formatting").pattern;
    if (pattern.elements.some((p) => p.type !== "TextElement"))
      throw new Error(`${locale}: formatting failure copy must be plain text`);
    fallback[locale] = pattern.elements.map((p) => p.value).join("");
  }
  writeOrCheck(
    path.join(catalogueDirectory, "rich-parts.json"),
    JSON.stringify(rich, null, 2) + "\n",
    checkOnly,
  );
  writeOrCheck(
    path.join(catalogueDirectory, "formatting-errors.json"),
    JSON.stringify(fallback, null, 2) + "\n",
    checkOnly,
  );
  writeOrCheck(
    generatedTypeScript,
    await (
      await import("prettier")
    ).format(renderTypeScript(messageKeys, idByKey, source), {
      parser: "typescript",
    }),
    checkOnly,
  );
  writeOrCheck(
    generatedRust,
    renderRust(messageIds, idByKey, fallback.en),
    checkOnly,
  );

  if (checkOnly)
    console.log("Fluent catalogue parity and generated bindings are current.");
  else
    console.log(
      `Generated typed bindings for ${messageIds.length} Fluent message IDs.`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
