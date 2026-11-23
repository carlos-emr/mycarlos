// Generates (or checks) the third-party notices the Open-source notices screen shows.
//
//   node scripts/generate-third-party-notices.mjs \
//     --frontend sbom-frontend.cdx.json --native sbom-native.cdx.json   # writes the file
//   node scripts/generate-third-party-notices.mjs --check ...           # fails if it is stale
//
// The inventories are the CI's locked CycloneDX documents (`npm run sbom:frontend`, and
// `cargo cyclonedx --manifest-path src-tauri/Cargo.toml --format json --target all`). Licence texts
// come from the installed packages (`node_modules`, and the Cargo sources `cargo metadata` names).
// See scripts/third-party-notices.mjs for what makes it fail, and docs in NOTICES.md.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNotices, hashFile, serialize } from "./third-party-notices.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const options = {
    frontend: "sbom-frontend.cdx.json",
    native: "sbom-native.cdx.json",
    out: path.join(root, "src/native/notices/third-party-notices.json"),
    nodeModules: path.join(root, "node_modules"),
    cargoMetadata: null,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--check") options.check = true;
    else if (flag === "--frontend") options.frontend = argv[++i];
    else if (flag === "--native") options.native = argv[++i];
    else if (flag === "--out") options.out = argv[++i];
    else if (flag === "--node-modules") options.nodeModules = argv[++i];
    else if (flag === "--cargo-metadata") options.cargoMetadata = argv[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function readCargo(metadataFile) {
  const metadata = metadataFile
    ? readJson(metadataFile)
    : JSON.parse(
        execFileSync(
          "cargo",
          [
            "metadata",
            "--locked",
            "--manifest-path",
            path.join(root, "src-tauri/Cargo.toml"),
            "--format-version",
            "1",
          ],
          { encoding: "utf8", maxBuffer: 1 << 30 },
        ),
      );
  const directories = new Map();
  const origins = new Map();
  // Crates with no registry or git source are myCarlos's own (a path dependency).
  const firstParty = [];
  for (const pkg of metadata.packages) {
    const key = `${pkg.name}@${pkg.version}`;
    directories.set(key, path.dirname(pkg.manifest_path));
    origins.set(key, {
      holders: pkg.authors ?? [],
      repository: pkg.repository ?? null,
    });
    if (pkg.source === null) firstParty.push(pkg.name);
  }
  return { directories, origins, firstParty };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const {
    directories: cargo,
    origins,
    firstParty,
  } = readCargo(options.cargoMetadata);
  const standardTexts = {};
  const standardDirectory = path.join(
    root,
    "scripts/notices/standard-licences",
  );
  for (const file of readdirSync(standardDirectory)) {
    standardTexts[file.replace(/\.txt$/, "")] = readFileSync(
      path.join(standardDirectory, file),
      "utf8",
    );
  }
  const directoryOf = (ecosystem, component) => {
    if (ecosystem === "cargo")
      return cargo.get(`${component.name}@${component.version}`) ?? null;
    const name = component.group
      ? `${component.group}/${component.name}`
      : component.name;
    return path.join(options.nodeModules, name);
  };
  const overrides = readJson(path.join(root, "scripts/notices/overrides.json"));
  const extra = readJson(
    path.join(root, "scripts/notices/extra-components.json"),
  ).map((component) => {
    // A text can be read from a Cargo package that vendors the code (llama.cpp's own LICENSE).
    const texts = [...(component.texts ?? [])];
    for (const from of component.textFrom ?? []) {
      const directory = cargo.get(from.package);
      const file = directory ? path.join(directory, from.file) : null;
      if (!file || !existsSync(file)) {
        throw new Error(
          `${component.name}: ${from.package}/${from.file} was not found`,
        );
      }
      texts.push({
        name: from.file,
        text: readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim(),
      });
    }
    return { ...component, texts };
  });
  const { problems, document } = buildNotices({
    inventories: [
      { ecosystem: "npm", sbom: readJson(options.frontend) },
      { ecosystem: "cargo", sbom: readJson(options.native) },
    ],
    directoryOf,
    extra,
    overrides,
    // myCarlos's own crates (the app, and the Android PDF plugin in this repository) are not
    // third-party notices: their licence is the one shown at the top of the screen.
    selfNames: ["mycarlos-tauri-poc", "mycarlos", ...firstParty],
    standardTexts,
    originOf: (ecosystem, component) =>
      ecosystem === "cargo"
        ? (origins.get(`${component.name}@${component.version}`) ?? {
            holders: [],
            repository: null,
          })
        : { holders: [], repository: null },
    inputs: {
      packageLock: hashFile(path.join(root, "package-lock.json")),
      cargoLock: hashFile(path.join(root, "src-tauri/Cargo.lock")),
    },
  });
  if (problems.length > 0) {
    console.error("Third-party notices cannot be built:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const bytes = serialize(document);
  if (options.check) {
    const current = existsSync(options.out)
      ? readFileSync(options.out, "utf8")
      : "";
    if (current !== bytes) {
      console.error(
        `${path.relative(root, options.out)} is out of date with the locked inventories. ` +
          "Run `npm run notices:generate` and commit the result.",
      );
      process.exit(1);
    }
    console.log(
      `Third-party notices are current (${document.components.length} components).`,
    );
    return;
  }
  writeFileSync(options.out, bytes);
  console.log(
    `Wrote ${document.components.length} components to ${path.relative(root, options.out)}.`,
  );
}

main();
