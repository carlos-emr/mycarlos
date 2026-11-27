// SAFETY for every native-windows journey that creates or erases a vault.
//
// The installed app keeps its vault in the Windows account's own data folder
// (`%LOCALAPPDATA%\ca.carlos.mycarlos\vault-home`), found through Tauri's `app_local_data_dir()`,
// which asks Windows for the known folder: an environment variable cannot move it, and the app has
// NO data-home override today. So a journey that makes and erases a vault would act on the real
// account's vault if run on a real PC. Therefore:
//
//  1. The journeys REFUSE to start unless the account is disposable: a GitHub-HOSTED runner
//     (`GITHUB_ACTIONS=true` AND `RUNNER_ENVIRONMENT=github-hosted`; a self-hosted runner, which is
//     often a real machine, also sets the first), or an explicit
//     `MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT=1`, which a person sets only on a throw-away Windows
//     account. Never on an account that holds a real vault.
//  2. They refuse if a vault already exists (`vault_status` is not "absent"): createFakeVault checks
//     it before creating anything, and the afterAll erase runs only after createFakeVault RETURNED.
//  3. Erasing proves the vault is the helper's own first (`provesFakeVault`): it must open with the
//     FAKE passphrase, which no real vault does, and hold the FAKE first person.
//  4. Cleanup removes only a directory this run made itself: the real guard is that it was made by
//     `mkdtemp` (or a `mkdir` that fails if the folder exists) in this run; `removableOwnDirectory`
//     is a second look at the path just before the delete, nothing more.
//
// The smallest real fix is a debug-build-only override of that folder (planned as its own commit in
// the playtest PR: `MYCARLOS_TEST_DATA_DIR`, read only under `cfg(debug_assertions)` where
// `app_local_data_dir()` is called); until it lands, the guard above is what protects a real vault.
import { resolve, win32 } from "node:path";

export interface GuardEnvironment {
  platform: string;
  env: Record<string, string | undefined>;
}

/** Throws unless the journeys may create and erase a vault on this machine. */
export function requireDisposableAccount({ platform, env }: GuardEnvironment) {
  if (platform !== "win32")
    throw new Error("The native-windows journeys run on Windows only");
  // A hosted runner is a fresh virtual machine; a self-hosted one is often somebody's PC.
  const hostedRunner =
    env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted";
  const declared = env.MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT === "1";
  if (!hostedRunner && !declared)
    throw new Error(
      "Refusing to run: these journeys create and erase a vault in this Windows account's own " +
        "myCarlos data folder. Run them on a GitHub-hosted runner, or set " +
        "MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT=1 on a throw-away account that holds no real vault.",
    );
  // The paths the run relies on must be set and absolute, never relative to wherever it started.
  if (!env.LOCALAPPDATA)
    throw new Error("Refusing to run: LOCALAPPDATA is not set");
  if (!win32.isAbsolute(env.LOCALAPPDATA))
    throw new Error("Refusing to run: LOCALAPPDATA is not an absolute path");
  const profile = env.MYCARLOS_WINDOWS_WEBVIEW_PROFILE;
  if (profile !== undefined && profile !== "" && !win32.isAbsolute(profile))
    throw new Error(
      "Refusing to run: MYCARLOS_WINDOWS_WEBVIEW_PROFILE must be an absolute path",
    );
}

/** What the erase step knows about the vault it is about to erase. */
export interface VaultEvidence {
  /** The vault is open: it was already unlocked by this run, or the FAKE passphrase opened it. */
  openedWithFakePassphrase: boolean;
  /** The people the library shows. */
  personNames: string[];
  /** The FAKE first person this run created it with. */
  firstPersonName: string;
}

/**
 * Whether the vault may be erased as the helper's own: it opened with the FAKE passphrase (a real
 * vault never does) AND it holds the FAKE first person this run made. Pure, so it is tested
 * anywhere. Anything else is refused, never erased.
 */
export function provesFakeVault(evidence: VaultEvidence): boolean {
  return (
    evidence.openedWithFakePassphrase &&
    evidence.firstPersonName.startsWith("FAKE") &&
    evidence.personNames.includes(evidence.firstPersonName)
  );
}

/**
 * A second look at a path just before it is deleted: it must be exactly the directory this run
 * created (`created`), after resolving, never a parent or a child. This is NOT the protection (the
 * protection is that the directory was made by `mkdtemp` or a failing-if-present `mkdir`); it
 * catches a bug that would pass some other path to the delete.
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
