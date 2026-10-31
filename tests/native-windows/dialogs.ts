import { expect, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { translate } from "../support/fluent";

type Request = { id: number; action: string; title: string; value: string };
type State = {
  done: boolean;
  error?: string;
  request?: Request;
  results: { action: string; dismissedByKey: boolean }[];
};

/** How long one native dialog step may take before it is killed. The
 * script is told it, and keeps its own deadline 5 s inside, so that it can
 * say why. */
const NATIVE_STEP_TIMEOUT_MS = 30_000;

async function fingerprint(directory: string): Promise<[string, string][]> {
  const result: Record<string, string> = {};
  async function visit(path: string, prefix = "") {
    const entries = await readdir(path, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (entry.isDirectory())
        await visit(join(path, entry.name), relative + "/");
      else if (entry.isFile())
        result[relative] = createHash("sha256")
          .update(await readFile(join(path, entry.name)))
          .digest("hex");
      else throw new Error(`Unexpected vault entry: ${relative}`);
    }
  }
  await visit(directory);
  expect(
    Object.keys(result).length,
    "Must fingerprint an actual vault",
  ).toBeGreaterThan(0);
  return Object.entries(result);
}

export async function testNativeDialogs(
  page: Page,
  appPid: number,
  testInfo: TestInfo,
) {
  // Explicit opt-in: this test creates and erases SYNTHETIC data in the account's
  // native vault directory. The caller has already asserted vault_status=absent.
  expect(process.env.LOCALAPPDATA).toBeTruthy();
  const vault = join(
    process.env.LOCALAPPDATA!,
    "ca.carlos.mycarlos",
    "vault-home",
    "vault-v1",
  );
  const source = (
    await readFile("scripts/native-dialogs/scenarios.mjs", "utf8")
  ).replace("export async function", "async function");
  const backupPath = testInfo.outputPath("synthetic.mycarlosbackup");
  const native = async (title: string, action: string, value?: string) =>
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
            String(appPid),
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
  // Start asynchronously: the host must keep polling while Rust awaits a dialog.
  await page.evaluate(
    `${source}\nvoid runDialogScenarios({backupPath:${JSON.stringify(backupPath)}});`,
  );
  let last = 0;
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const state = (await page.evaluate("window.__nativeDialogTest")) as State;
    try {
      await writeFile(
        testInfo.outputPath("native-dialogs.json"),
        JSON.stringify(state, null, 2),
      );
    } catch (error) {
      if (!state.error) throw error;
      console.error("Additional native dialog evidence failure:", error);
    }
    if (state.done) {
      if (state.error) {
        try {
          const diagnostic = await native("DIAGNOSTIC", "inspect");
          await writeFile(
            testInfo.outputPath("native-dialog-failure.json"),
            JSON.stringify(diagnostic, null, 2),
          );
        } catch (error) {
          console.error("Additional native dialog diagnostic failure:", error);
        }
      }
      expect(state.error, "Native dialog scenarios").toBeUndefined();
      expect(state.results).toHaveLength(30);
      for (const result of state.results.filter(
        (result) => result.action === "enter",
      ))
        expect(
          result.dismissedByKey,
          "Windows Enter must activate its safe default",
        ).toBe(true);
      // Keep the synthetic key out of the polled state and native-dialogs.json.
      // The existing uninterrupted trace may record this entirely synthetic flow.
      let recoveryKey = await page.evaluate(() => {
        const host = window as unknown as {
          __nativeDialogUiFixture?: { recoveryKey?: string };
        };
        const key = host.__nativeDialogUiFixture?.recoveryKey;
        delete host.__nativeDialogUiFixture;
        return key;
      });
      if (typeof recoveryKey !== "string" || !recoveryKey)
        throw new Error("Synthetic backup recovery key is missing");
      try {
        await page.reload();
        await expect(
          page.getByRole("heading", {
            name: "Make myCarlos comfortable for you",
            exact: true,
          }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: "Set up myCarlos on this computer",
            exact: true,
          }),
        ).toBeVisible();
        await page.getByText("Restore from a backup", { exact: true }).click();
        const restore = page.locator("form.restore-backup");
        // The real native picker can hold CDP's click pending until it closes.
        const picked = await Promise.allSettled([
          restore
            .getByRole("button", { name: "Choose backup file…", exact: true })
            .click(),
          native("FILE_OPEN", "file", backupPath),
        ]);
        for (const result of picked)
          if (result.status === "rejected") throw result.reason;
        const useKey = restore.getByRole("radio", {
          name: "Its recovery key",
          exact: true,
        });
        await useKey.check();
        await expect(useKey).toBeChecked();
        await restore
          .getByLabel("Recovery key", { exact: true })
          .fill(recoveryKey);
        await restore
          .getByRole("button", { name: "Check backup", exact: true })
          .click();
        await expect(restore.getByRole("status")).toHaveText(
          translate("en", "restore.checked", {
            count: 1,
            consequence: translate("en", "restore.consequence.nothing"),
          }),
        );
        const submit = restore.getByRole("button", {
          name: "Restore backup",
          exact: true,
        });
        await expect(submit).toBeEnabled();
        await submit.click();
        await expect(
          page.getByText(
            "Backup restored. Unlock it with the passphrase it was made with, or use its recovery key.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Unlock your vault", exact: true }),
        ).toBeVisible();
        const records = page.getByRole("heading", {
          name: "My records",
          exact: true,
        });
        await expect(records).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath("native-key-backup-restored-locked.png"),
        });

        await page
          .getByText("Forgot your passphrase?", { exact: true })
          .click();
        const recover = page.locator("form").filter({
          has: page.getByRole("button", {
            name: "Open with recovery key",
            exact: true,
          }),
        });
        await recover
          .getByLabel("Recovery key", { exact: true })
          .fill(recoveryKey);
        const newPassphrase = "velvet heron meadow quartz lantern 842!";
        await recover
          .getByLabel("New passphrase", { exact: true })
          .fill(newPassphrase);
        await recover
          .getByLabel("Confirm new passphrase", { exact: true })
          .fill(newPassphrase);
        await recover
          .getByRole("button", { name: "Open with recovery key", exact: true })
          .click();
        await expect(records).toBeVisible();
        const photoName = "Photo, 1 Jan 2026, 9.00 AM.jpg";
        await page
          .getByRole("button", { name: photoName, exact: true })
          .click();
        const details = page.getByRole("dialog", {
          name: photoName,
          exact: true,
        });
        await details
          .getByRole("button", { name: "View photo", exact: true })
          .click();
        const viewer = page.getByRole("dialog", {
          name: photoName,
          exact: true,
        });
        const photo = viewer.getByRole("img", {
          name: translate("en", "photo.alt", { name: photoName }),
          exact: true,
        });
        await expect(photo).toBeVisible();
        await expect
          .poll(() =>
            photo.evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        await page.screenshot({
          path: testInfo.outputPath("native-key-backup-restored-photo.png"),
        });
        await viewer
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(photo).toHaveCount(0);
        await expect(
          details.getByRole("button", { name: "View photo", exact: true }),
        ).toBeVisible();
        await details
          .getByRole("button", { name: "Close document details", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Unlocked · Lock now", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Unlock your vault", exact: true }),
        ).toBeVisible();
        await expect(records).toHaveCount(0);
        await page
          .getByLabel("Passphrase", { exact: true })
          .fill(newPassphrase);
        await page.getByRole("button", { name: "Unlock", exact: true }).click();
        await expect(records).toBeVisible();
        await expect(
          page.getByRole("button", { name: photoName, exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Unlocked · Lock now", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Unlock your vault", exact: true }),
        ).toBeVisible();
        await expect(records).toHaveCount(0);

        // Set aside only this synthetic vault through the real UI and owned dialog.
        await page
          .getByText("Forgot your passphrase?", { exact: true })
          .click();
        await page
          .getByLabel(
            translate("en", "reset.type", { phrase: "RESET MYCARLOS VAULT" }),
            { exact: true },
          )
          .fill("RESET MYCARLOS VAULT");
        const cleaned = await Promise.allSettled([
          page
            .getByRole("button", { name: "Set vault aside", exact: true })
            .click(),
          native(
            "Set this myCarlos vault aside and start again?",
            "button",
            "Set it aside",
          ),
        ]);
        for (const result of cleaned)
          if (result.status === "rejected") throw result.reason;
        await expect
          .poll(() =>
            page.evaluate(() => {
              const host = window as unknown as {
                __TAURI_INTERNALS__: {
                  invoke: (command: string) => Promise<unknown>;
                };
              };
              return host.__TAURI_INTERNALS__.invoke("vault_status");
            }),
          )
          .toBe("absent");
      } finally {
        recoveryKey = undefined;
      }
      return;
    }
    const request = state.request;
    if (request && request.id !== last) {
      last = request.id;
      let reply: { id: number; value?: unknown; error?: string };
      try {
        if (request.action === "file" && request.title === "FILE_OPEN") {
          expect(request.value).toBe(backupPath);
          const backup = await stat(backupPath);
          expect(
            backup.isFile(),
            "Backup must exist at its requested path",
          ).toBe(true);
          expect(backup.size, "Backup must contain ciphertext").toBeGreaterThan(
            0,
          );
        }
        const value =
          request.action === "fingerprint"
            ? await fingerprint(vault)
            : await native(request.title, request.action, request.value);
        reply = { id: last, value };
      } catch (error) {
        // The script is killed at its limit, with nothing on stderr.
        const killed = (error as { killed?: boolean } | null)?.killed;
        reply = {
          id: last,
          error:
            String(error) +
            (killed
              ? ` (timed out after ${NATIVE_STEP_TIMEOUT_MS / 1000} s)`
              : ""),
        };
      }
      await page.evaluate((reply) => {
        const native = window as unknown as {
          __nativeDialogTest: { reply: unknown };
        };
        native.__nativeDialogTest.reply = reply;
      }, reply);
    }
    await page.waitForTimeout(100);
  }
  throw new Error("Native dialog scenarios exceeded seven minutes");
}
