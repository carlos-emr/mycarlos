// Guard test for safety.ts: pure, so it runs anywhere (also on Linux), unlike the journeys.
import { expect, test } from "@playwright/test";
import { removableOwnDirectory, requireDisposableAccount } from "./safety";

test.describe("the native-windows journeys never touch a real account", () => {
  test("refuse on a Windows PC that is not disposable", () => {
    expect(() =>
      requireDisposableAccount({ platform: "win32", env: {} }),
    ).toThrow(/Refusing to run/);
    expect(() =>
      requireDisposableAccount({
        platform: "win32",
        env: { MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT: "yes" },
      }),
    ).toThrow(/Refusing to run/);
  });

  test("refuse off Windows even when marked disposable", () => {
    expect(() =>
      requireDisposableAccount({
        platform: "linux",
        env: { GITHUB_ACTIONS: "true" },
      }),
    ).toThrow(/Windows only/);
  });

  test("run on a GitHub Actions runner or a marked throw-away account", () => {
    expect(() =>
      requireDisposableAccount({
        platform: "win32",
        env: { GITHUB_ACTIONS: "true" },
      }),
    ).not.toThrow();
    expect(() =>
      requireDisposableAccount({
        platform: "win32",
        env: { MYCARLOS_PLAYTEST_DISPOSABLE_ACCOUNT: "1" },
      }),
    ).not.toThrow();
  });

  test("cleanup may remove only the exact directory it created", () => {
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
