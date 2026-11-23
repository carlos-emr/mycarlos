// Checks that myCarlos is offered in the Android Share menu for PDFs, and nowhere else (#50).
//
//   node scripts/check-android-pdf-share.mjs --config
//       the source file, on any computer
//   node scripts/check-android-pdf-share.mjs <AndroidManifest.xml>
//       the manifest of the Android project (src-tauri/gen/android/app/src/main/AndroidManifest.xml)
//       AFTER the Android build: `tauri android init` does not write the file-association
//       filters; tauri-build's build script does, during the cargo build, between the
//       `tauri-file-associations` markers inside MainActivity.
//
// The manifest must have, on MainActivity (or an activity-alias that targets it), a filter for
// SEND and one for SEND_MULTIPLE (tauri-build writes them as ONE filter), with the DEFAULT
// category and the data type application/pdf, and no VIEW filter that takes a PDF, any
// application/* or */* type, or any file or content address, so myCarlos is never offered as
// the app that opens a PDF. The BROWSABLE category tauri-build also writes is allowed on
// purpose: a SEND filter with it only lets a web page's share intent reach the same
// received-files path, which accepts only content: addresses and checks the %PDF header.
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

/** The intent filters of MainActivity and of any activity-alias that targets it, as
 * {actions, categories, data}, or null when there is no MainActivity. */
export function mainActivityFilters(manifest) {
  const blocks = [
    ...[...manifest.matchAll(/<activity\b[^>]*>[\s\S]*?<\/activity>/g)].map(
      (m) => ({
        block: m[0],
        name: attribute(m[0].split(">")[0], "name"),
      }),
    ),
    ...[
      ...manifest.matchAll(
        /<activity-alias\b[^>]*>[\s\S]*?<\/activity-alias>/g,
      ),
    ].map((m) => ({
      block: m[0],
      name: attribute(m[0].split(">")[0], "targetActivity"),
    })),
  ].filter(({ name }) => /(^|\.)MainActivity$/.test(name ?? ""));
  if (!blocks.some(({ block }) => block.startsWith("<activity "))) return null;
  return blocks.flatMap(({ block }) =>
    [
      ...block.matchAll(/<intent-filter\b[^>]*>([\s\S]*?)<\/intent-filter>/g),
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
    }),
  );
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
        filter.data.some(
          (d) =>
            ["application/pdf", "application/*", "*/*"].includes(d.mimeType) ||
            d.scheme === "file" ||
            d.scheme === "content",
        )
      ) {
        problems.push(
          "a VIEW filter takes PDFs, application/* or */*, files or content addresses",
        );
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
