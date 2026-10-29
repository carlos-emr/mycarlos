import { expect, test, type Page } from "@playwright/test";
import { LOCALES } from "../src/i18n/types";
import { translate } from "./support/fluent";

// Below 40em a dialog's footer puts two buttons to a row. At 200% default
// text (32px) on a phone, a label whose longest word didn't fit its half used
// to push the other button past the dialog's edge: past the start, where it
// can't be scrolled to ("Annuler" beside "Enregistrer le nom"), or past the
// end (the recovery key's steps). Each dialog here is opened for real, in
// every language, and every control in it must stay inside it.

/** A vault with one patient, a folder and a document, and no recovery key
 * yet (FAKE). */
async function fakeVault(page: Page, locale: string) {
  await page.addInitScript((locale) => {
    localStorage.setItem("mycarlos.language.v1", locale);
    const snapshot = {
      profiles: [
        { id: "p1", displayName: "FAKE Avery Example", createdAtMs: 1 },
      ],
      folders: [
        {
          id: "f1",
          profileId: "p1",
          parentId: null,
          name: "FAKE Lab results",
          createdAtMs: 1759300000000,
        },
      ],
      records: [
        {
          id: "r1",
          profileId: "p1",
          folderIds: [],
          displayName: "FAKE Clinic letter.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 96256,
          importedAtMs: 1760000000000,
          available: true,
        },
      ],
      recovery: null,
      recoveryKeySetAtMs: null,
    };
    // Any command these dialogs should not send fails the test.
    const unexpected: string[] = [];
    Reflect.set(window, "__FAKE_UNEXPECTED__", unexpected);
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return "unlocked";
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "windows" };
        if (
          command === "vault_touch" ||
          command === "vault_set_auto_lock" ||
          command === "vault_recovery_key_cancel"
        )
          return;
        // Files shared to myCarlos are looked for on focus (#49): none.
        if (command === "received_list") return [];
        // A document's details ask whether its PDF has its own password.
        if (command === "vault_is_locked_pdf") return false;
        // The recovery key's steps show the key's label.
        if (command === "vault_recovery_key_label") return "FAKE-KEY1";
        // A made-up key, in groups, only for the dialog to show.
        if (command === "vault_recovery_key_begin")
          return Array.from({ length: 8 }, (_, i) => `FAKE${i}`).join("-");
        unexpected.push(command);
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  }, locale);
}

/** Controls in the open dialog that run past its edges or spill out of
 * their own box, and the dialog scrolling sideways. */
function outsideDialog(page: Page, dialogName: string): Promise<string[]> {
  return page.evaluate((dialogName) => {
    const found: string[] = [];
    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ).filter((dialog) => dialog.checkVisibility());
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return [`${dialogName}: no dialog open`];
    const edge = dialog.getBoundingClientRect();
    if (dialog.scrollWidth > dialog.clientWidth + 1)
      found.push(`${dialogName} scrolls sideways`);
    for (const control of Array.from(
      dialog.querySelectorAll<HTMLElement>("button, input, select, label"),
    ).filter((control) => control.checkVisibility())) {
      const name = `${dialogName} ${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim().slice(0, 40)}"`;
      const box = control.getBoundingClientRect();
      if (box.left < edge.left - 1)
        found.push(`${name} runs past the dialog's start`);
      if (box.right > edge.right + 1)
        found.push(`${name} runs past the dialog's end`);
      if (
        control.tagName === "BUTTON" &&
        (control.scrollWidth > control.clientWidth + 1 ||
          control.scrollHeight > control.clientHeight + 1)
      )
        found.push(`${name} spills out of its own box`);
    }
    return found;
  }, dialogName);
}

/** Commands the app sent that the fake vault did not expect. */
const unexpectedCommands = (page: Page): Promise<string[]> =>
  page.evaluate(() => Reflect.get(window, "__FAKE_UNEXPECTED__") as string[]);

// The default text size stays at 200%: nothing here takes a full-page
// screenshot, which puts Chrome's default text size back to 16px.
const rootFont = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

