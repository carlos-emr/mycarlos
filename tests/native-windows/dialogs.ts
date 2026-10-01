import { expect, type Page, type TestInfo } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

type Request = { id: number; action: string; title: string; value: string };
type State = {
  done: boolean;
  error?: string;
  request?: Request;
  results: { action: string; dismissedByKey: boolean }[];
};

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
  // Start asynchronously: the host must keep polling while Rust awaits a dialog.
  await page.evaluate(
    `${source}\nvoid runDialogScenarios({backupPath:${JSON.stringify(backupPath)}});`,
  );
  let last = 0;
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const state = (await page.evaluate("window.__nativeDialogTest")) as State;
    await writeFile(
      testInfo.outputPath("native-dialogs.json"),
      JSON.stringify(state, null, 2),
    );
    if (state.done) {
      expect(state.error, "Native dialog scenarios").toBeUndefined();
      expect(state.results).toHaveLength(30);
      for (const result of state.results.filter(
        (result) => result.action === "enter",
      ))
        expect(
          result.dismissedByKey,
          "Windows Enter must activate its safe default",
        ).toBe(true);
      return;
    }
    const request = state.request;
    if (request && request.id !== last) {
      last = request.id;
      let reply: { id: number; value?: unknown; error?: string };
      try {
        const value =
          request.action === "fingerprint"
            ? await fingerprint(vault)
            : JSON.parse(
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
                      request.title,
                      "-Action",
                      request.action,
                      ...(request.value ? ["-Value", request.value] : []),
                    ],
                    { timeout: 30_000, maxBuffer: 1024 * 1024 },
                  )
                ).stdout,
              );
        reply = { id: last, value };
      } catch (error) {
        reply = { id: last, error: String(error) };
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
