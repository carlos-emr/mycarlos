// Builds myCarlos's third-party notices from the locked CycloneDX inventories (npm and Cargo).
//
// For each shipped component: name, version, SPDX licence, and the licence / notice texts the
// licence requires to travel with the software (MIT, BSD, ISC, Apache-2.0 and its NOTICE files,
// MPL-2.0, ...), read from the package itself. The build FAILS, rather than guessing, when:
//   - a component has no licence, or one this file cannot read;
//   - a licence is outside the allow-list (a GPL-family, AGPL or other copyleft one is named for
//     the maintainer to decide, not accepted silently);
//   - a licence that requires its text has none in the package and none in the reviewed overrides.
//
// The pure functions are exported for tests; scripts/generate-third-party-notices.mjs is the
// command line that reads the inventories and the packages.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Licences that may ship, and whether the licence obliges the text (and copyright line) to
 * accompany the software. Anything not listed fails the build. */
export const ALLOWED = new Map([
  ["MIT", true],
  ["MIT-0", false],
  ["Apache-2.0", true],
  ["BSD-2-Clause", true],
  ["BSD-3-Clause", true],
  ["ISC", true],
  ["0BSD", false],
  ["Zlib", true],
  ["Unicode-3.0", true],
  ["Unicode-DFS-2016", true],
  ["CC0-1.0", false],
  ["Unlicense", false],
  ["MPL-2.0", true],
  ["BSL-1.0", true],
  ["BlueOak-1.0.0", true],
  ["CC-BY-3.0", true],
  ["CC-BY-4.0", true],
  ["Python-2.0", true],
  ["WTFPL", false],
  ["OpenSSL", true],
  ["Apache-2.0 WITH LLVM-exception", true],
  ["CDLA-Permissive-2.0", true],
  ["LicenseRef-PublicDomain", false],
]);

/** Copyleft or otherwise unreviewed licences: named in the failure so Ben decides. */
const NEEDS_DECISION =
  /(^|[^A-Za-z])(A?GPL|LGPL|SSPL|EUPL|CPAL|OSL|CC-BY-NC|CC-BY-SA)/;