for (const width of [320, 360])
  test(`keeps every dialog's buttons inside it at ${width}px with 200% default text in every language`, async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own phone sizes");
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const context = await browser.newContext({
        baseURL: info.project.use.baseURL,
        viewport: { width, height: 900 },
        isMobile: true,
        hasTouch: true,
      });
      try {
        const page = await context.newPage();
        await fakeVault(page, locale);
        const cdp = await context.newCDPSession(page);
        await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const check = async (dialogName: string) => {
          expect(await rootFont(page), "text is at 200%").toBe("32px");
          for (const problem of await outsideDialog(page, dialogName))
            problems.push(`${locale}: ${problem}`);
        };

        // A folder's Rename.
        await page
          .getByRole("button", {
            name: translate(locale, "library.folder.rename", {
              name: "FAKE Lab results",
            }),
          })
          .click();
        await expect(
          page.getByRole("dialog", {
            name: translate(locale, "rename.title.folder"),
          }),
        ).toBeVisible();
        await check("Rename folder");
        await page.keyboard.press("Escape");

        // A document's details, then its Rename.
        await page
          .getByRole("button", { name: /^FAKE Clinic letter\.pdf/ })
          .first()
          .click();
        await expect(
          page.getByRole("dialog", { name: "FAKE Clinic letter.pdf" }),
        ).toBeVisible();
        await check("Document details");
        await page
          .getByRole("button", {
            name: translate(locale, "rename.title.document"),
          })
          .click();
        await expect(
          page.getByRole("dialog", {
            name: translate(locale, "rename.title.document"),
          }),
        ).toBeVisible();
        await check("Rename document");
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", {
            name: translate(
              locale,
              "interface.RecordDetails.closeDocumentDetails",
            ),
          })
          .click();

        // The recovery key's steps.
        await page
          .getByRole("button", {
            name: translate(locale, "security.recoveryKey.setUp"),
          })
          .first()
          .click();
        const recovery = page.getByRole("dialog");
        await expect(recovery).toBeVisible();
        await check("Recovery key: passphrase");
        await recovery
          .getByLabel(translate(locale, "passphrase.label"))
          .fill("FAKE passphrase");
        await recovery
          .getByRole("button", {
            name: translate(locale, "recoveryKey.continue"),
          })
          .click();
        const next = recovery.getByRole("button", {
          name: translate(locale, "recoveryKey.next"),
        });
        await expect(next).toBeVisible();
        await check("Recovery key: the key");
        await next.click();
        await expect(
          recovery.getByRole("button", {
            name: translate(locale, "recoveryKey.checkAndSave"),
          }),
        ).toBeVisible();
        await check("Recovery key: check it");
        // A setup the patient chose to start is left without asking.
        await recovery
          .getByRole("button", {
            name: translate(locale, "common.cancel"),
            exact: true,
          })
          .click();
        await expect(recovery).toHaveCount(0);
        for (const command of await unexpectedCommands(page))
          problems.push(`${locale}: unexpected command ${command}`);
      } finally {
        await context.close();
      }
    }
    expect(problems, "controls outside their dialog").toEqual([]);
  });

// The metadata rows' wrap applies at every width. On a phone at 100% text a
// long value goes under its label; a screenshot shows it for review.
test("keeps a document's details inside the dialog at 360px with 100% text", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "sets its own phone sizes");
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await fakeVault(page, "en");
    await page.goto("/");
    await page
      .getByRole("button", { name: /^FAKE Clinic letter\.pdf/ })
      .first()
      .click();
    await expect(
      page.getByRole("dialog", { name: "FAKE Clinic letter.pdf" }),
    ).toBeVisible();
    expect(await rootFont(page)).toBe("16px");
    await page.screenshot({
      path: info.outputPath("details-360-text100.png"),
    });
    expect(await outsideDialog(page, "Document details")).toEqual([]);
    expect(await unexpectedCommands(page)).toEqual([]);
  } finally {
    await context.close();
  }
});
