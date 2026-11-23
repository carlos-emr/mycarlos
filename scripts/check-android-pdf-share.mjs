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

/** The filters inside one `<intent-filter>` list of a block of manifest text. */
function filtersIn(block) {
  return [
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
        pathPattern: attribute(t, "pathPattern"),
      })),
    };
  });
}

/** Every activity and activity-alias of the manifest, with the filters it holds and whether it
 * is MainActivity (or an alias that targets it). tauri-utils writes the file-association
 * filters before EVERY `</activity>`, not only MainActivity's, so all of them are read. The
 * opening tag is told from `<activity-alias` by what follows the name, and may spread its
 * attributes over lines, as the real template does. */
export function activities(manifest) {
  const open = (tag) =>
    [
      ...manifest.matchAll(
        new RegExp(`<${tag}\\s[^>]*>[\\s\\S]*?<\\/${tag}>`, "g"),
      ),
    ].map((m) => m[0]);
  const named = (block, attributeName) =>
    attribute(block.slice(0, block.indexOf(">") + 1), attributeName);
  const isMain = (name) => /(^|\.)MainActivity$/.test(name ?? "");
  return [
    ...open("activity").map((block) => ({
      alias: false,
      main: isMain(named(block, "name")),
      filters: filtersIn(block),
    })),
    ...open("activity-alias").map((block) => ({
      alias: true,
      main: isMain(named(block, "targetActivity")),
      filters: filtersIn(block),
    })),
  ];
}

/** The intent filters of MainActivity and of any activity-alias that targets it, or null when
 * there is no MainActivity. */
export function mainActivityFilters(manifest) {
  const found = activities(manifest);
  if (!found.some((one) => one.main && !one.alias)) return null;
  return found.filter((one) => one.main).flatMap((one) => one.filters);
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
  // A VIEW filter that could take a PDF would make myCarlos a PDF viewer: on ANY activity, since
  // the file-association filters are written into all of them.
  for (const filter of activities(manifest).flatMap((one) => one.filters)) {
    if (
      filter.actions.includes("android.intent.action.VIEW") &&
      filter.data.some(
        (d) =>
          [
            "application/pdf",
            "application/*",
            "application/octet-stream",
            "*/*",
          ].includes(d.mimeType) ||
          d.scheme === "file" ||
          d.scheme === "content" ||
          /pdf/i.test(d.pathPattern ?? ""),
      )
    ) {
      problems.push(
        "a VIEW filter takes PDFs, application/*, */*, octet-stream, a .pdf path, files or content addresses",
      );
    }
  }
  for (const filter of filters) {
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
