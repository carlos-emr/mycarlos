// Checks that a built myCarlos.app offers "Open With" for PDFs and does not take them over (#52).
//
//   node scripts/check-macos-pdf-association.mjs <path to myCarlos.app>   (a Mac, after the bundle step)
//   node scripts/check-macos-pdf-association.mjs --config                  (any computer: the source files)
//
// What it asserts about CFBundleDocumentTypes in the app's Info.plist: exactly one entry, a PDF
// one (com.adobe.pdf), with the role Viewer and LSHandlerRank Alternate, so Finder and Mail list
// myCarlos under "Open With" but a Mac whose default is Preview keeps it. It also asserts that
// the app declares no type of its own that conforms to PDF, and that the camera purpose string
// from src-tauri/Info.plist is still merged in.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The problems with a document-type list, as strings; empty when it is right. */
export function documentTypeProblems(info) {
  const problems = [];
  const types = info.CFBundleDocumentTypes;
  if (!Array.isArray(types) || types.length !== 1) {
    return [
      `expected one CFBundleDocumentTypes entry, found ${types?.length ?? 0}`,
    ];
  }
  const [type] = types;
  const contentTypes = type.LSItemContentTypes ?? [];
  if (contentTypes.length !== 1 || contentTypes[0] !== "com.adobe.pdf") {
    problems.push(
      `content types are ${JSON.stringify(contentTypes)}, not ["com.adobe.pdf"]`,
    );
  }
  if (type.CFBundleTypeRole !== "Viewer") {
    problems.push(`role is ${type.CFBundleTypeRole}, not Viewer`);
  }
  if (type.LSHandlerRank !== "Alternate") {
    problems.push(`rank is ${type.LSHandlerRank}, not Alternate`);
  }
  if (info.UTExportedTypeDeclarations?.length) {
    problems.push("the app exports a type of its own");
  }
  return problems;
}

/** The problems with the macOS configuration file in the source tree. */
export function configProblems(config) {
  const problems = [];
  const associations = config?.bundle?.fileAssociations;
  if (!Array.isArray(associations) || associations.length !== 1) {
    return ["expected one bundle.fileAssociations entry"];
  }
  const [one] = associations;
  if (JSON.stringify(one.ext) !== '["pdf"]') problems.push("ext is not [pdf]");
  if (one.mimeType !== "application/pdf")
    problems.push("mimeType is not application/pdf");
  if (one.role !== "Viewer") problems.push("role is not Viewer");
  if (one.rank !== "Alternate") problems.push("rank is not Alternate");
  if (one.exportedType) problems.push("exportedType is set");
  return problems;
}

function main(argument) {
  if (argument === "--config") {
    const read = (name) =>
      JSON.parse(readFileSync(join(here, "..", "src-tauri", name), "utf8"));
    const problems = [
      ...configProblems(read("tauri.macos.conf.json")),
      // Only macOS asks to open PDFs this way: the shared file has none, so Windows and
      // Android builds do not become a PDF viewer through it.
      ...(read("tauri.conf.json").bundle?.fileAssociations
        ? ["tauri.conf.json must not declare fileAssociations"]
        : []),
    ];
    return problems;
  }
  if (!argument)
    throw new Error(
      "usage: check-macos-pdf-association.mjs <myCarlos.app> | --config",
    );
  const plist = join(argument, "Contents", "Info.plist");
  const info = JSON.parse(
    execFileSync("plutil", ["-convert", "json", "-o", "-", plist], {
      encoding: "utf8",
    }),
  );
  const problems = documentTypeProblems(info);
  if (!info.NSCameraUsageDescription)
    problems.push("the camera purpose string is missing");
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = main(process.argv[2]);
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exit(1);
  }
  console.log(
    "ok: PDFs are offered under Open With as an alternate viewer only",
  );
}
