/**
 * The native commands' arguments, as the Rust side declares them, and a check of the renderer's
 * calls against them.
 *
 * `src-tauri/tests/fixtures/command-args.json` is written by the Rust guard test
 * `every_command_argument_denies_unknown_keys_and_is_camel_case_on_the_wire` (and that test fails
 * when the file is stale). It lists every command's arguments and every struct they reach, with
 * the key each has on the wire (camelCase) and whether it may be left out. A renderer call that
 * sends a key no Rust field has is refused by the native side at run time
 * (`deny_unknown_fields`); this check makes the same call fail in a unit test first.
 *
 * Two ways in: `scanInvokes` reads the calls from source text, and `shapeOfValue` reads the
 * arguments a test's fake `invoke` was really called with.
 */

export interface ArgumentContract {
  optional: boolean;
  struct: string | null;
}

export interface StructContract {
  /** Defined twice with different contents in the Rust sources: read as `open`. */
  ambiguous: boolean;
  denyUnknown: boolean;
  fields: Record<string, ArgumentContract>;
  /** A flattened field takes keys this list cannot name. */
  open: boolean;
}

export interface CommandContract {
  arguments: Record<string, ArgumentContract>;
  /** The command reads the raw request (no argument list to check). */
  raw: boolean;
}

export interface Contract {
  /**
   * Where a key cannot be checked, by command: the elements of a list of structs and an enum's
   * variants are not looked into. The Rust guard writes the list so that a reviewer reads it.
   */
  blindSpots: Record<string, string[]>;
  commands: Record<string, CommandContract>;
  structs: Record<string, StructContract>;
}

/** The keys of an object that is passed, and the shape of each value that is itself an object. */
export interface Shape {
  keys: Map<string, Shape | null>;
  /** A spread or a computed key: more keys than can be listed. */
  open: boolean;
}

export type CallArguments = Shape | "none" | "unknown";

export interface Call {
  /** The command's name, or null when it is not a string literal. */
  command: string | null;
  args: CallArguments;
  line: number;
}

function problemsInShape(
  contract: Contract,
  path: string,
  structName: string,
  shape: Shape,
): string[] {
  const struct = contract.structs[structName];
  if (struct === undefined)
    return [`${path}: the struct ${structName} is not in the contract`];
  const problems: string[] = [];
  if (!struct.open) {
    for (const key of shape.keys.keys()) {
      if (!(key in struct.fields))
        problems.push(
          `${path}: "${key}" is not a field of ${structName} (${Object.keys(struct.fields).join(", ")})`,
        );
    }
  }
  if (!shape.open) {
    for (const [key, field] of Object.entries(struct.fields)) {
      if (!field.optional && !shape.keys.has(key))
        problems.push(
          `${path}: the required field "${key}" of ${structName} is missing`,
        );
    }
  }
  for (const [key, value] of shape.keys) {
    const field = struct.fields[key];
    if (field?.struct && value) {
      problems.push(
        ...problemsInShape(contract, `${path}.${key}`, field.struct, value),
      );
    }
  }
  return problems;
}

/** What is wrong with calling `command` with `args`, as lines of text; none when it is right. */
export function problemsInCall(
  contract: Contract,
  command: string,
  args: CallArguments,
): string[] {
  const known = contract.commands[command];
  if (known === undefined) return [`${command}: not a native command`];
  if (known.raw || args === "unknown") return [];
  const problems: string[] = [];
  const shape: Shape =
    args === "none" ? { keys: new Map(), open: false } : args;
  for (const key of shape.keys.keys()) {
    if (!(key in known.arguments))
      problems.push(
        `${command}: "${key}" is not an argument (${Object.keys(known.arguments).join(", ") || "none"})`,
      );
  }
  if (!shape.open) {
    for (const [name, argument] of Object.entries(known.arguments)) {
      if (!argument.optional && !shape.keys.has(name))
        problems.push(`${command}: the required argument "${name}" is missing`);
    }
  }
  for (const [key, value] of shape.keys) {
    const argument = known.arguments[key];
    if (argument?.struct && value) {
      problems.push(
        ...problemsInShape(
          contract,
          `${command}.${key}`,
          argument.struct,
          value,
        ),
      );
    }
  }
  return problems;
}

/** The shape of the second argument a fake `invoke` was called with (a plain object, or none). */
export function shapeOfValue(value: unknown): CallArguments {
  if (value === undefined) return "none";
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "unknown";
  const keys = new Map<string, Shape | null>();
  for (const [key, inner] of Object.entries(value)) {
    const shape = shapeOfValue(inner);
    keys.set(key, typeof shape === "object" ? shape : null);
  }
  return { keys, open: false };
}

// ---- reading the calls out of source text ----

/** `source` with every comment replaced by spaces (newlines kept), so a call in prose is not read. */
export function withoutComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const c = source[index];
    const next = source[index + 1];
    if (c === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      const stop = endOfString(source, index);
      out += source.slice(index, stop);
      index = stop;
    } else {
      out += c;
      index += 1;
    }
  }
  return out;
}

/** The index just after the string (or template) literal that starts at `start`. */
function endOfString(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const c = source[index];
    if (c === "\\") index += 2;
    else if (c === quote) return index + 1;
    else if (c === "\n" && quote !== "`") return index;
    else if (quote === "`" && c === "$" && source[index + 1] === "{") {
      index = endOfBraces(source, index + 1);
    } else index += 1;
  }
  return source.length;
}

