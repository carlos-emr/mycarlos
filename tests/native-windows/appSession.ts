// Shared by the playtest journeys (tests/native-windows/playtests.spec.ts): launch the INSTALLED
// myCarlos (the real Rust bridge, a real WebView2), attach over CDP, call the real native commands,
// and drive the real Windows file dialogs with scripts/native-dialogs/windows.ps1.
//
// This file is only run on Windows. navigation.spec.ts keeps its own copy of the launch code
// (it asserts a few more things about the window and is a security test); this one is shorter and
// is for journeys. The two are deliberately not merged here, so that a playtest change can never
// weaken that security test.
import type {
  Browser,
  Page,
  PlaywrightWorkerArgs,
  TestInfo,
} from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { stopAppTree } from "./processTree";
import { removableOwnDirectory, requireDisposableAccount } from "./safety";

/** One native dialog step may take this long (the script keeps its own deadline 5 s inside). */
const NATIVE_STEP_TIMEOUT_MS = 30_000;

export interface AppSession {
  page: Page;
  appPid: number;
  /**
   * The running app said it is using the test data home this session gave it, so the account's own
   * vault folder is not involved (a debug build). False for a release or older build.
   */
  testHomeHonoured: boolean;
  /** Calls a native command as the page does: `args` is the whole argument object. */
  call<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T>;
  /**
   * Calls a native command that opens a real Windows dialog, operates the dialog with the native
   * driver (`action`: "file" types `value` into a Save or Open picker and presses its button;
   * "button" presses the named button; `title` is FILE_SAVE or FILE_OPEN for pickers, or the
   * dialog's title), and returns what the command answered, or the error it threw.
   */
  withDialog<T = unknown>(
    command: string,
    args: Record<string, unknown> | undefined,
    title: string,
    action: string,
    value?: string,
  ): Promise<{ ok: T } | { error: unknown }>;
  stop(): Promise<void>;
}

/**
 * Background mode (keep running after the window closes, start at login) writes a login entry
 * (HKCU Run) that the test data home does NOT redirect, so no playtest may turn it on. Refused
 * here, at the one place every command goes through.
 */
const BACKGROUND_MODE_COMMANDS = [
  "background_set_keep_running",
  "background_set_start_at_login",
];
export function refuseBackgroundMode(command: string) {
  if (BACKGROUND_MODE_COMMANDS.includes(command))
    throw new Error(
      `Refusing ${command}: background mode writes a login entry the test data home does not redirect`,
    );
}

const REFUSAL_FILE = "mycarlos-test-data-home-refused.txt";

