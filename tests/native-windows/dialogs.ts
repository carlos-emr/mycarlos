import { expect, test, type Page, type TestInfo } from "@playwright/test";
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
      let ownsFollowupVault = false;
      // Unlike UI actions, page.evaluate has no per-call timeout. Bound
      // follow-up IPC too, so a hung native call cannot hide the first error.
      const followupCommand = async (
        command: "vault_status" | "vault_lock",
      ) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            page.evaluate((command) => {
              const host = window as unknown as {
                __TAURI_INTERNALS__: {
                  invoke: (command: string) => Promise<unknown>;
                };
              };
              return host.__TAURI_INTERNALS__.invoke(command);
            }, command),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Follow-up ${command} timed out`)),
                NATIVE_STEP_TIMEOUT_MS,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const restoreOwnedBackup = async () => {
        if (typeof recoveryKey !== "string" || !recoveryKey)
          throw new Error("Synthetic backup recovery key is missing");
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
        // The caller requires an empty disposable account. This follow-up
        // creates a vault only from the owned backup just picked and checked.
        // Recheck absence before allowing either restore or failure cleanup.
        expect(await followupCommand("vault_status")).toBe("absent");
        ownsFollowupVault = true;
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
      };
      const cleanupAndRethrow = async (failure: unknown): Promise<never> => {
        if (ownsFollowupVault) {
          try {
            const status = await followupCommand("vault_status");
            if (status !== "absent") {
              if (status !== "locked" && status !== "unlocked")
                throw new Error("Unknown owned synthetic vault status");
              await followupCommand("vault_lock");
              await page.reload({ timeout: NATIVE_STEP_TIMEOUT_MS });
              await expect(
                page.getByRole("heading", {
                  name: "Unlock your vault",
                  exact: true,
                }),
              ).toBeVisible();
              await page
                .getByText("Forgot your passphrase?", { exact: true })
                .click();
              await page
                .getByLabel(
                  translate("en", "reset.type", {
                    phrase: "RESET MYCARLOS VAULT",
                  }),
                  { exact: true },
                )
                .fill("RESET MYCARLOS VAULT");
              const cleanedAfterFailure = await Promise.allSettled([
                page
                  .getByRole("button", {
                    name: "Set vault aside",
                    exact: true,
                  })
                  .click(),
                native(
                  "Set this myCarlos vault aside and start again?",
                  "button",
                  "Set it aside",
                ),
              ]);
              for (const result of cleanedAfterFailure)
                if (result.status === "rejected") throw result.reason;
              await expect
                .poll(() => followupCommand("vault_status"))
                .toBe("absent");
            }
          } catch (cleanupFailure) {
            // Preserve the actual test failure even if the app or OS dialog
            // cannot be used for best-effort cleanup. Outer teardown still
            // stops only the owned app process tree.
            console.error(
              "Additional owned synthetic vault cleanup failure:",
              cleanupFailure,
            );
          }
        }
        throw failure;
      };
      try {
        await restoreOwnedBackup();
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
          // The window's own Lock now, named by its words (#121).
          .locator(".titlebar")
          .getByRole("button", { name: "Lock now", exact: true })
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
        // Read a public FAKE PDF through the installed app and its own helper.
        const pdfPath = resolve(
          "src-tauri/tests/fixtures/locked-pdf/text-original.pdf",
        );
        expect(
          createHash("sha256")
            .update(await readFile(pdfPath))
            .digest("hex"),
          "The documented synthetic two-page PDF fixture",
        ).toBe(
          "41e61a36137b8f4c79a284a73adb36d634708625831c88c60e05e961756d51a9",
        );
        const imported = await Promise.allSettled([
          page
            .getByRole("button", {
              name: translate("en", "interface.VaultApp.chooseFilesToImport"),
              exact: true,
            })
            .click(),
          native("FILE_OPEN", "file", pdfPath),
        ]);
        for (const result of imported)
          if (result.status === "rejected") throw result.reason;
        await expect(
          page.getByText(
            translate("en", "interface.notice.imported", { count: 1 }),
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        const pdfName = "text-original.pdf";
        const pdfRow = page.getByRole("button", { name: pdfName, exact: true });
        await expect(pdfRow).toBeVisible();
        await pdfRow.click();
        const pdfDetails = page.getByRole("dialog", {
          name: pdfName,
          exact: true,
        });
        await pdfDetails
          .getByRole("button", {
            name: translate("en", "interface.RecordDetails.read"),
            exact: true,
          })
          .click();
        const reader = page.getByRole("dialog", { name: pdfName, exact: true });
        const picture = reader.getByRole("img", {
          name: translate("en", "interface.reader.textFollows", {
            page: 1,
            total: 2,
          }),
          exact: true,
        });
        const pageArea = reader.getByRole("region", {
          name: translate("en", "interface.reader.page", { page: 1 }),
          exact: true,
        });
        const where = translate("en", "interface.reader.where", {
          page: 1,
          total: 2,
        });
        await expect(picture).toBeVisible();
        await expect(reader.getByRole("status")).toHaveText(where);
        await expect(pageArea).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            picture.evaluate(
              (image: HTMLImageElement) =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0,
            ),
          )
          .toBe(true);
        await expect(
          reader.getByText(
            translate("en", "interface.reader.zoom", { percent: 100 }),
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        await reader
          .getByText(
            translate("en", "interface.DocumentReader.textOnThisPage"),
            {
              exact: true,
            },
          )
          .click();
        const pageText = reader.locator(".native-reader-text div");
        await expect(pageText).toBeVisible();
        await expect(pageText).toContainText(
          "FAKE Clinic - test document, not a real record",
        );
        await expect(pageText).toContainText(
          "FAKE Hemoglobin 140 g/L (made-up value)",
        );
        await expect(pageText).toContainText("Page 1 of 2");
        const firstPageSource = await picture.getAttribute("src");
        if (!firstPageSource)
          throw new Error("The first rendered PDF page is missing");
        await reader
          .getByRole("button", {
            name: translate("en", "interface.DocumentReader.nextPage"),
            exact: true,
          })
          .click();
        const secondPicture = reader.getByRole("img", {
          name: translate("en", "interface.reader.textFollows", {
            page: 2,
            total: 2,
          }),
          exact: true,
        });
        await expect(secondPicture).toBeVisible();
        await expect(reader.getByRole("status")).toHaveText(
          translate("en", "interface.reader.where", { page: 2, total: 2 }),
        );
        await expect(
          reader.getByRole("region", {
            name: translate("en", "interface.reader.page", { page: 2 }),
            exact: true,
          }),
        ).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            secondPicture.evaluate(
              (image: HTMLImageElement, first) =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0 &&
                image.src !== first,
              firstPageSource,
            ),
          )
          .toBe(true);
        await reader
          .getByText(
            translate("en", "interface.DocumentReader.textOnThisPage"),
            {
              exact: true,
            },
          )
          .click();
        await expect(pageText).toBeVisible();
        await expect(pageText).toContainText("Page 2 of 2");
        await expect(pageText).not.toContainText("Page 1 of 2");
        await reader
          .getByRole("button", {
            name: translate("en", "interface.DocumentReader.previousPage"),
            exact: true,
          })
          .click();
        await expect(picture).toBeVisible();
        await expect(reader.getByRole("status")).toHaveText(where);
        await expect(pageArea).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            picture.evaluate(
              (image: HTMLImageElement) =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0,
            ),
          )
          .toBe(true);
        await reader
          .getByText(
            translate("en", "interface.DocumentReader.textOnThisPage"),
            {
              exact: true,
            },
          )
          .click();
        await expect(pageText).toBeVisible();
        await expect(pageText).toContainText("Page 1 of 2");
        await expect(pageText).not.toContainText("Page 2 of 2");
        const fitted = await picture.evaluate((image: HTMLImageElement) => ({
          raster: image.naturalWidth,
          css: image.getBoundingClientRect().width,
        }));
        await reader
          .getByRole("button", {
            name: translate("en", "interface.DocumentReader.larger"),
            exact: true,
          })
          .click();
        await expect(
          reader.getByText(
            translate("en", "interface.reader.zoom", { percent: 125 }),
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        // Scaling the old image is not enough: await the helper's sharper raster.
        await expect
          .poll(() =>
            picture.evaluate((image: HTMLImageElement) =>
              image.complete ? image.naturalWidth : 0,
            ),
          )
          .toBeGreaterThan(fitted.raster);
        await expect(reader.getByRole("status")).toHaveText(where);
        await expect(pageArea).toHaveAttribute("aria-busy", "false");
        expect(
          await picture.evaluate(
            (image) => image.getBoundingClientRect().width,
          ),
        ).toBeGreaterThan(fitted.css);
        await page.screenshot({
          path: testInfo.outputPath("native-pdf-reader-enlarged.png"),
        });
        const fit = reader.getByRole("button", {
          name: translate("en", "interface.DocumentReader.fitWidth"),
          exact: true,
        });
        await fit.click();
        await expect(
          reader.getByText(
            translate("en", "interface.reader.zoom", { percent: 100 }),
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        await expect(fit).toBeDisabled();
        await expect
          .poll(() =>
            picture.evaluate((image: HTMLImageElement) =>
              image.complete ? image.naturalWidth : 0,
            ),
          )
          .toBe(fitted.raster);
        await expect(reader.getByRole("status")).toHaveText(where);
        await expect(pageArea).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            picture.evaluate((image) => {
              const area = image.parentElement!;
              const style = getComputedStyle(area);
              const available =
                area.clientWidth -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight);
              return Math.abs(image.getBoundingClientRect().width - available);
            }),
          )
          .toBeLessThanOrEqual(1);
        expect(
          await pageArea.evaluate(
            (area) => area.scrollWidth <= area.clientWidth,
          ),
        ).toBe(true);
        await expect(pageText).toContainText("Page 1 of 2");
        await page.screenshot({
          path: testInfo.outputPath("native-pdf-reader-refitted.png"),
        });
        await reader
          .getByRole("button", { name: "Close", exact: true })
          .click();
        // PDF Read removed Details; Close returns directly to the library.
        await expect(reader).toHaveCount(0);
        await expect(picture).toHaveCount(0);
        await expect(records).toBeVisible();
        await expect(pdfRow).toBeVisible();
        await expect(pdfRow).toBeFocused();

        // A readable copy leaves the vault through the actual Windows picker.
        // Verify the file itself, not only the UI's saved notice.
        const readableCopyPath = testInfo.outputPath(
          "native-readable-copy.pdf",
        );
        await expect(stat(readableCopyPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await pdfRow.click();
        await expect(pdfDetails).toBeVisible();
        await pdfDetails
          .getByRole("button", {
            name: translate(
              "en",
              "interface.RecordDetails.saveACopyToThisComputer",
            ),
            exact: true,
          })
          .click();
        const copyQuestion = page.getByRole("alertdialog", {
          name: translate("en", "interface.VaultLibrary.saveAReadableCopy"),
          exact: true,
        });
        await expect(copyQuestion).toBeVisible();
        await expect(
          copyQuestion.getByText(
            translate(
              "en",
              "interface.VaultLibrary.savingCreatesAReadableFileOutsideThe",
            ),
            { exact: true },
          ),
        ).toBeVisible();
        const exported = await Promise.allSettled([
          copyQuestion
            .getByRole("button", {
              name: translate("en", "interface.VaultLibrary.saveACopy"),
              exact: true,
            })
            .click(),
          native("FILE_SAVE", "file", readableCopyPath),
        ]);
        for (const result of exported)
          if (result.status === "rejected") throw result.reason;
        await expect(copyQuestion).toHaveCount(0);
        await expect(pdfDetails.getByRole("status")).toHaveText(
          translate("en", "interface.notice.copySaved"),
        );
        const publicPdfBytes = await readFile(pdfPath);
        const readableCopyBytes = await readFile(readableCopyPath);
        expect(readableCopyBytes).toEqual(publicPdfBytes);
        expect(
          createHash("sha256").update(readableCopyBytes).digest("hex"),
          "The readable copy contains the public two-page PDF bytes",
        ).toBe(
          "41e61a36137b8f4c79a284a73adb36d634708625831c88c60e05e961756d51a9",
        );
        await page.screenshot({
          path: testInfo.outputPath("native-readable-copy-saved.png"),
        });
        await pdfDetails
          .getByRole("button", {
            name: translate(
              "en",
              "interface.RecordDetails.closeDocumentDetails",
            ),
            exact: true,
          })
          .click();
        await expect(pdfDetails).toHaveCount(0);
        await expect(records).toBeVisible();
        await expect(pdfRow).toHaveCount(1);
        await expect(pdfRow).toBeVisible();
        await expect(pdfRow).toBeFocused();

        // The producer verified this document opens only with the exact spaced password.
        const spacedPath = resolve(
          "src-tauri/tests/fixtures/locked-pdf/image-aes256-spaced.pdf",
        );
        expect(
          createHash("sha256")
            .update(await readFile(spacedPath))
            .digest("hex"),
        ).toBe(
          "ddee7f163612ef7b893fafa12baeaf9970650850dcc5fcc65789b8b6f230cc72",
        );
        const importedSpaced = await Promise.allSettled([
          page
            .getByRole("button", {
              name: translate("en", "interface.VaultApp.chooseFilesToImport"),
              exact: true,
            })
            .click(),
          native("FILE_OPEN", "file", spacedPath),
        ]);
        for (const result of importedSpaced)
          if (result.status === "rejected") throw result.reason;
        await expect(
          page.getByText(
            translate("en", "interface.notice.imported", { count: 1 }),
            {
              exact: true,
            },
          ),
        ).toBeVisible();
        const spacedName = "image-aes256-spaced.pdf";
        const originalName = "image-aes256-spaced (locked original).pdf";
        await page
          .getByRole("button", { name: spacedName, exact: true })
          .click();
        const spacedDetails = page.getByRole("dialog", {
          name: spacedName,
          exact: true,
        });
        await spacedDetails
          .getByRole("button", {
            name: translate("en", "interface.RecordDetails.unlock"),
            exact: true,
          })
          .click();
        const passwordDialog = page.getByRole("dialog", {
          name: `${translate("en", "unlock.submit")} ${spacedName}`,
          exact: true,
        });
        const documentPassword = passwordDialog.getByLabel(
          translate("en", "interface.DocumentReader.documentPassword"),
          { exact: true },
        );
        const spacedPassword = "  FAKE-portal-2026  ";
        await documentPassword.fill(spacedPassword);
        await expect(documentPassword).toHaveValue(spacedPassword);
        await passwordDialog
          .getByRole("button", {
            name: translate("en", "unlock.submit"),
            exact: true,
          })
          .click();
        await expect(passwordDialog).toHaveCount(0);
        await expect(spacedDetails.getByRole("status")).toHaveText(
          translate("en", "interface.notice.pdfUnlocked", {
            name: originalName,
          }),
        );
        await spacedDetails
          .getByRole("button", {
            name: translate("en", "interface.RecordDetails.read"),
            exact: true,
          })
          .click();
        const copyReader = page.getByRole("dialog", {
          name: spacedName,
          exact: true,
        });
        const copyPicture = copyReader.getByRole("img", {
          name: translate("en", "interface.reader.textFollows", {
            page: 1,
            total: 1,
          }),
          exact: true,
        });
        await expect(copyPicture).toBeVisible();
        await expect(copyReader.getByRole("status")).toHaveText(
          translate("en", "interface.reader.where", { page: 1, total: 1 }),
        );
        await expect(
          copyReader.getByRole("region", {
            name: translate("en", "interface.reader.page", { page: 1 }),
            exact: true,
          }),
        ).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            copyPicture.evaluate(
              (image: HTMLImageElement) =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0,
            ),
          )
          .toBe(true);
        await expect(
          copyReader.getByLabel(
            translate("en", "interface.DocumentReader.documentPassword"),
            { exact: true },
          ),
        ).toHaveCount(0);
        await copyReader
          .getByText(
            translate("en", "interface.DocumentReader.textOnThisPage"),
            {
              exact: true,
            },
          )
          .click();
        const copyText = copyReader.locator(".native-reader-text div");
        await expect(copyText).toBeVisible();
        await expect(copyText).toContainText(
          "FAKE scan with a made-up picture",
        );
        await page.screenshot({
          path: testInfo.outputPath(
            "native-spaced-password-unlocked-copy-reader.png",
          ),
        });
        await copyReader
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(copyReader).toHaveCount(0);
        await expect(records).toBeVisible();
        await expect(
          page.getByRole("button", { name: spacedName, exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: originalName, exact: true }),
        ).toBeVisible();
        await expect(pdfRow).toBeVisible();
        await expect(
          page.getByRole("button", { name: photoName, exact: true }),
        ).toBeVisible();
        // Reading the retained encrypted original uses a reader-local password.
        const originalRow = page.getByRole("button", {
          name: originalName,
          exact: true,
        });
        await originalRow.click();
        const originalReader = page.getByRole("dialog", {
          name: originalName,
          exact: true,
        });
        await originalReader
          .getByRole("button", {
            name: translate("en", "interface.RecordDetails.read"),
            exact: true,
          })
          .click();
        const inlinePassword = originalReader.getByLabel(
          translate("en", "interface.DocumentReader.documentPassword"),
          { exact: true },
        );
        const inlineOpen = originalReader.getByRole("button", {
          name: translate("en", "interface.DocumentReader.open"),
          exact: true,
        });
        const originalArea = originalReader.getByRole("region", {
          name: translate("en", "interface.reader.page", { page: 1 }),
          exact: true,
        });
        await expect(inlinePassword).toBeVisible();
        await expect(inlinePassword).toHaveValue("");
        await expect(inlineOpen).toBeDisabled();
        await expect(originalReader.getByRole("img")).toHaveCount(0);
        await expect(originalArea).toHaveAttribute("aria-busy", "false");
        await inlinePassword.fill(spacedPassword);
        await expect(inlinePassword).toHaveValue(spacedPassword);
        await inlineOpen.click();
        await expect(inlinePassword).toHaveCount(0);
        const originalPicture = originalReader.getByRole("img", {
          name: translate("en", "interface.reader.textFollows", {
            page: 1,
            total: 1,
          }),
          exact: true,
        });
        await expect(originalPicture).toBeVisible();
        await expect(originalReader.getByRole("status")).toHaveText(
          translate("en", "interface.reader.where", { page: 1, total: 1 }),
        );
        await expect(originalArea).toHaveAttribute("aria-busy", "false");
        await expect
          .poll(() =>
            originalPicture.evaluate(
              (image: HTMLImageElement) =>
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0,
            ),
          )
          .toBe(true);
        await originalReader
          .getByText(
            translate("en", "interface.DocumentReader.textOnThisPage"),
            {
              exact: true,
            },
          )
          .click();
        const originalText = originalReader.locator(".native-reader-text div");
        await expect(originalText).toBeVisible();
        await expect(originalText).toContainText(
          "FAKE scan with a made-up picture",
        );
        await page.screenshot({
          path: testInfo.outputPath(
            "native-original-inline-password-reader.png",
          ),
        });
        await originalReader
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(originalReader).toHaveCount(0);
        await expect(originalPicture).toHaveCount(0);
        await expect(records).toBeVisible();
        await expect(originalRow).toBeVisible();

        // The same original must ask again; Close ended the reading session.
        await originalRow.click();
        await originalReader
          .getByRole("button", {
            name: translate("en", "interface.RecordDetails.read"),
            exact: true,
          })
          .click();
        await expect(inlinePassword).toBeVisible();
        await expect(inlinePassword).toHaveValue("");
        await expect(inlineOpen).toBeDisabled();
        await expect(originalReader.getByRole("img")).toHaveCount(0);
        await expect(originalReader.locator(".native-reader-text")).toHaveCount(
          0,
        );
        await expect(originalArea).toHaveAttribute("aria-busy", "false");
        await page.screenshot({
          path: testInfo.outputPath(
            "native-original-inline-password-reopened.png",
          ),
        });
        await originalReader
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(originalReader).toHaveCount(0);
        await expect(records).toBeVisible();
        await expect(originalRow).toHaveCount(1);
        await expect(
          page.getByRole("button", { name: spacedName, exact: true }),
        ).toHaveCount(1);
        await expect(pdfRow).toBeVisible();
        await expect(
          page.getByRole("button", { name: photoName, exact: true }),
        ).toBeVisible();
        await page
          // The window's own Lock now, named by its words (#121).
          .locator(".titlebar")
          .getByRole("button", { name: "Lock now", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: "Unlock your vault", exact: true }),
        ).toBeVisible();
        await expect(records).toHaveCount(0);

        // This chosen public copy stays readable outside the locked vault.
        expect(await readFile(readableCopyPath)).toEqual(publicPdfBytes);

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
        ownsFollowupVault = false;
        await test.step("owned follow-up failure preserves its error and leaves no active vault", async () => {
          const preRestoreAbsent = await followupCommand("vault_status");
          expect(preRestoreAbsent).toBe("absent");
          await restoreOwnedBackup();
          const beforeFaultLocked = await followupCommand("vault_status");
          expect(beforeFaultLocked).toBe("locked");
          const followupFailure = new Error("FOLLOWUP-FAILURE");
          let observedFailure: unknown;
          try {
            throw followupFailure;
          } catch (failure) {
            try {
              await cleanupAndRethrow(failure);
            } catch (rethrown) {
              observedFailure = rethrown;
            }
          }
          expect(observedFailure).toBe(followupFailure);
          let postCleanupAbsent: unknown;
          await expect
            .poll(async () => {
              postCleanupAbsent = await followupCommand("vault_status");
              return postCleanupAbsent;
            })
            .toBe("absent");
          ownsFollowupVault = false;
          await writeFile(
            testInfo.outputPath("native-followup-failure-cleanup.json"),
            JSON.stringify(
              {
                preRestoreAbsent,
                beforeFaultLocked,
                postCleanupAbsent,
                originalErrorIdentity: observedFailure === followupFailure,
                rootAppPID: appPid,
              },
              null,
              2,
            ),
          );
        });
      } catch (failure) {
        await cleanupAndRethrow(failure);
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
