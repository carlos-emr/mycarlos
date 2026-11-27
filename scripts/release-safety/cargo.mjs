// Cargo features and build commands, read properly (no regex over the whole file): a small TOML
// reader for the subset Cargo.toml uses, the feature graph resolved from `default`, and shell-ish
// tokenising of the commands a release is built with. Anything it cannot parse throws, and the
// gate reports that as a finding (it fails closed).

/** Cargo features that must not be compiled into a store build. */
export const FORBIDDEN_FEATURES = [
  "ai-helper-stub",
  "cloud-ai",
  "cloud_ai",
  "devtools",
];

// ---- TOML (the subset of Cargo.toml) ----

class Reader {
  constructor(text) {
    this.text = text;
    this.at = 0;
  }
  done() {
    return this.at >= this.text.length;
  }
  peek() {
    return this.text[this.at];
  }
  // Spaces, tabs and comments (not newlines).
  skipInline() {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r") this.at++;
      else if (c === "#")
        while (!this.done() && this.peek() !== "\n") this.at++;
      else return;
    }
  }
  // Everything blank, comments and newlines (inside arrays).
  skipAll() {
    for (;;) {
      this.skipInline();
      if (this.peek() === "\n") this.at++;
      else return;
    }
  }
  fail(why) {
    throw new Error(`TOML: ${why} at offset ${this.at}`);
  }
  string() {
    const quote = this.peek();
    if (this.text.startsWith(quote.repeat(3), this.at)) {
      const end = this.text.indexOf(quote.repeat(3), this.at + 3);
      if (end < 0) this.fail("unterminated multi-line string");
      const value = this.text.slice(this.at + 3, end);
      this.at = end + 3;
      return value.replace(/^\n/, "");
    }
    this.at++;
    let value = "";
    for (;;) {
      if (this.done()) this.fail("unterminated string");
      const c = this.text[this.at++];
      if (c === quote) return value;
      if (c === "\n") this.fail("newline in string");
      if (quote === '"' && c === "\\") {
        const next = this.text[this.at++];
        value +=
          { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[next] ?? next;
      } else value += c;
    }
  }
  key() {
    const parts = [];
    for (;;) {
      this.skipInline();
      const c = this.peek();
      if (c === '"' || c === "'") parts.push(this.string());
      else {
        const start = this.at;
        while (/[A-Za-z0-9_-]/.test(this.peek() ?? "")) this.at++;
        if (this.at === start) this.fail("a key was expected");
        parts.push(this.text.slice(start, this.at));
      }
      this.skipInline();
      if (this.peek() === ".") this.at++;
      else return parts;
    }
  }
  value() {
    this.skipInline();
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === "[") {
      this.at++;
      const items = [];
      for (;;) {
        this.skipAll();
        if (this.peek() === "]") {
          this.at++;
          return items;
        }
        items.push(this.value());
        this.skipAll();
        if (this.peek() === ",") this.at++;
        else if (this.peek() !== "]") this.fail("a , or ] was expected");
      }
    }
    if (c === "{") {
      this.at++;
      const table = {};
      for (;;) {
        this.skipInline();
        if (this.peek() === "}") {
          this.at++;
          return table;
        }
        assign(
          table,
          this.key(),
          (this.skipInline(), this.expect("="), this.value()),
        );
        this.skipInline();
        if (this.peek() === ",") this.at++;
        else if (this.peek() !== "}") this.fail("a , or } was expected");
      }
    }
    const start = this.at;
    while (!this.done() && !/[\s,\]}#]/.test(this.peek())) this.at++;
    if (this.at === start) this.fail("a value was expected");
    return { raw: this.text.slice(start, this.at) };
  }
  expect(char) {
    if (this.peek() !== char) this.fail(`${char} was expected`);
    this.at++;
  }
}