/** The fixed reason a debug app wrote when it refused the test data home (no path), if any. */
async function refusalReason(): Promise<string> {
  try {
    return `: ${(await readFile(join(tmpdir(), REFUSAL_FILE), "utf8")).trim()}`;
  } catch {
    return "";
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string") throw new Error("No local port");
  return address.port;
}

export async function openInstalledApp(
  playwright: PlaywrightWorkerArgs["playwright"],
  testInfo: TestInfo,
): Promise<AppSession> {
  // The pre-launch checks of safety.ts (Windows, an absolute WebView profile). Whether the account
  // itself must be disposable is decided after launch, once the app says if it uses the test home.
  requireDisposableAccount({
    platform: process.platform,
    env: process.env,
    overrideHonoured: true,
  });
  const executable = process.env.MYCARLOS_WINDOWS_APP;
  if (!executable || !isAbsolute(executable))
    throw new Error("Set MYCARLOS_WINDOWS_APP to the installed executable");
  await access(executable);
  const policyProfile = process.env.MYCARLOS_WINDOWS_WEBVIEW_PROFILE;
  if (policyProfile) await mkdir(policyProfile);
  const createdProfile =
    policyProfile ?? (await mkdtemp(join(tmpdir(), "mycarlos-playtest-")));
  const profile = createdProfile;
  // A fresh EMPTY folder for the app's data (a debug build reads MYCARLOS_TEST_DATA_DIR, data_home.rs).
  const createdTestHome = await mkdtemp(join(tmpdir(), "mycarlos-test-home-"));
  const testHome = createdTestHome;
  // A reason left by an earlier run must not be mistaken for this one's.
  await rm(join(tmpdir(), REFUSAL_FILE), { force: true });
  const port =
    Number(process.env.MYCARLOS_WINDOWS_CDP_PORT) || (await freePort());
  // Fake camera and microphone for the media journey: only honoured when the harness is not the
  // elevated CI host (which reads the HKLM policy instead: the workflow diff in the PR says how).
  const media =
    process.env.MYCARLOS_WINDOWS_FAKE_MEDIA === "1"
      ? // Two fake cameras, so a journey can switch between them.
        " --use-fake-device-for-media-stream=device-count=2 --use-fake-ui-for-media-stream"
      : "";
  const app = spawn(executable, [], {
    shell: false,
    stdio: "ignore",
    env: {
      ...process.env,
      MYCARLOS_TEST_DATA_DIR: testHome,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1${media}`,
      WEBVIEW2_USER_DATA_FOLDER: profile,
    },
  });
  let launchError: Error | undefined;
  app.on("error", (error) => {
    launchError = error;
  });
  const exited = new Promise<void>((done) => app.once("exit", () => done()));
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 45_000;
  for (;;) {
    if (launchError) throw launchError;
    if (app.exitCode !== null)
      throw new Error(
        `App exited before WebView2 was ready${await refusalReason()}`,
      );
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline)
      throw new Error("WebView2 did not start in 45 s");
    await new Promise((done) => setTimeout(done, 500));
  }
  const browser: Browser = await playwright.chromium.connectOverCDP(endpoint);
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(10_000);
  await page.waitForFunction(() => "__TAURI_INTERNALS__" in window);

  const call = <T>(command: string, args: Record<string, unknown> = {}) => {
    refuseBackgroundMode(command);
    return page.evaluate(
      ([name, body]) =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: {
              invoke: (name: string, body: unknown) => Promise<unknown>;
            };
          }
        ).__TAURI_INTERNALS__.invoke(name, body),
      [command, args] as const,
    ) as Promise<T>;
  };

  const driver = async (title: string, action: string, value?: string) =>
    JSON.parse(
      (
        await promisify(execFile)(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("scripts/native-dialogs/windows.ps1"),
            "-AppPid",
            String(app.pid),
            "-Title",
            title,
            "-Action",
            action,
            ...(value ? ["-Value", value] : []),
            "-TimeoutSeconds",
            String(NATIVE_STEP_TIMEOUT_MS / 1000),
          ],
          { timeout: NATIVE_STEP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        )
      ).stdout,
    );

  let serial = 0;
  const session: AppSession = {
    page,
    appPid: app.pid!,
    testHomeHonoured: false,
    call,
    async withDialog(command, args, title, action, value) {
      refuseBackgroundMode(command);
      const id = `playtest-${++serial}`;
      // Start the command WITHOUT waiting: the dialog is open while Rust awaits it, and the
      // driver below must operate it from outside the page.
      await page.evaluate(
        ([key, name, body]) => {
          const host = window as unknown as {
            __playtest?: Record<string, Promise<unknown>>;
            __TAURI_INTERNALS__: {
              invoke: (name: string, body: unknown) => Promise<unknown>;
            };
          };
          host.__playtest ??= {};
          host.__playtest[key] = host.__TAURI_INTERNALS__
            .invoke(name, body)
            .then(
              (ok) => ({ ok }),
              (error) => ({ error }),
            );
        },
        [id, command, args ?? {}] as const,
      );
      await driver(title, action, value);
      return page.evaluate(
        (key) =>
          (
            window as unknown as {
              __playtest: Record<string, Promise<unknown>>;
            }
          ).__playtest[key],
        id,
      ) as Promise<{ ok: never } | { error: unknown }>;
    },
    async stop() {
      try {
        if (app.pid && app.exitCode === null && app.signalCode === null)
          await stopAppTree(
            app.pid,
            (file, args) =>
              promisify(execFile)(file, args, { timeout: 10_000 }),
            () =>
              Promise.race([
                exited.then(() => true),
                new Promise<boolean>((done) =>
                  setTimeout(() => done(false), 10_000),
                ),
              ]),
            {
              rootGone: async () => {
                try {
                  process.kill(app.pid!, 0);
                  return false;
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code === "ESRCH";
                }
              },
              describeApp: () => `exitCode=${app.exitCode}`,
            },
          );
      } finally {
        await browser.close().catch(() => {});
        // Only the WebView profile directory this run created, by path equality.
        if (removableOwnDirectory(createdProfile, profile))
          await rm(profile, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
          });
        // The test data home this run made (by mkdtemp), after the app has stopped using it.
        if (removableOwnDirectory(createdTestHome, testHome))
          await rm(testHome, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
          });
        void testInfo;
      }
    },
  };

  // Ask the RUNNING app whether it really uses the test data home, before anything is created:
  // a release build, or an older one, ignores the variable and would act on the account's own
  // folder. Then let the guard decide (safety.ts); if it refuses, stop the app first.
  try {
    const info = await call<{ testDataHome?: boolean }>("runtime_info");
    session.testHomeHonoured = info.testDataHome === true;
    requireDisposableAccount({
      platform: process.platform,
      env: process.env,
      overrideHonoured: session.testHomeHonoured,
    });
  } catch (error) {
    await session.stop().catch(() => {});
    throw error;
  }
  return session;
}
