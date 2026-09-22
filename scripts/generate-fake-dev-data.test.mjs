import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generateFakeDevData } from "./generate-fake-dev-data.mjs";

const committedDirectory = fileURLToPath(
  new URL("../dev-data", import.meta.url),
);

async function withGeneratedData(check) {
  const outputDirectory = await mkdtemp(
    path.join(os.tmpdir(), "mycarlos-fake-data-"),
  );
  try {
    const generated = await generateFakeDevData(outputDirectory);
    await check(outputDirectory, generated);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

// Every xref entry and startxref must point at the object or table it names.
function assertPdfStructure(name, bytes) {
  const text = bytes.toString("latin1");
  assert.match(text, /^%PDF-1\.4\n/, name);
  assert.match(text, /%%EOF\n$/, name);
  const startxref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
  assert.equal(
    text.slice(startxref, startxref + 5),
    "xref\n",
    `${name}: startxref`,
  );
  const [, count, entries] = text
    .slice(startxref)
    .match(/^xref\n0 (\d+)\n((?:\d{10} \d{5} [fn] \n)+)/);
  const offsets = entries
    .trimEnd()
    .split(" \n")
    .slice(1)
    .map((entry) => Number(entry.slice(0, 10)));
  assert.equal(offsets.length, Number(count) - 1, `${name}: xref size`);
  offsets.forEach((offset, index) => {
    assert.ok(
      text.startsWith(`${index + 1} 0 obj\n`, offset),
      `${name}: object ${index + 1} offset`,
    );
  });
  const stream = text.match(/<< \/Length (\d+) >>\nstream\n/);
  const contentStart = stream.index + stream[0].length;
  assert.equal(
    text.slice(
      contentStart + Number(stream[1]),
      contentStart + Number(stream[1]) + 10,
    ),
    "\nendstream",
    `${name}: content length`,
  );
}

test("generates clearly prefixed valid PDF fixtures and an exact duplicate", async () => {
  await withGeneratedData(async (outputDirectory, generated) => {
    assert.equal(generated.length, 6);
    assert.ok(generated.every((name) => name.startsWith("FAKE")));

    const manifest = JSON.parse(
      await readFile(path.join(outputDirectory, "FAKE_MANIFEST.json"), "utf8"),
    );
    assert.equal("suggestedPassphrase" in manifest, false);
    assert.ok(
      manifest.profiles.every((profile) => profile.name.startsWith("FAKE ")),
    );
    assert.ok(
      manifest.profiles
        .flatMap((profile) => profile.folders)
        .every((folder) => folder.startsWith("FAKE ")),
    );

    assert.deepEqual(
      manifest.documents.map((document) => document.fileName).sort(),
      generated.filter((name) => name.endsWith(".pdf")).sort(),
    );
    for (const document of manifest.documents) {
      const bytes = await readFile(
        path.join(outputDirectory, document.fileName),
      );
      assertPdfStructure(document.fileName, bytes);
      assert.match(
        bytes.toString("latin1"),
        new RegExp(`\\(Patient: ${document.profileName}\\) Tj`),
        document.fileName,
      );
    }

    const original = await readFile(
      path.join(outputDirectory, "FAKE_Avery_Patient_Bloodwork.pdf"),
    );
    const duplicate = await readFile(
      path.join(outputDirectory, "FAKE_Avery_Patient_Bloodwork_DUPLICATE.pdf"),
    );
    assert.deepEqual(duplicate, original);
  });
});

test("committed dev-data matches the generator byte for byte", async () => {
  await withGeneratedData(async (outputDirectory, generated) => {
    assert.deepEqual(
      (await readdir(committedDirectory)).sort(),
      [...generated].sort(),
      "Run npm run dev:data to refresh dev-data/",
    );
    for (const name of generated) {
      assert.deepEqual(
        await readFile(path.join(committedDirectory, name)),
        await readFile(path.join(outputDirectory, name)),
        `dev-data/${name} is stale; run npm run dev:data`,
      );
    }
  });
});
