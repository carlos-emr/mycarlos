// Guard test for safety.ts: pure, so it runs anywhere (also on Linux), unlike the journeys.
import { expect, test } from "@playwright/test";
import { refuseBackgroundMode } from "./appSession";
import {
  provesFakeVault,
  removableOwnDirectory,
  requireDisposableAccount,
} from "./safety";

const LOCAL = "C:\\Users\\runner\\AppData\\Local";
const hosted = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  LOCALAPPDATA: LOCAL,
};
const declared = {
  MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT: "1",
  LOCALAPPDATA: LOCAL,
};
const run = (env: Record<string, string | undefined>, platform = "win32") =>
  requireDisposableAccount({ platform, env });

test.describe("the native-windows journeys never touch a real account", () => {
  test("refuse on a Windows PC that is not disposable", () => {
    expect(() => run({ LOCALAPPDATA: LOCAL })).toThrow(/Refusing to run/);
    expect(() =>
      run({ MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT: "yes", LOCALAPPDATA: LOCAL }),
    ).toThrow(/Refusing to run/);
  });

  test("refuse off Windows even when marked disposable", () => {
    expect(() => run(hosted, "linux")).toThrow(/Windows only/);
  });

  test("a SELF-HOSTED runner is not disposable: GITHUB_ACTIONS alone is not enough", () => {
    expect(() => run({ GITHUB_ACTIONS: "true", LOCALAPPDATA: LOCAL })).toThrow(
      /Refusing to run/,
    );
    expect(() =>
      run({
        GITHUB_ACTIONS: "true",
        RUNNER_ENVIRONMENT: "self-hosted",
        LOCALAPPDATA: LOCAL,
      }),
    ).toThrow(/Refusing to run/);
  });

  test("run on a GitHub-hosted runner or a marked throw-away account", () => {
    expect(() => run(hosted)).not.toThrow();
    expect(() => run(declared)).not.toThrow();
  });

  test("an honoured test data home lets the journeys run on any account, but not off Windows or with a relative profile", () => {
    const honoured = (
      env: Record<string, string | undefined>,
      platform = "win32",
    ) => requireDisposableAccount({ platform, env, overrideHonoured: true });
    // Any account: nothing disposable is declared and LOCALAPPDATA is not even looked at.
    expect(() => honoured({})).not.toThrow();
    expect(() => honoured({ LOCALAPPDATA: "relative" })).not.toThrow();
    // Still Windows only, and an absolute WebView profile.
    expect(() => honoured({}, "linux")).toThrow(/Windows only/);
    expect(() =>
      honoured({ MYCARLOS_WINDOWS_WEBVIEW_PROFILE: "relative" }),
    ).toThrow(/must be an absolute path/);
    // Not honoured (a release build ignored the variable): back to the disposable-account rule.
    expect(() =>
      requireDisposableAccount({
        platform: "win32",
        env: { LOCALAPPDATA: LOCAL },
        overrideHonoured: false,
      }),
    ).toThrow(/Refusing to run/);
  });

  test("no playtest may turn background mode on: its login entry is not redirected", () => {
    expect(() => refuseBackgroundMode("background_set_keep_running")).toThrow(
      /Refusing/,
    );
    expect(() => refuseBackgroundMode("background_set_start_at_login")).toThrow(
      /Refusing/,
    );
    expect(() => refuseBackgroundMode("vault_snapshot")).not.toThrow();
  });

  test("refuse when LOCALAPPDATA is unset or relative, or the WebView profile is relative", () => {
    expect(() => run({ ...hosted, LOCALAPPDATA: undefined })).toThrow(
      /LOCALAPPDATA is not set/,
    );
    expect(() => run({ ...hosted, LOCALAPPDATA: "AppData\\Local" })).toThrow(
      /LOCALAPPDATA is not an absolute path/,
    );
    expect(() =>
      run({ ...hosted, MYCARLOS_WINDOWS_WEBVIEW_PROFILE: "webview-profile" }),
    ).toThrow(/must be an absolute path/);
    expect(() =>
      run({
        ...hosted,
        MYCARLOS_WINDOWS_WEBVIEW_PROFILE: "D:\\a\\_temp\\mycarlos-webview-1",
      }),
    ).not.toThrow();
  });

  test("a vault is erased only when it opened with the FAKE passphrase and holds the FAKE first person", () => {
    const fake = {
      openedWithFakePassphrase: true,
      personNames: ["FAKE Playtest Start", "FAKE Playtest Person"],
      firstPersonName: "FAKE Playtest Start",
    };
    expect(provesFakeVault(fake)).toBe(true);
    // A real vault does not open with the FAKE passphrase.
    expect(provesFakeVault({ ...fake, openedWithFakePassphrase: false })).toBe(
      false,
    );
    // A vault that opened but does not hold the FAKE first person is not ours.
    expect(provesFakeVault({ ...fake, personNames: ["Alex Realperson"] })).toBe(
      false,
    );
    expect(provesFakeVault({ ...fake, personNames: [] })).toBe(false);
    // The first person must itself be a FAKE name.
    expect(
      provesFakeVault({
        openedWithFakePassphrase: true,
        personNames: ["Alex Realperson"],
        firstPersonName: "Alex Realperson",
      }),
    ).toBe(false);
  });

  test("the last look before a delete accepts only the exact directory this run made", () => {
    const made = "/tmp/mycarlos-playtest-abc";
    expect(removableOwnDirectory(made, made)).toBe(true);
    expect(removableOwnDirectory(made, `${made}/`)).toBe(true);
    // Never a parent, a child, a sibling, something empty, or a vault home.
    expect(removableOwnDirectory(made, "/tmp")).toBe(false);
    expect(removableOwnDirectory(made, `${made}/vault-home`)).toBe(false);
    expect(removableOwnDirectory(made, "/tmp/mycarlos-playtest-abd")).toBe(
      false,
    );
    expect(removableOwnDirectory(made, "")).toBe(false);
    expect(removableOwnDirectory(undefined, made)).toBe(false);
    expect(
      removableOwnDirectory(
        made,
        "C:/Users/someone/AppData/Local/ca.carlos.mycarlos/vault-home",
      ),
    ).toBe(false);
  });
});
