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
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  // Refuse before anything is started (safety.ts): the app has no data-home override, so a journey
  // acts on this account's own vault folder and may only run on a disposable account.
  requireDisposableAccount({ platform: process.platform, env: process.env });
  const executable = process.env.MYCARLOS_WINDOWS_APP;
  if (!executable || !isAbsolute(executable))
    throw new Error("Set MYCARLOS_WINDOWS_APP to the installed executable");
  await access(executable);
  const policyProfile = process.env.MYCARLOS_WINDOWS_WEBVIEW_PROFILE;
  if (policyProfile) await mkdir(policyProfile);
  const createdProfile =
    policyProfile ?? (await mkdtemp(join(tmpdir(), "mycarlos-playtest-")));
  const profile = createdProfile;
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
      throw new Error("App exited before WebView2 was ready");
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

  const call = <T>(command: string, args: Record<string, unknown> = {}) =>
    page.evaluate(
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
  return {
    page,
    appPid: app.pid!,
    call,
    async withDialog(command, args, title, action, value) {
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
        void testInfo;
      }
    },
  };
}