function assign(table, path, value) {
  let node = table;
  for (const part of path.slice(0, -1)) {
    if (
      typeof node[part] !== "object" ||
      node[part] === null ||
      Array.isArray(node[part])
    )
      node[part] = {};
    node = node[part];
  }
  node[path[path.length - 1]] = value;
}

/** A Cargo.toml (or any TOML in the same subset) as nested objects; array tables become arrays. */
export function parseToml(text) {
  const reader = new Reader(text);
  const root = {};
  let table = root;
  for (;;) {
    reader.skipAll();
    if (reader.done()) return root;
    if (reader.peek() === "[") {
      const array = reader.text.startsWith("[[", reader.at);
      reader.at += array ? 2 : 1;
      const path = reader.key();
      reader.skipInline();
      reader.expect("]");
      if (array) reader.expect("]");
      let node = root;
      path.forEach((part, i) => {
        const last = i === path.length - 1;
        if (last && array) {
          node[part] = Array.isArray(node[part]) ? node[part] : [];
          const entry = {};
          node[part].push(entry);
          node = entry;
        } else {
          if (typeof node[part] !== "object" || node[part] === null)
            node[part] = {};
          node = Array.isArray(node[part])
            ? node[part][node[part].length - 1]
            : node[part];
        }
      });
      table = node;
    } else {
      const path = reader.key();
      reader.skipInline();
      reader.expect("=");
      assign(table, path, reader.value());
    }
    reader.skipInline();
    if (!reader.done() && reader.peek() !== "\n")
      reader.fail("end of line expected");
  }
}

// ---- Cargo features ----

const forbiddenPart = (item) => {
  const name = item.startsWith("dep:")
    ? null
    : item.split("/").pop().replace(/\?$/, "");
  return name !== null && FORBIDDEN_FEATURES.includes(name) ? name : null;
};

/** Every feature (and `crate/feature`) enabled by default, resolved through the feature graph. */
export function defaultClosure(manifest) {
  const features =
    manifest.features && typeof manifest.features === "object"
      ? manifest.features
      : {};
  const seen = new Set();
  const queue = Array.isArray(features.default)
    ? features.default.filter((x) => typeof x === "string")
    : [];
  while (queue.length) {
    const item = queue.shift();
    if (seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(features[item]))
      queue.push(...features[item].filter((x) => typeof x === "string"));
  }
  return seen;
}

/** The dependency tables of a manifest that end up in a build: dependencies, build-dependencies, per target. */
function* dependencyTables(manifest) {
  for (const key of ["dependencies", "build-dependencies"])
    if (manifest[key]) yield [key, manifest[key]];
  for (const [target, tables] of Object.entries(manifest.target ?? {})) {
    for (const key of ["dependencies", "build-dependencies"])
      if (tables?.[key]) yield [`target.${target}.${key}`, tables[key]];
  }
  if (manifest.workspace?.dependencies)
    yield ["workspace.dependencies", manifest.workspace.dependencies];
}

/** Problems in a Cargo.toml for a store build. */
export function checkCargoManifest(text) {
  let manifest;
  try {
    manifest = parseToml(text);
  } catch (error) {
    return [`Cargo.toml cannot be read (${error.message})`];
  }
  const problems = [];
  for (const item of defaultClosure(manifest)) {
    const bad = forbiddenPart(item);
    if (bad)
      problems.push(
        `Cargo.toml enables ${bad} by default${item === bad ? "" : ` (through ${item})`}`,
      );
  }
  for (const [where, dependencies] of dependencyTables(manifest)) {
    for (const [name, spec] of Object.entries(dependencies)) {
      const features =
        spec && typeof spec === "object" && Array.isArray(spec.features)
          ? spec.features
          : [];
      for (const feature of features) {
        if (FORBIDDEN_FEATURES.includes(feature)) {
          problems.push(
            `Cargo.toml: dependency ${name} (${where}) enables the ${feature} feature`,
          );
        }
      }
    }
  }
  return problems;
}

// ---- build commands ----

