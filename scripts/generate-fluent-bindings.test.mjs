import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCatalogue,
  compareCatalogues,
  writeOrCheck,
} from "./generate-fluent-bindings.mjs";

function files(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "FAKE-fluent-"));
  const write = (locale, source) =>
    fs.writeFileSync(path.join(dir, `${locale}.ftl`), source);
  try {
    run({ dir, write });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("missing resources, malformed syntax, duplicates and missing values are rejected", () =>
  files(({ dir, write }) => {
    assert.throws(() => readCatalogue("en", dir));
    for (const source of [
      "m = {",
      "m = One\nm = Two",
      "m =\n    .only = Attribute",
      "m = Message\n    .same = One\n    .same = Two",
    ]) {
      write("en", source);
      assert.throws(() => readCatalogue("en", dir));
    }
  }));
test("locale kind, attribute, variable and message parity fail closed", () =>
  files(({ dir, write }) => {
    write("en", "m = Value { $name }\n-term = Term\n");
    const source = readCatalogue("en", dir);
    for (const target of [
      "other = Other\n-term = Term",
      "m = Value\n-term = Term",
      "m = Value { $name }\nterm = Term",
      "m = Value { $name }\n    .extra = Extra\n-term = Term",
    ]) {
      write("fr", target);
      assert.throws(() =>
        compareCatalogues(source, readCatalogue("fr", dir), "fr"),
      );
    }
  }));
test("cardinal plural contracts require valid categories and default other", () =>
  files(({ dir, write }) => {
    for (const value of [
      "m = { $count ->\n [banana] Bad\n *[other] Good\n}",
      "m = { $count ->\n *[one] Only\n}",
    ]) {
      write("en", value);
      assert.throws(() => readCatalogue("en", dir));
    }
    write("zh-CN", "m = { $count ->\n *[other] { $count } 份文件\n}\n");
    assert.equal(readCatalogue("zh-CN", dir).messages.size, 1);
  }));
test("check mode detects absent or stale generated files without rewriting", () =>
  files(({ dir }) => {
    const target = path.join(dir, "generated.ts");
    assert.throws(() => writeOrCheck(target, "new", true));
    fs.writeFileSync(target, "old");
    assert.throws(() => writeOrCheck(target, "new", true));
    assert.equal(fs.readFileSync(target, "utf8"), "old");
    writeOrCheck(target, "old", true);
  }));

test("missing or cyclic terms, unsupported functions and literal bidi controls are rejected", () =>
  files(({ dir, write }) => {
    for (const source of [
      "m = { -missing }",
      "m = { other }\nother = { m }",
      "m = { EXEC($name) }",
      "m = Bad\u2068text\u2069",
    ]) {
      write("en", source);
      assert.throws(() => readCatalogue("en", dir));
    }
    write("en", "-term = Word\nm = { -term }\n");
    assert.equal(readCatalogue("en", dir).messages.size, 1);
  }));
