// Checks that myCarlos is offered in the Android Share menu for PDFs, and nowhere else (#50).
//
//   node scripts/check-android-pdf-share.mjs --config
//       the source file, on any computer
//   node scripts/check-android-pdf-share.mjs <AndroidManifest.xml>
//       the manifest `tauri android init` generated (src-tauri/gen/android/app/src/main/AndroidManifest.xml)
//
// The manifest must have, on MainActivity, an intent filter for SEND and one for SEND_MULTIPLE,
// each with the DEFAULT category and the data type application/pdf, and no VIEW filter that takes a
// PDF (or any file or content address), so myCarlos is never offered as the app that opens a PDF.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The problems with the source configuration; empty when it is right. */
export function configProblems(config) {
  const associations = config?.bundle?.fileAssociations;
  if (!Array.isArray(associations) || associations.length !== 1) {
    return ["expected one bundle.fileAssociations entry"];
  }
  const [one] = associations;
  const problems = [];
  if (JSON.stringify(one.ext) !== '["pdf"]') problems.push("ext is not [pdf]");
  if (one.mimeType !== "application/pdf")
    problems.push("mimeType is not application/pdf");
  const actions = JSON.stringify(
    [...(one.androidIntentActionFilters ?? [])].sort(),
  );
  if (actions !== '["send","sendMultiple"]') {
    problems.push(
      `androidIntentActionFilters is ${actions}, not ["send","sendMultiple"] (no "view")`,
    );
  }
  return problems;
}

const attribute = (tag, name) =>
  new RegExp(`android:${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];

/** The intent filters of the activity named MainActivity, as {actions, categories, data}. */
export function mainActivityFilters(manifest) {
  const activities = [
    ...manifest.matchAll(/<activity\b[^>]*>[\s\S]*?<\/activity>/g),
  ];
  const main = activities.find((match) =>
    /android:name\s*=\s*"[^"]*MainActivity"/.test(match[0].split(">")[0]),
  );
  if (!main) return null;
  return [
    ...main[0].matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g),
  ].map((filter) => {
    const tags = (name) =>
      [...filter[1].matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map(
        (t) => t[0],
      );
    return {
      actions: tags("action").map((t) => attribute(t, "name")),
      categories: tags("category").map((t) => attribute(t, "name")),
      data: tags("data").map((t) => ({
        mimeType: attribute(t, "mimeType"),
        scheme: attribute(t, "scheme"),
      })),
    };
  });
}

/** The problems with a generated manifest; empty when it is right. */
export function manifestProblems(manifest) {
  const filters = mainActivityFilters(manifest);
  if (!filters) return ["no MainActivity found"];
  const problems = [];
  const takesPdf = (filter) =>
    filter.data.some((d) => d.mimeType === "application/pdf");
  for (const action of [
    "android.intent.action.SEND",
    "android.intent.action.SEND_MULTIPLE",
  ]) {
    const found = filters.filter(
      (filter) => filter.actions.includes(action) && takesPdf(filter),
    );
    if (found.length !== 1) {
      problems.push(
        `expected one ${action} filter for application/pdf, found ${found.length}`,
      );
    } else if (
      !found[0].categories.includes("android.intent.category.DEFAULT")
    ) {
      problems.push(`the ${action} filter lacks the DEFAULT category`);
    }
  }
  for (const filter of filters) {
    if (filter.actions.includes("android.intent.action.VIEW")) {
      // Only the app's own deep-link style filters could be here; a PDF or a file/content
      // address would make myCarlos a PDF viewer.
      if (
        takesPdf(filter) ||
        filter.data.some((d) => d.scheme === "file" || d.scheme === "content")
      ) {
        problems.push("a VIEW filter takes PDFs, files or content addresses");
      }
    }
    for (const data of filter.data) {
      if (
        data.mimeType &&
        data.mimeType !== "application/pdf" &&
        filter.actions.some((a) => /\.action\.SEND/.test(a))
      ) {
        problems.push(`a SEND filter takes ${data.mimeType}`);
      }
    }
  }
  return problems;
}

function main(argument) {
  if (argument === "--config") {
    const read = (name) =>
      JSON.parse(readFileSync(join(here, "..", "src-tauri", name), "utf8"));
    return [
      ...configProblems(read("tauri.android.conf.json")),
      ...(read("tauri.conf.json").bundle?.fileAssociations
        ? ["tauri.conf.json must not declare fileAssociations"]
        : []),
    ];
  }
  if (!argument) {
    throw new Error(
      "usage: check-android-pdf-share.mjs <AndroidManifest.xml> | --config",
    );
  }
  return manifestProblems(readFileSync(argument, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = main(process.argv[2]);
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL: ${problem}`);
    process.exit(1);
  }
  console.log(
    "ok: PDFs can be shared to myCarlos, and it is never offered to open them",
  );
}
