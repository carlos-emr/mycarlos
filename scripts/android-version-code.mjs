#!/usr/bin/env node
// The Android versionCode scheme (#422).
//
//   versionCode = major * 10,000,000 + minor * 100,000 + patch * 1,000 + build
//
// Google Play needs every upload's versionCode to be larger than the one before it, and at most
// 2,100,000,000. The scheme keeps both: a new version always beats any build of an older one, and
// a re-upload of the same version takes the next build number.
//
//   major 0 to 99      minor 0 to 99      patch 0 to 99      build 0 to 999
//
// `build` is the operator's counter for uploads of the same version (`MYCARLOS_BUILD_NUMBER`, 0 for
// the first). A pre-release suffix of the version ("0.1.0-alpha.1") is ignored; the build number is
// what tells those uploads apart. The Tauri CLI's own default (major * 1,000,000 + minor * 1,000 +
// patch) has no build part, so it cannot re-upload a version; this scheme replaces it through
// `--config` (see scripts/build-android-release.sh).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_VERSION_CODE = 2_100_000_000;

/** The versionCode for `version` ("1.2.3" or "1.2.3-alpha.1") and `build` (0 to 999). */
export function versionCode(version, build = 0) {
  const found =
    /^(\d{1,2})\.(\d{1,2})\.(\d{1,2})(?:[-+][0-9A-Za-z.+-]*)?$/.exec(
      String(version),
    );
  if (!found) {
    throw new Error(
      `version "${version}" must be major.minor.patch with each part 0 to 99`,
    );
  }
  const [major, minor, patch] = found.slice(1).map(Number);
  if (!Number.isInteger(build) || build < 0 || build > 999) {
    throw new Error(
      `build number ${build} must be a whole number from 0 to 999`,
    );
  }
  const code = major * 10_000_000 + minor * 100_000 + patch * 1_000 + build;
  if (code < 1 || code > MAX_VERSION_CODE) {
    // 0.0.0 build 0 gives 0, which Android refuses.
    throw new Error(
      `versionCode ${code} must be from 1 to ${MAX_VERSION_CODE}`,
    );
  }
  return code;
}

/** The build number from an environment value: absent is 0, anything else must be a whole number. */
export function buildNumber(value) {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,3}$/.test(value)) {
    throw new Error(
      `MYCARLOS_BUILD_NUMBER "${value}" must be a whole number from 0 to 999`,
    );
  }
  return Number(value);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const config = JSON.parse(
      await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"),
    );
    console.log(
      versionCode(
        config.version,
        buildNumber(process.env.MYCARLOS_BUILD_NUMBER),
      ),
    );
  } catch (error) {
    console.error(`versionCode: ${error.message}`);
    process.exit(1);
  }
}
