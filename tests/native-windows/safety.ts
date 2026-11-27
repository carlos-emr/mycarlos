// SAFETY for every native-windows journey that creates or erases a vault.
//
// The installed app keeps its vault in the Windows account's own data folder
// (`%LOCALAPPDATA%\ca.carlos.mycarlos\vault-home`), found through Tauri's `app_local_data_dir()`,
// which asks Windows for the known folder: an environment variable cannot move it, and the app has
// NO data-home override today. So a journey that makes and erases a vault would act on the real
// account's vault if run on a real PC. Therefore:
//
//  1. The journeys REFUSE to start unless the account is disposable: a GitHub Actions runner
//     (`GITHUB_ACTIONS=true`) or an explicit `MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT=1`, which a
//     person sets only on a throw-away Windows account. Never on an account that holds a real vault.
//  2. They also refuse if a vault already exists (`vault_status` is not "absent"), which the
//     helpers check before creating anything.
//  3. Cleanup removes ONLY a directory the helper created itself, checked by path equality
//     (`removableOwnDirectory`), never a computed or configured path.
//
// The smallest real fix is a debug-build-only override of that folder (planned as its own commit in
// the playtest PR: `MYCARLOS_TEST_DATA_DIR`, read only under `cfg(debug_assertions)` where
// `app_local_data_dir()` is called); until it lands, the guard above is what protects a real vault.
import { resolve } from "node:path";

export interface GuardEnvironment {
  platform: string;
  env: Record<string, string | undefined>;
}

/** Throws unless the journeys may create and erase a vault on this machine. */
export function requireDisposableAccount({ platform, env }: GuardEnvironment) {
  if (platform !== "win32")
    throw new Error("The native-windows journeys run on Windows only");
  const disposable =
    env.GITHUB_ACTIONS === "true" ||
    env.MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT === "1";
  if (!disposable)
    throw new Error(
      "Refusing to run: these journeys create and erase a vault in this Windows account's own " +
        "myCarlos data folder. Run them on a GitHub Actions runner, or set " +
        "MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT=1 on a throw-away account that holds no real vault.",
    );
}

/**
 * Whether `candidate` is exactly the directory this run created (`created`): path equality after
 * resolving, never "inside" and never a parent. The only thing cleanup may delete.
 */
export function removableOwnDirectory(
  created: string | undefined,
  candidate: string | undefined,
): boolean {
  if (!created || !candidate) return false;
  const same = (a: string, b: string) =>
    process.platform === "win32"
      ? a.toLowerCase() === b.toLowerCase()
      : a === b;
  return same(resolve(created), resolve(candidate));
}
