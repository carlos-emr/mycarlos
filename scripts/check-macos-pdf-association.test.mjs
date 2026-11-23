import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  configProblems,
  documentTypeProblems,
} from "./check-macos-pdf-association.mjs";

const right = {
  CFBundleDocumentTypes: [
    {
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "Alternate",
      LSItemContentTypes: ["com.adobe.pdf"],
    },
  ],
};

test("the source file asks for an alternate PDF viewer and nothing else", () => {
  const config = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.macos.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(configProblems(config), []);
  const shared = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(shared.bundle.fileAssociations, undefined);
});

test("a built Info.plist is accepted only when it is an alternate PDF viewer", () => {
  assert.deepEqual(documentTypeProblems(right), []);
  const change = (fields) => ({
    CFBundleDocumentTypes: [{ ...right.CFBundleDocumentTypes[0], ...fields }],
  });
  assert.equal(documentTypeProblems({}).length, 1);
  assert.equal(documentTypeProblems({ CFBundleDocumentTypes: [] }).length, 1);
  assert.match(
    documentTypeProblems(change({ LSHandlerRank: "Default" }))[0],
    /rank/,
  );
  assert.match(
    documentTypeProblems(change({ LSHandlerRank: "Owner" }))[0],
    /rank/,
  );
  assert.match(
    documentTypeProblems(change({ CFBundleTypeRole: "Editor" }))[0],
    /role/,
  );
  assert.match(
    documentTypeProblems(change({ LSItemContentTypes: ["public.data"] }))[0],
    /content types/,
  );
  assert.match(
    documentTypeProblems({ ...right, UTExportedTypeDeclarations: [{}] })[0],
    /exports/,
  );
  // Two entries are refused: nothing else may be claimed.
  assert.equal(
    documentTypeProblems({
      CFBundleDocumentTypes: [
        ...right.CFBundleDocumentTypes,
        ...right.CFBundleDocumentTypes,
      ],
    }).length,
    1,
  );
});

test("a configuration that would take PDFs over is refused", () => {
  const base = {
    ext: ["pdf"],
    mimeType: "application/pdf",
    role: "Viewer",
    rank: "Alternate",
  };
  const config = (fields) => ({
    bundle: { fileAssociations: [{ ...base, ...fields }] },
  });
  assert.deepEqual(configProblems(config({})), []);
  assert.deepEqual(configProblems(config({ rank: "Default" })), [
    "rank is not Alternate",
  ]);
  assert.deepEqual(configProblems(config({ role: "Editor" })), [
    "role is not Viewer",
  ]);
  assert.deepEqual(configProblems(config({ ext: ["pdf", "txt"] })), [
    "ext is not [pdf]",
  ]);
  assert.deepEqual(configProblems({}), [
    "expected one bundle.fileAssociations entry",
  ]);
});
