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
import { access, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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

export async function configureAndroidSigning(
  gradlePath,
  environment = process.env,
) {
  const missing = missingVariables(environment);
  if (missing.length) {
    throw new Error(
      `set ${missing.join(", ")} (the upload key is never kept in the repository)`,
    );
  }
  await access(environment.MYCARLOS_UPLOAD_KEYSTORE).catch(() => {
    throw new Error("MYCARLOS_UPLOAD_KEYSTORE does not name an existing file");
  });
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
