#!/usr/bin/env node
// Release signing for the generated Android app (#422). No key is in this repository: the upload
// key is supplied by the person building the release, through four environment variables, and is
// read by Gradle only. Play App Signing keeps the real app signing key; this is the *upload* key.
//
//   MYCARLOS_UPLOAD_KEYSTORE            path of the keystore file (outside the repository)
//   MYCARLOS_UPLOAD_KEYSTORE_PASSWORD
//   MYCARLOS_UPLOAD_KEY_ALIAS
//   MYCARLOS_UPLOAD_KEY_PASSWORD
//
// `node scripts/configure-android-signing.mjs [app/build.gradle.kts]` appends one block to the
// generated Gradle file that gives the release build type that signing config, and refuses to run
// if a variable is missing or the keystore file does not exist, so a release build cannot silently
// fall back to the debug key. Run it once after `tauri android init`; it is safe to run again.
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const VARIABLES = [
  "MYCARLOS_UPLOAD_KEYSTORE",
  "MYCARLOS_UPLOAD_KEYSTORE_PASSWORD",
  "MYCARLOS_UPLOAD_KEY_ALIAS",
  "MYCARLOS_UPLOAD_KEY_PASSWORD",
];
const MARKER = "mycarlos: sign release builds with the upload key";

// The values are read from the environment by Gradle itself: they are never written into the file.
export const BLOCK = `
// ${MARKER}
android {
    signingConfigs {
        create("mycarlosUpload") {
            storeFile = file(System.getenv("MYCARLOS_UPLOAD_KEYSTORE"))
            storePassword = System.getenv("MYCARLOS_UPLOAD_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("MYCARLOS_UPLOAD_KEY_ALIAS")
            keyPassword = System.getenv("MYCARLOS_UPLOAD_KEY_PASSWORD")
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("mycarlosUpload")
        }
    }
}
`;

/** The Gradle source with the signing block present exactly once. */
export function withSigning(source) {
  if (!/^\s*android\s*\{/m.test(source)) {
    throw new Error("the generated app/build.gradle.kts has no android block");
  }
  if (source.includes(MARKER)) return source;
  return `${source.replace(/\s*$/, "")}\n${BLOCK}`;
}

/** The names of the variables that are missing (empty or unset) in `environment`. */
export function missingVariables(environment) {
  return VARIABLES.filter((name) => !environment[name]);
}

/** Whether `path` is inside `root` once both are resolved (symbolic links followed). */
export function isInside(path, root) {
  const inside = relative(root, path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

export async function configureAndroidSigning(
  gradlePath,
  environment = process.env,
  repositoryRoot = REPOSITORY_ROOT,
) {
  const missing = missingVariables(environment);
  if (missing.length) {
    throw new Error(
      `set ${missing.join(", ")} (the upload key is never kept in the repository)`,
    );
  }
  const keystore = await realpath(
    resolve(environment.MYCARLOS_UPLOAD_KEYSTORE),
  ).catch(() => {
    throw new Error("MYCARLOS_UPLOAD_KEYSTORE does not name an existing file");
  });
  // A key inside the working tree can be committed by accident or swept into an artifact.
  if (isInside(keystore, await realpath(repositoryRoot))) {
    throw new Error(
      "MYCARLOS_UPLOAD_KEYSTORE is inside the repository; keep the upload key outside it",
    );
  }
  const source = await readFile(gradlePath, "utf8");
  await writeFile(gradlePath, withSigning(source), "utf8");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await configureAndroidSigning(
      process.argv[2] ?? "src-tauri/gen/android/app/build.gradle.kts",
    );
  } catch (error) {
    console.error(`Android signing: ${error.message}`);
    process.exit(1);
  }
}