/** Splits an SPDX expression into its tokens. Old crate metadata uses "/" for OR. */
function tokens(expression) {
  return expression
    .replace(/\//g, " OR ")
    .replace(/([()])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * The licences that apply to a component under an SPDX expression, choosing among "OR"s the
 * first alternative whose every licence is allowed (listed first = preferred). Returns
 * `{ ids, problems }`: `ids` are the SPDX ids that apply, `problems` why the expression was
 * refused.
 */
export function resolveExpression(expression) {
  const toks = tokens(expression);
  let at = 0;
  const peek = () => toks[at];
  const eat = () => toks[at++];
  // A node is { options: [ { ids: [...], bad: [...] } ] } (the alternatives of an OR).
  const parseOr = () => {
    let options = parseAnd();
    while (peek() === "OR") {
      eat();
      options = options.concat(parseAnd());
    }
    return options;
  };
  const parseAnd = () => {
    let options = parseAtom();
    while (peek() === "AND") {
      eat();
      const right = parseAtom();
      const combined = [];
      for (const left of options)
        for (const r of right)
          combined.push({
            ids: [...left.ids, ...r.ids],
            bad: [...left.bad, ...r.bad],
          });
      options = combined;
    }
    return options;
  };
  const parseAtom = () => {
    const token = eat();
    if (token === undefined) throw new Error("unexpected end");
    if (token === "(") {
      const inner = parseOr();
      if (eat() !== ")") throw new Error("missing )");
      return inner;
    }
    if (token === ")" || token === "OR" || token === "AND" || token === "WITH")
      throw new Error(`unexpected ${token}`);
    let id = token.replace(/\+$/, "");
    if (peek() === "WITH") {
      eat();
      id = `${id} WITH ${eat()}`;
    }
    return [{ ids: [id], bad: ALLOWED.has(id) ? [] : [id] }];
  };
  let options;
  try {
    options = parseOr();
    if (at !== toks.length) throw new Error(`unexpected ${toks[at]}`);
  } catch (error) {
    return {
      ids: [],
      problems: [
        `unreadable licence expression "${expression}" (${error.message})`,
      ],
    };
  }
  const goods = options.filter((option) => option.bad.length === 0);
  if (goods.length > 0) {
    return {
      ids: [...new Set(goods[0].ids)],
      problems: [],
      // Every acceptable way to read the expression, for choosing which text to show.
      alternatives: goods.map((option) => [...new Set(option.ids)]),
    };
  }
  const bad = [...new Set(options.flatMap((option) => option.bad))];
  const copyleft = bad.filter((id) => NEEDS_DECISION.test(id));
  return {
    ids: [],
    problems: [
      copyleft.length > 0
        ? `needs a maintainer decision (copyleft): ${copyleft.join(", ")} in "${expression}"`
        : `licence outside the allow-list: ${bad.join(", ")} in "${expression}"`,
    ],
  };
}

/** The SPDX expression a CycloneDX component declares, or null. */
export function declaredExpression(component) {
  const parts = [];
  for (const entry of component.licenses ?? []) {
    if (entry.expression) parts.push(`(${entry.expression})`);
    else if (entry.license?.id) parts.push(entry.license.id);
    else if (entry.license?.name) parts.push(entry.license.name);
  }
  if (parts.length === 0) return null;
  return parts.length === 1
    ? parts[0].replace(/^\((.*)\)$/, "$1")
    : parts.join(" AND ");
}

const LICENCE_FILE =
  /^(licen[cs]e|licen[cs]e[-_.].*|copying|copying[-_.].*|unlicen[cs]e|notice|notice[-_.].*|copyright|copyright[-_.].*)(\.(md|txt|markdown))?$/i;

/** The licence and notice files at the top of a package directory, in name order. */
export function licenceFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  const found = [];
  for (const name of readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    if (!LICENCE_FILE.test(name)) continue;
    if (!statSync(full).isFile()) continue;
    found.push({
      name,
      text: readFileSync(full, "utf8").replace(/\r\n/g, "\n").trim(),
    });
  }
  return found.filter((file) => file.text.length > 0);
}

/**
 * One SHA-256 over what decides the generated file besides the lock files: the generator itself
 * and everything under scripts/notices (the standard texts, the extra components, the overrides),
 * so a change to any of them makes the committed file stale too.
 */
export function hashGeneratorInputs(root) {
  const files = [
    "scripts/third-party-notices.mjs",
    "scripts/generate-third-party-notices.mjs",
  ];
  const walk = (directory) => {
    for (const entry of readdirSync(path.join(root, directory), {
      withFileTypes: true,
    }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else files.push(relative);
    }
  };
  walk("scripts/notices");
  const hash = createHash("sha256");
  for (const file of files) {
    hash
      .update(`${file}\0`)
      .update(readFileSync(path.join(root, file)))
      .update("\0");
  }
  return hash.digest("hex");
}

/** The SHA-256 of a file, as a hex string. */
export function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** `{repository: url}` for an entry: the package's own source address, cleaned for display. */
function repositoryField(component, fallback) {
  const vcs = (component.externalReferences ?? []).find(
    (reference) => reference.type === "vcs",
  )?.url;
  const url = (vcs ?? fallback ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git:\/\//, "https://");
  return /^https:\/\//.test(url) ? { repository: url } : {};
}

/** Licences whose standard text needs no copyright holder's name. */
const HOLDERLESS = new Set([
  "Apache-2.0",
  "MPL-2.0",
  "Apache-2.0 WITH LLVM-exception",
]);

/**
 * The standard text for a package with no licence file: of the acceptable ways to read its
 * expression, the first that needs no holder's name, else the first whose standard text and holder
 * are available. Returns [] when there is none.
 */
export function standardFiles({ alternatives, standardTexts, origin, name }) {
  const holder =
    origin.holders.length > 0
      ? origin.holders
          .map((entry) => entry.replace(/\s*<[^>]*>/, ""))
          .join(", ")
      : origin.repository
        ? `The ${name} authors (${origin.repository})`
        : null;
  const usable = (ids) =>
    ids.every(
      (id) => standardTexts[id] !== undefined && (HOLDERLESS.has(id) || holder),
    );
  const choice =
    alternatives.find(
      (ids) => usable(ids) && ids.every((id) => HOLDERLESS.has(id)),
    ) ?? alternatives.find(usable);
  if (!choice) return [];
  return choice
    .filter((id) => ALLOWED.get(id))
    .map((id) => ({
      name: `${id} (standard text; the package ships no licence file)`,
      text: standardTexts[id].replaceAll("{holder}", holder ?? "").trim(),
    }));
}

const textId = (text) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

/**
 * Builds the notices document.
 *
 * @param {object} input
 * @param {Array<{ecosystem:"npm"|"cargo", sbom:object}>} input.inventories CycloneDX documents
 * @param {(ecosystem:string, component:object) => string|null} input.directoryOf where a
 *   component's package files are
 * @param {Array<object>} input.extra components not in an inventory (llama.cpp, ggml, fonts, ...):
 *   `{name, version, license, source, texts:[{name,text}]}`
 * @param {Record<string, Array<{name:string,text:string}>>} input.overrides reviewed licence texts
 *   for a package whose own files have none, keyed "name@version" or "name"
 * @param {string[]} input.selfNames package names that are myCarlos itself (not third-party)
 * @param {Record<string,string>} input.standardTexts the standard text of a licence, with
 *   `{holder}` where its copyright line goes, for a package that ships no licence file
 * @param {(ecosystem:string, component:object) => {holders:string[], repository:string|null}} input.originOf
 *   who holds the copyright, from the package's own metadata
 * @param {(ecosystem:string, component:object) => string|null|undefined} input.installedVersionOf
 *   the version actually installed whose texts are read (undefined: not checked); a different one
 *   than the inventory's fails, so a text is never taken from another version
 * @param {Record<string,string>} input.inputs hashes of the locked inputs the file was made from,
 *   so a test can tell when a lock file has moved on without it
 */
export function buildNotices({
  inventories,
  directoryOf,
  extra = [],
  overrides = {},
  selfNames = [],
  standardTexts = {},
  originOf = () => ({ holders: [], repository: null }),
  installedVersionOf = () => undefined,
  inputs = {},
}) {
  const problems = [];
  const texts = new Map();
  const components = new Map();
  const intern = (file) => {
    const id = textId(file.text);
    texts.set(id, file.text);
    return { id, name: file.name };
  };
  const add = (entry) => {
    const key = `${entry.ecosystem}:${entry.name}@${entry.version}`;
    if (!components.has(key)) components.set(key, entry);
  };

  for (const { ecosystem, sbom } of inventories) {
    for (const component of sbom.components ?? []) {
      const name = component.group
        ? `${component.group}/${component.name}`
        : component.name;
      if (selfNames.includes(name)) continue;
      // A frontend dev dependency (a test runner, a compiler) is not in the app.
      if (
        (component.properties ?? []).some(
          (property) =>
            property.name === "cdx:npm:package:development" &&
            property.value === "true",
        )
      )
        continue;
      const label = `${ecosystem} ${name}@${component.version}`;
      const declared = declaredExpression(component);
      if (!declared) {
        problems.push(`${label}: no licence declared`);
        continue;
      }
      const { ids, problems: licenceProblems } = resolveExpression(declared);
      if (licenceProblems.length > 0) {
        for (const message of licenceProblems)
          problems.push(`${label}: ${message}`);
        continue;
      }
      const installed = installedVersionOf(ecosystem, component);
      if (installed !== undefined && installed !== component.version) {
        problems.push(
          `${label}: the inventory says ${component.version} but ${installed ?? "nothing"} is installed, so its texts would be another version's (reinstall, then regenerate the inventory)`,
        );
        continue;
      }
      const needsText = ids.some((id) => ALLOWED.get(id));
      let files = licenceFiles(directoryOf(ecosystem, component));
      // A NOTICE file is not the licence: Apache-2.0 and the rest still need their own text.
      const hasLicence = () =>
        files.some((file) => !/^notice/i.test(file.name));
      if (needsText && !hasLicence()) {
        files = [
          ...files,
          ...(overrides[`${name}@${component.version}`] ??
            overrides[name] ??
            []),
        ];
      }
      let standard = false;
      if (needsText && !hasLicence()) {
        // Many crates publish no licence file. The licence's standard text is shown instead, with
        // the copyright line made from the package's own metadata, and said to be so.
        const filled = standardFiles({
          alternatives: resolveExpression(declared).alternatives,
          standardTexts,
          origin: originOf(ecosystem, component),
          name,
        });
        files = [...files, ...filled];
        standard = filled.length > 0;
      }
      if (needsText && !hasLicence()) {
        problems.push(
          `${label}: licence ${ids.join(" + ")} requires its text, and the package has none (add a reviewed override)`,
        );
        continue;
      }
      add({
        ecosystem,
        name,
        version: component.version,
        license: declared,
        applied: ids,
        ...repositoryField(
          component,
          originOf(ecosystem, component).repository,
        ),
        ...(standard ? { standardText: true } : {}),
        texts: files.map(intern),
      });
    }
  }

  for (const component of extra) {
    const label = `bundled ${component.name}@${component.version}`;
    const { ids, problems: licenceProblems } = resolveExpression(
      component.license,
    );
    if (licenceProblems.length > 0) {
      for (const message of licenceProblems)
        problems.push(`${label}: ${message}`);
      continue;
    }
    if (
      ids.some((id) => ALLOWED.get(id)) &&
      (component.texts ?? []).length === 0
    ) {
      problems.push(`${label}: licence requires its text and none was given`);
      continue;
    }
    add({
      ecosystem: "bundled",
      name: component.name,
      version: component.version,
      license: component.license,
      applied: ids,
      source: component.source,
      texts: (component.texts ?? []).map(intern),
    });
  }

  if (problems.length > 0) return { problems, document: null };

  const sorted = [...components.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en") ||
      a.version.localeCompare(b.version, "en", { numeric: true }) ||
      a.ecosystem.localeCompare(b.ecosystem),
  );
  const orderedTexts = Object.fromEntries(
    [...texts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return {
    problems: [],
    document: { schema: 1, inputs, components: sorted, texts: orderedTexts },
  };
}

/** The document as the file's bytes: one component per line so a diff reads, stable order. */
export function serialize(document) {
  const lines = [
    "{",
    `  "schema": ${document.schema},`,
    `  "inputs": ${JSON.stringify(document.inputs)},`,
    '  "components": [',
    document.components
      .map((component) => `    ${JSON.stringify(component)}`)
      .join(",\n"),
    "  ],",
    '  "texts": {',
    Object.entries(document.texts)
      .map(([id, text]) => `    ${JSON.stringify(id)}: ${JSON.stringify(text)}`)
      .join(",\n"),
    "  }",
    "}",
    "",
  ];
  return lines.join("\n");
}