// Cargo subcommands that do not make an app a store could receive.
const NOT_A_BUILD = new Set([
  "test",
  "clippy",
  "check",
  "doc",
  "bench",
  "fmt",
  "metadata",
  "tree",
  "llvm-cov",
  "nextest",
  "udeps",
  "audit",
  "deny",
  "vet",
]);

/** Shell-ish words of a command: quotes honoured, backslash-newlines joined. */
export function words(text) {
  const out = [];
  let word = null;
  let quote = null;
  const joined = text.replace(/\\\r?\n/g, " ");
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) out.push(word);
  return out;
}

/** Splits a script or workflow into commands: at `&&`, `;`, `|`, a YAML step (`- `) and `run:`. */
function commandsOf(text) {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/&&|\|\||;|\||\n\s*-\s|\brun:\s*[>|]?[-+]?/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Problems in the text of a script, workflow or package script: a forbidden feature (or
 * `--all-features`, which turns on every one of them) given to a command that is not a test, lint or
 * check. Handles `--features a,b`, `--features "a b"`, `--features=a`, `-F a`, `-Fa` and
 * backslash-continued lines.
 */
export function checkCommandText(text, label) {
  const problems = [];
  for (const command of commandsOf(text)) {
    const tokens = words(command);
    const at = tokens.indexOf("cargo");
    const cargoSub =
      at >= 0
        ? tokens
            .slice(at + 1)
            .find((word) => !word.startsWith("+") && !word.startsWith("-"))
        : undefined;
    if (cargoSub !== undefined && NOT_A_BUILD.has(cargoSub)) continue;
    // A command that builds the DEBUG profile (the evaluation installers: `tauri build --debug`) may
    // carry the cloud AI send, and only that feature: a debug build is refused by the store checks
    // (debuggable, get-task-allow, the profile markers) and the Rust gate refuses the feature in the
    // release profile, so such a build cannot ship. Anything else, a release command above all, may not.
    const debugBuild =
      tokens.includes("--debug") && !tokens.includes("--release");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      let list = null;
      if (token === "--all-features")
        problems.push(
          `${label} builds with --all-features (every feature, the stub included)`,
        );
      else if (token === "--features" || token === "-F")
        list = tokens[i + 1] ?? "";
      else if (token.startsWith("--features="))
        list = token.slice("--features=".length);
      else if (/^-F.+/.test(token) && !token.startsWith("--"))
        list = token.slice(2);
      if (list !== null) {
        if (/[$`]/.test(list)) {
          problems.push(
            `${label} gives its features through the shell (${list}), which cannot be checked`,
          );
          continue;
        }
        for (const feature of list.split(/[\s,]+/).filter(Boolean)) {
          const bad = forbiddenPart(feature);
          if (bad && debugBuild && (bad === "cloud-ai" || bad === "cloud_ai"))
            continue;
          if (bad) problems.push(`${label} builds with the ${bad} feature`);
        }
      }
    }
    if (
      /--cfg\s+'?"?feature\s*=\s*\\?"(ai-helper-stub|cloud-ai|cloud_ai|devtools)\\?"/.test(
        command,
      )
    ) {
      problems.push(`${label} turns a forbidden feature on with --cfg`);
    }
  }
  return problems;
}

/** Problems in `.cargo/config.toml`: an alias that builds with a forbidden feature. */
export function checkCargoConfig(text) {
  let config;
  try {
    config = parseToml(text);
  } catch (error) {
    return [`.cargo/config.toml cannot be read (${error.message})`];
  }
  const problems = [];
  for (const [name, value] of Object.entries(config.alias ?? {})) {
    const command = Array.isArray(value)
      ? value.join(" ")
      : typeof value === "string"
        ? value
        : "";
    problems.push(
      ...checkCommandText(
        `cargo ${command}`,
        `.cargo/config.toml alias ${name}`,
      ),
    );
  }
  return problems;
}
