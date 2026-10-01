import { expect, test, type Browser, type Page } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No local port");
  return address.port;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function invoke(page: Page, command: string) {
  return page.evaluate((name) => {
    const native = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (name: string) => Promise<unknown> };
    };
    return native.__TAURI_INTERNALS__.invoke(name);
  }, command);
}

test("installed app keeps navigation and popups inside its native boundary", async ({
  playwright,
}, testInfo) => {
  // A wrong runner must fail, rather than silently report a skipped security test.
  expect(process.platform, "Run this suite on Windows").toBe("win32");
  const executable = process.env.MYCARLOS_WINDOWS_APP;
  expect(
    executable,
    "Set MYCARLOS_WINDOWS_APP to the installed executable",
  ).toBeTruthy();
  expect(isAbsolute(executable!)).toBe(true);
  await access(executable!);

  // CI sets matching machine-policy values for its elevated WebView2 host.
  // Refuse an existing directory so cleanup can only remove a profile we created.
  const policyProfile = process.env.MYCARLOS_WINDOWS_WEBVIEW_PROFILE;
  if (policyProfile) {
    expect(isAbsolute(policyProfile)).toBe(true);
    await mkdir(policyProfile);
  }
  const profile =
    policyProfile ?? (await mkdtemp(join(tmpdir(), "mycarlos-webview-test-")));
  const requests: string[] = [];
  const sink = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Untrusted test destination</title>");
  });
  let browser: Browser | undefined;
  let tracing = false;
  let safeToCapture = false;
  const errors: unknown[] = [];
  let app: ReturnType<typeof spawn> | undefined;
  let launchError: Error | undefined;
  let appExited: Promise<void> | undefined;
  try {
    const sinkPort = await listen(sink);
    const outside = `http://127.0.0.1:${sinkPort}/navigation-canary`;
    // Verify that the request detector works before testing for zero requests.
    await fetch(outside);
    expect(requests).toEqual(["GET /navigation-canary"]);
    requests.length = 0;

    let debugPort = Number(process.env.MYCARLOS_WINDOWS_CDP_PORT);
    if (process.env.MYCARLOS_WINDOWS_CDP_PORT) {
      expect(
        Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536,
      ).toBe(true);
    } else {
      const reservation = createServer();
      debugPort = await listen(reservation);
      await close(reservation);
    }
    const endpoint = `http://127.0.0.1:${debugPort}`;
    app = spawn(executable!, [], {
      shell: false,
      stdio: "ignore",
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
        WEBVIEW2_USER_DATA_FOLDER: profile,
      },
    });
    app.on("error", (error) => {
      launchError = error;
    });
    appExited = new Promise((resolve) => app!.once("exit", () => resolve()));
    await test.step("launch installed app and attach to WebView2", async () => {
      await expect
        .poll(
          async () => {
            if (launchError) throw launchError;
            expect(
              app!.exitCode,
              "App exited before WebView2 was ready",
            ).toBeNull();
            try {
              const response = await fetch(`${endpoint}/json/version`, {
                signal: AbortSignal.timeout(1000),
              });
              return response.ok;
            } catch {
              return false;
            }
          },
          { timeout: 45_000 },
        )
        .toBe(true);
      browser = await playwright.chromium.connectOverCDP(endpoint);
    });
    expect(browser!.contexts()).toHaveLength(1);
    const context = browser!.contexts()[0];
    await expect.poll(() => context.pages().length).toBe(1);
    const page = context.pages()[0];
    page.setDefaultTimeout(10_000);
    const origin = "http://tauri.localhost";
    await expect.poll(() => page.url()).toMatch(/^http:\/\/tauri\.localhost\//);
    await page.waitForFunction(() => "__TAURI_INTERNALS__" in window);
    await test.step("native IPC works with no existing vault", async () => {
      // A fresh WebView profile does not relocate Rust's vault. Use a disposable
      // Windows account (as CI does); never create, unlock, or delete a vault here.
      expect(
        await invoke(page, "vault_status"),
        "Requires an empty test account",
      ).toBe("absent");
      expect(await invoke(page, "runtime_info")).toMatchObject({
        platform: "windows",
      });
      safeToCapture = true;
      await expect(
        page.getByRole("heading", { name: "Create your encrypted vault" }),
      ).toBeVisible();
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    tracing = true;
    const escaped: string[] = [];
    const popups: Page[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && new URL(frame.url()).origin !== origin)
        escaped.push(frame.url());
    });
    context.on("page", (popup) => popups.push(popup));
    await test.step("bundled pages can reload and still call Rust", async () => {
      await page.goto(`${origin}/index.html?navigation-smoke=1`);
      await expect(
        page.getByRole("heading", { name: "Create your encrypted vault" }),
      ).toBeVisible();
      expect(await invoke(page, "vault_status")).toBe("absent");
    });
    const bundledUrl = page.url();
    await page.evaluate(() => {
      document.documentElement.dataset.navigationMarker = "original-document";
    });
    const assertContained = async () => {
      // A refused navigation has no load event to await. Allow native navigation
      // and popup callbacks to run, and retain events to catch transient escapes.
      await page.waitForTimeout(750);
      expect(escaped, "No transient external navigation").toEqual([]);
      expect(popups, "No additional webviews").toEqual([]);
      expect(context.pages()).toHaveLength(1);
      expect(page.url()).toBe(bundledUrl);
      expect(
        await page.evaluate(
          () => document.documentElement.dataset.navigationMarker,
        ),
      ).toBe("original-document");
      expect(requests, "No request reached the untrusted destination").toEqual(
        [],
      );
    };
    const targets = [
      outside,
      "https://example.invalid/navigation-canary",
      "http://localhost:1420/",
      `http://tauri.localhost:${sinkPort}/`,
      "http://tauri.localhost.example.invalid/",
      "http://user@tauri.localhost/",
      "tauri://localhost/",
      "data:text/html,<title>Untrusted</title>",
      "about:blank",
    ];
    for (const target of targets) {
      await test.step(`refuse location navigation to ${target}`, async () => {
        await page.evaluate((url) => {
          window.location.href = url;
        }, target);
        await assertContained();
      });
    }
    for (const [target, newWindow] of [
      [outside, false],
      [outside, true],
      [origin, true],
    ] as const) {
      await test.step(`refuse clicked ${newWindow ? "popup" : "link"} to ${target}`, async () => {
        await page.evaluate(
          ({ url, popup }) => {
            const link = document.createElement("a");
            link.id = "navigation-probe";
            link.textContent = "Synthetic navigation probe";
            link.href = url;
            if (popup) link.target = "_blank";
            document.body.prepend(link);
          },
          { url: target, popup: newWindow },
        );
        await page.locator("#navigation-probe").click({ noWaitAfter: true });
        await assertContained();
        await page
          .locator("#navigation-probe")
          .evaluate((link) => link.remove());
      });
    }
    await test.step("app and native IPC still work after refused navigation", async () => {
      await assertContained();
      expect(await invoke(page, "vault_status")).toBe("absent");
      await expect(
        page.getByRole("heading", { name: "Create your encrypted vault" }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("native-window.png") });
    });
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      const context = browser?.contexts()[0];
      if (safeToCapture && errors.length) {
        await context
          ?.pages()[0]
          ?.screenshot({
            path: testInfo.outputPath("failure.png"),
            timeout: 5000,
          })
          .catch(() => {});
      }
      if (tracing)
        await bounded(
          context!.tracing.stop({ path: testInfo.outputPath("trace.zip") }),
          "Trace capture",
        );
    } catch (error) {
      errors.push(error);
    } finally {
      // Kill only the process tree launched above, including its WebView children.
      // Stop it before disconnecting CDP so the native PID still owns that tree.
      try {
        if (app?.pid && app.exitCode === null && app.signalCode === null) {
          await promisify(execFile)(
            "taskkill",
            ["/PID", String(app.pid), "/T", "/F"],
            { timeout: 10_000 },
          );
          await bounded(appExited!, "App shutdown");
        }
      } catch (error) {
        errors.push(error);
      } finally {
        // Attempt each cleanup even if the native process closed CDP first.
        const cleanup = await Promise.allSettled([
          bounded(browser?.close() ?? Promise.resolve(), "CDP disconnect"),
          sink.listening
            ? bounded(close(sink), "Local server shutdown")
            : Promise.resolve(),
          rm(profile, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 200,
          }),
        ]);
        errors.push(
          ...cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          ),
        );
      }
    }
  }
  // Keep the first assertion/startup failure as Playwright's primary error.
  // Cleanup failures still fail a successful test, and remain visible alongside
  // an earlier failure instead of replacing it from inside a finally block.
  for (const error of errors.slice(1))
    console.error("Additional cleanup failure:", error);
  if (errors.length) throw errors[0];
});
