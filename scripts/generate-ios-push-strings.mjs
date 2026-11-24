#!/usr/bin/env node
// The iPhone push notice's words (the push design, piece 4). The portal sends a localization key,
// never text; the phone looks the sentence up in myCarlos's own Localizable.strings, in its own
// language. This writes one Localizable.strings per language from the Fluent catalogue, and
// `--check` fails when a file is missing or stale, a key is missing or extra, or a placeholder does
// not match the message's variables. No Rust, no Xcode: node only.
import fs from "node:fs";
import path from "node:path";
import { readCatalogue } from "./generate-fluent-bindings.mjs";

const root = path.resolve(import.meta.dirname, "..");
const defaultManifest = path.join(root, "src-tauri/ios-push/strings.json");
const defaultResources = path.join(root, "src-tauri/ios-push/Resources");

export function readManifest(file = defaultManifest) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const keys = manifest.strings.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length)
    throw new Error("strings.json repeats a key");
  for (const key of keys)
    if (!/^[A-Z][A-Z0-9_]*$/.test(key))
      throw new Error(`strings.json: "${key}" is not an UPPER_SNAKE key`);
  return manifest;
}

/** The plain text of a Fluent pattern; each variable becomes its positional `%N$@`. */
export function renderValue(pattern, variables, where) {
  let out = "";
  for (const element of pattern.elements) {
    if (element.type === "TextElement") {
      out += element.value;
    } else if (
      element.type === "Placeable" &&
      element.expression.type === "VariableReference"
    ) {
      const index = variables.indexOf(element.expression.id.name);
      if (index < 0)
        throw new Error(
          `${where}: placeholder $${element.expression.id.name} is not listed in strings.json`,
        );
      out += `%${index + 1}$@`;
    } else {
      throw new Error(
        `${where}: only text and variables are allowed in a push sentence`,
      );
    }
  }
  return out;
}

function escapeValue(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

export function renderFile(entries) {
  const body = entries
    .map(({ key, value }) => `"${key}" = "${escapeValue(value)}";`)
    .join("\n");
  return `/* Generated from src/i18n/locales/fluent by scripts/generate-ios-push-strings.mjs. Do not edit. */\n${body}\n`;
}

/** What each locale's file must contain, from the catalogue. */
export function expectedFiles(manifest, catalogueDirectory) {
  const files = new Map();
  for (const [locale, lproj] of Object.entries(manifest.locales)) {
    const catalogue = readCatalogue(locale, catalogueDirectory);
    const entries = manifest.strings.map((entry) => {
      const message = catalogue.messages.get(entry.fluent);
      const where = `${locale}.ftl ${entry.fluent}`;
      if (!message) throw new Error(`${where}: message is missing`);
      if (message.attributes.length)
        throw new Error(`${where}: a push sentence takes no attributes`);
      if (
        JSON.stringify([...message.variables].sort()) !==
        JSON.stringify([...entry.variables].sort())
      )
        throw new Error(
          `${where}: variables [${message.variables}] do not match strings.json [${entry.variables}]`,
        );
      return {
        key: entry.key,
        value: renderValue(message.pattern, entry.variables, where),
      };
    });
    files.set(`${lproj}.lproj/Localizable.strings`, renderFile(entries));
  }
  return files;
}

/** The `"KEY" = "value";` pairs of a strings file (this tool's own escapes only). */
export function parseStrings(text) {
  const pairs = new Map();
  const unescape = (value) =>
    value.replace(/\\(.)/g, (_m, c) => (c === "n" ? "\n" : c));
  for (const match of text.matchAll(/^"([^"]+)" = "((?:[^"\\]|\\.)*)";$/gm)) {
    if (pairs.has(match[1])) throw new Error(`repeated key ${match[1]}`);
    pairs.set(match[1], unescape(match[2]));
  }
  return pairs;
}

/** Problems in the files on disk: [] when they are what the catalogue says they should be. */
export function problems(manifest, catalogueDirectory, resources) {
  const found = [];
  const wanted = new Map(manifest.strings.map((entry) => [entry.key, entry]));
  for (const [relative, generated] of expectedFiles(
    manifest,
    catalogueDirectory,
  )) {
    const file = path.join(resources, relative);
    if (!fs.existsSync(file)) {
      found.push(`${relative} is missing`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    let pairs;
    try {
      pairs = parseStrings(text);
    } catch (error) {
      found.push(`${relative}: ${error.message}`);
      continue;
    }
    const before = found.length;
    for (const key of wanted.keys())
      if (!pairs.has(key)) found.push(`${relative}: key ${key} is missing`);
    for (const key of pairs.keys())
      if (!wanted.has(key)) found.push(`${relative}: extra key ${key}`);
    for (const [key, entry] of wanted) {
      const value = pairs.get(key);
      if (value === undefined) continue;
      const placeholders = [...value.matchAll(/%(\d+)\$@/g)].map((m) =>
        Number(m[1]),
      );
      const want = entry.variables.map((_name, index) => index + 1);
      if (
        JSON.stringify([...placeholders].sort()) !== JSON.stringify(want) ||
        /%(?!\d+\$@)/.test(value)
      )
        found.push(
          `${relative}: ${key} has placeholders [${placeholders}], strings.json lists ${entry.variables.length}`,
        );
    }
    if (text !== generated && found.length === before)
      found.push(`${relative} is stale; run npm run ios-push:strings`);
  }
  return found;
}

function main() {
  const check = process.argv.includes("--check");
  const unknown = process.argv.slice(2).filter((a) => a !== "--check");
  if (unknown.length)
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  const manifest = readManifest();
  const catalogueDirectory = path.join(root, "src/i18n/locales/fluent");
  if (check) {
    const found = problems(manifest, catalogueDirectory, defaultResources);
    if (found.length) {
      console.error(found.join("\n"));
      process.exit(1);
    }
    console.log(
      `iOS push strings: ${manifest.strings.length} key(s) in ${Object.keys(manifest.locales).length} languages are current`,
    );
    return;
  }
  for (const [relative, text] of expectedFiles(manifest, catalogueDirectory)) {
    const file = path.join(defaultResources, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