/** The index just after the `}` matching the `{` at `start`. */
function endOfBraces(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const c = source[index];
    if (c === '"' || c === "'" || c === "`") {
      index = endOfString(source, index);
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function skipSpace(source: string, from: number): number {
  let index = from;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/** The end of the expression that starts at `from`: the next `,` or closing bracket at depth 0. */
function skipExpression(source: string, from: number): number {
  let depth = 0;
  let index = from;
  while (index < source.length) {
    const c = source[index];
    if (c === '"' || c === "'" || c === "`") {
      index = endOfString(source, index);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (c === "," && depth === 0) return index;
    index += 1;
  }
  return index;
}

/** Reads the object literal that starts at `start` (a `{`), and where it ends. */
function readObject(
  source: string,
  start: number,
): { shape: Shape; end: number } {
  const shape: Shape = { keys: new Map(), open: false };
  let index = skipSpace(source, start + 1);
  while (index < source.length && source[index] !== "}") {
    if (source.startsWith("...", index)) {
      shape.open = true;
      index = skipExpression(source, index + 3);
    } else {
      let key: string | null = null;
      if (source[index] === '"' || source[index] === "'") {
        const stop = endOfString(source, index);
        key = source.slice(index + 1, stop - 1);
        index = stop;
      } else if (source[index] === "[") {
        shape.open = true;
        index = skipExpression(source, index);
      } else {
        const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
        if (name === null) {
          // Not a shape this reader knows: say the object has keys it cannot list.
          shape.open = true;
          index = skipExpression(source, index);
        } else {
          key = name[0];
          index += key.length;
        }
      }
      index = skipSpace(source, index);
      if (source[index] === ":") {
        index = skipSpace(source, index + 1);
        if (source[index] === "{" && key !== null) {
          const inner = readObject(source, index);
          shape.keys.set(key, inner.shape);
          index = inner.end;
        } else {
          if (key !== null) shape.keys.set(key, null);
          index = skipExpression(source, index);
        }
      } else if (source[index] === "(") {
        // A method written as a shorthand: a key with a function for its value.
        if (key !== null) shape.keys.set(key, null);
        index = skipExpression(source, index);
      } else if (key !== null) {
        shape.keys.set(key, null);
      }
    }
    index = skipSpace(source, index);
    if (source[index] === ",") index = skipSpace(source, index + 1);
  }
  return { shape, end: index + 1 };
}

/** Every `invoke(...)` call in `source`, with the command and the object it is given. */
export function scanInvokes(source: string): Call[] {
  const text = withoutComments(source);
  const calls: Call[] = [];
  const pattern = /\binvoke\s*(?=[<(])/g;
  for (
    let found = pattern.exec(text);
    found !== null;
    found = pattern.exec(text)
  ) {
    let index = found.index + found[0].length;
    if (text[index] === "<") {
      let depth = 0;
      while (index < text.length) {
        if (text[index] === "<") depth += 1;
        else if (text[index] === ">" && text[index - 1] !== "=") {
          depth -= 1;
          if (depth === 0) {
            index += 1;
            break;
          }
        }
        index += 1;
      }
      index = skipSpace(text, index);
    }
    if (text[index] !== "(") continue;
    index = skipSpace(text, index + 1);
    const line = text.slice(0, found.index).split("\n").length;
    let command: string | null = null;
    if (text[index] === '"' || text[index] === "'") {
      const stop = endOfString(text, index);
      command = text.slice(index + 1, stop - 1);
      index = stop;
    } else {
      index = skipExpression(text, index);
    }
    index = skipSpace(text, index);
    if (text[index] === ",") {
      index = skipSpace(text, index + 1);
      if (text[index] === "{") {
        calls.push({ command, args: readObject(text, index).shape, line });
      } else if (text[index] === ")") {
        calls.push({ command, args: "none", line });
      } else {
        calls.push({ command, args: "unknown", line });
      }
    } else {
      calls.push({ command, args: "none", line });
    }
  }
  return calls;
}

/**
 * Ways `invoke` can be reached that `scanInvokes` does not read as a call: renamed on import,
 * assigned, passed on, or used through the module object. None may appear in the sources, or a
 * call could go unchecked.
 */
export function aliasesOfInvoke(source: string): string[] {
  const text = withoutComments(source);
  const found: string[] = [];
  const patterns: [string, RegExp][] = [
    ["renamed on import", /\binvoke\s+as\b/],
    ["assigned", /=\s*invoke\b(?!\s*[<(])/],
    ["passed on", /[(,]\s*invoke\s*[,)]/],
    ["through the module", /\.\s*invoke\s*[<(]/],
    ["by typeof", /\btypeof\s+invoke\b/],
    ["in a list", /\[\s*invoke\s*[,\]]/],
    ["through call, apply or bind", /\binvoke\s*\.\s*(?:call|apply|bind)\b/],
    ["through optional call", /\binvoke\s*\?\.\s*\(/],
    ["exported", /\bexport\s*\{[^}]*\binvoke\b/],
    [".apply or .bind on it", /\binvoke\b[^;\n]*\.\s*(?:apply|bind)\s*\(/],
  ];
  for (const [how, pattern] of patterns) {
    if (pattern.test(text)) found.push(how);
  }
  return found;
}

/** The commands named as the first argument of `save("…", …)` and `mutate("…", …)` in `source`. */
export function wrapperCommands(source: string): string[] {
  const text = withoutComments(source);
  return [...text.matchAll(/\b(?:save|mutate)\(\s*"([a-z0-9_]+)"/g)].map(
    (match) => match[1],
  );
}
