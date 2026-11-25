import { describe, expect, it } from "vitest";
import contractText from "../src-tauri/tests/fixtures/command-args.json?raw";
import {
  problemsInCall,
  scanInvokes,
  shapeOfValue,
  withoutComments,
  type Contract,
} from "./test/commandContract";

// The renderer's calls to the native commands, checked against the argument list the Rust guard
// test writes (src-tauri/tests/fixtures/command-args.json, and that test fails when the file is
// stale). A key with no Rust field is refused by the native side at run time; here it fails first.

const contract = JSON.parse(contractText) as Contract;

// The renderer's own files: every non-test source under src/.
const SOURCES = Object.entries(
  import.meta.glob<string>(["./**/*.ts", "./**/*.tsx", "!./**/*.test.*"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
).filter(([path]) => !path.startsWith("./test/"));

// Calls whose command is a variable (`invoke(command, ...)`): they cannot be checked by name. A
// new one must be added here on purpose, so it is looked at.
const NAMED_AT_RUN_TIME: Record<string, number> = {
  "./native/AiModelSetting.tsx": 3,
  "./native/BackgroundSetting.tsx": 1,
  "./native/NotificationSetting.tsx": 1,
};

describe("the renderer's native calls against the commands' argument list", () => {
  it("reads the Rust side's list: its commands, their arguments and the structs they reach", () => {
    expect(Object.keys(contract.commands).length).toBeGreaterThan(100);
    expect(Object.keys(contract.structs).length).toBeGreaterThan(50);
    expect(contract.commands.vault_unlock.arguments).toEqual({
      request: { optional: false, struct: "PassphraseRequest" },
    });
    expect(contract.structs.PassphraseRequest.fields.passphrase.optional).toBe(
      false,
    );
    // Every struct a command takes directly refuses a key it does not know.
    const direct = new Set(
      Object.values(contract.commands)
        .flatMap((command) => Object.values(command.arguments))
        .flatMap((argument) => (argument.struct ? [argument.struct] : [])),
    );
    expect(direct.size).toBeGreaterThan(40);
    for (const name of direct) {
      expect(contract.structs[name].denyUnknown, name).toBe(true);
    }
  });

  it("finds every call and every one names a command the native side has", () => {
    let checked = 0;
    const unnamed: Record<string, number> = {};
    const unknown: string[] = [];
    for (const [path, source] of SOURCES) {
      for (const call of scanInvokes(source)) {
        if (call.command === null) {
          unnamed[path] = (unnamed[path] ?? 0) + 1;
          continue;
        }
        checked += 1;
        if (!(call.command in contract.commands))
          unknown.push(`${path}:${call.line} ${call.command}`);
      }
    }
    // The scan is reading the sources (vault.ts alone has about a hundred calls).
    expect(checked).toBeGreaterThan(100);
    expect(unknown).toEqual([]);
    expect(unnamed).toEqual(NAMED_AT_RUN_TIME);
  });

  it("sends only keys the native side has, and every key it requires", () => {
    const problems: string[] = [];
    for (const [path, source] of SOURCES) {
      for (const call of scanInvokes(source)) {
        if (call.command === null) continue;
        for (const problem of problemsInCall(
          contract,
          call.command,
          call.args,
        )) {
          problems.push(`${path}:${call.line} ${problem}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  describe("the check itself", () => {
    const call = (text: string) => {
      const [found] = scanInvokes(text);
      return problemsInCall(contract, found.command ?? "?", found.args);
    };

    it("accepts a call the native side takes", () => {
      expect(
        call('invoke("vault_unlock", { request: { passphrase } })'),
      ).toEqual([]);
      expect(call('invoke<void>("vault_lock")')).toEqual([]);
      expect(call("invoke<{ a: string; b: number }>('vault_touch');")).toEqual(
        [],
      );
    });

    it("refuses an unknown command, an unknown argument and an unknown field", () => {
      expect(call('invoke("vault_unlok", {})')).toEqual([
        "vault_unlok: not a native command",
      ]);
      expect(
        call('invoke("vault_unlock", { reqest: { passphrase } })')[0],
      ).toContain('"reqest" is not an argument');
      expect(
        call('invoke("vault_unlock", { request: { passphrase, extra } })')[0],
      ).toContain('"extra" is not a field of PassphraseRequest');
    });

    it("refuses a missing argument and a missing field, but not one that may be left out", () => {
      expect(call('invoke("vault_unlock")')[0]).toContain(
        'required argument "request" is missing',
      );
      expect(call('invoke("vault_unlock", { request: {} })')[0]).toContain(
        'required field "passphrase" of PassphraseRequest is missing',
      );
      const optional = Object.entries(contract.structs).find(([, struct]) =>
        Object.values(struct.fields).some((field) => field.optional),
      );
      expect(optional).toBeDefined();
    });

    it("does not take a spread or a computed key for a missing one, and reads keys it can see", () => {
      expect(call('invoke("vault_unlock", { request: { ...rest } })')).toEqual(
        [],
      );
      expect(
        call('invoke("vault_unlock", { request: { ...rest, extra: 1 } })')[0],
      ).toContain('"extra"');
      expect(
        call('invoke("vault_unlock", { request: { [name]: 1 } })'),
      ).toEqual([]);
    });

    it("reads quoted keys, nested braces, strings holding brackets, templates and trailing commas", () => {
      expect(
        call(
          'invoke("vault_unlock", {\n  request: {\n    "passphrase": `a ${"}"} b`,\n  },\n},)',
        ),
      ).toEqual([]);
      expect(
        call(
          'invoke("vault_unlock", { request: { passphrase: f({ a: [1, 2] }, "}") } })',
        ),
      ).toEqual([]);
    });

    it("does not read a call that is in a comment or in a string", () => {
      expect(
        scanInvokes('// invoke("vault_lock")\n/* invoke("vault_touch") */'),
      ).toEqual([]);
      expect(withoutComments('const a = "// not a comment"; // one')).toBe(
        'const a = "// not a comment";       ',
      );
    });

    it("reports a command that is not a string as unnamed, and takes no arguments for a shorthand name", () => {
      expect(scanInvokes("invoke(command, { enabled })")[0].command).toBeNull();
      expect(call('invoke("vault_unlock", payload)')).toEqual([]);
    });

    it("checks the arguments a fake invoke was really called with, in the same way", () => {
      expect(
        problemsInCall(
          contract,
          "vault_unlock",
          shapeOfValue({ request: { passphrase: "x" } }),
        ),
      ).toEqual([]);
      expect(
        problemsInCall(
          contract,
          "vault_unlock",
          shapeOfValue({ request: { passphrase: "x", pin: 1 } }),
        ),
      ).toHaveLength(1);
      expect(
        problemsInCall(contract, "vault_lock", shapeOfValue(undefined)),
      ).toEqual([]);
    });
  });
});
