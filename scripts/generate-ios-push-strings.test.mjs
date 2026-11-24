import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  expectedFiles,
  parseStrings,
  problems,
  readManifest,
  renderFile,
} from "./generate-ios-push-strings.mjs";

const root = path.resolve(import.meta.dirname, "..");
const catalogues = path.join(root, "src/i18n/locales/fluent");
const resources = path.join(root, "src-tauri/ios-push/Resources");
const manifest = readManifest();
const locales = ["en", "es", "fr", "pl", "pt-BR", "zh-CN", "zh-TW"];

/** A scratch folder with a Fluent catalogue for every locale and a strings folder to match. */
function scratch(
  run,
  { message = "m = A new thing", variables = [], generate = true } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "FAKE-ios-strings-"));
  try {
    const ftl = path.join(dir, "ftl");
    const out = path.join(dir, "out");
    fs.mkdirSync(ftl);
    for (const locale of locales)
      fs.writeFileSync(path.join(ftl, `${locale}.ftl`), `${message}\n`);
    const scratchManifest = {
      locales: manifest.locales,
      strings: [{ key: "THING", fluent: "m", variables }],
    };
    for (const [relative, text] of generate
      ? expectedFiles(scratchManifest, ftl)
      : []) {
      fs.mkdirSync(path.dirname(path.join(out, relative)), { recursive: true });
      fs.writeFileSync(path.join(out, relative), text);
    }
    run({ ftl, out, scratchManifest });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lproj = (out, locale) =>
  path.join(out, `${manifest.locales[locale]}.lproj`, "Localizable.strings");

test("the checked-in strings are what the catalogue says, in all seven languages", () => {
  assert.deepEqual(problems(manifest, catalogues, resources), []);
  assert.equal(Object.keys(manifest.locales).length, 7);
});

test("the push sentence is the desktop's, with nothing in it but words", () => {
  const files = expectedFiles(manifest, catalogues);
  const english = files.get("en.lproj/Localizable.strings");
  assert.match(
    english,
    /"MYCARLOS_DOCUMENT_WAITING" = "A new document is waiting\. Unlock myCarlos to see it\.";/,
  );
  for (const text of files.values()) {
    const pairs = parseStrings(text);
    assert.deepEqual([...pairs.keys()], ["MYCARLOS_DOCUMENT_WAITING"]);
    assert.doesNotMatch([...pairs.values()][0], /%|\{|\}/);
  }
});

test("a missing file, a missing key and an extra key are each reported", () =>
  scratch(({ ftl, out, scratchManifest }) => {
    assert.deepEqual(problems(scratchManifest, ftl, out), []);
    fs.rmSync(lproj(out, "fr"));
    assert.match(
      problems(scratchManifest, ftl, out).join("\n"),
      /fr\.lproj.*is missing/,
    );
    fs.writeFileSync(lproj(out, "fr"), '/* x */\n"OTHER" = "x";\n');
    const found = problems(scratchManifest, ftl, out).join("\n");
    assert.match(
      found,
      /fr\.lproj\/Localizable\.strings: key THING is missing/,
    );
    assert.match(found, /fr\.lproj\/Localizable\.strings: extra key OTHER/);
  }));

test("a stale or edited value is reported with the command that fixes it", () =>
  scratch(({ ftl, out, scratchManifest }) => {
    fs.writeFileSync(lproj(out, "pl"), '"THING" = "An old thing";\n');
    assert.match(
      problems(scratchManifest, ftl, out).join("\n"),
      /pl\.lproj.*is stale; run npm run ios-push:strings/,
    );
  }));

test("a placeholder that the message does not list, or lists and the file lacks, is refused", () => {
  // The message has a variable but the list does not name it: the generator refuses.
  scratch(
    ({ ftl, scratchManifest }) => {
      assert.throws(
        () =>
          expectedFiles(
            {
              ...scratchManifest,
              strings: [{ key: "THING", fluent: "m", variables: [] }],
            },
            ftl,
          ),
        /variables \[name\] do not match strings\.json \[\]/,
      );
    },
    { message: "m = A thing for { $name }", variables: ["name"] },
  );
  // The list names it and the file has a plain %@ or none: the check refuses.
  scratch(
    ({ ftl, out, scratchManifest }) => {
      assert.deepEqual(problems(scratchManifest, ftl, out), []);
      assert.match(
        fs.readFileSync(lproj(out, "es"), "utf8"),
        /A thing for %1\$@/,
      );
      fs.writeFileSync(lproj(out, "es"), '"THING" = "A thing for %@";\n');
      assert.match(
        problems(scratchManifest, ftl, out).join("\n"),
        /es\.lproj.*placeholders/,
      );
      fs.writeFileSync(lproj(out, "es"), '"THING" = "A thing for nobody";\n');
      assert.match(
        problems(scratchManifest, ftl, out).join("\n"),
        /es\.lproj.*placeholders \[\]/,
      );
    },
    { message: "m = A thing for { $name }", variables: ["name"] },
  );
});

test("a push sentence may not use a selector, a function or an attribute", () => {
  for (const message of [
    "m = { $n ->\n    [one] One\n   *[other] Many\n}",
    "m = { NUMBER($n) }",
    "m = Words\n    .attr = Extra",
  ]) {
    scratch(
      ({ ftl, scratchManifest }) => {
        assert.throws(() => expectedFiles(scratchManifest, ftl));
      },
      { message, variables: ["n"], generate: false },
    );
  }
});

test("quotes, backslashes and new lines survive the file and come back", () => {
  const value = 'He said "stop" \\ then\nleft';
  const text = renderFile([{ key: "K", value }]);
  assert.match(text, /"K" = "He said \\"stop\\" \\\\ then\\nleft";/);
  assert.equal(parseStrings(text).get("K"), value);
});

test("the key list itself is checked: no repeats, no lower-case keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "FAKE-ios-manifest-"));
  try {
    const write = (strings) => {
      const file = path.join(dir, "strings.json");
      fs.writeFileSync(file, JSON.stringify({ locales: {}, strings }));
      return file;
    };
    assert.throws(
      () =>
        readManifest(
          write([
            { key: "A", fluent: "a", variables: [] },
            { key: "A", fluent: "b", variables: [] },
          ]),
        ),
      /repeats a key/,
    );
    assert.throws(
      () => readManifest(write([{ key: "lower", fluent: "a", variables: [] }])),
      /UPPER_SNAKE/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
