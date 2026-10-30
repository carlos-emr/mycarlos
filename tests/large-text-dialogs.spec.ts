import { expect, test, type Page } from "@playwright/test";
import { LOCALES } from "../src/i18n/types";
import { translate } from "./support/fluent";

// Below 40em a dialog's footer puts two buttons to a row. At 200% default
// text (32px) on a phone, a label whose longest word didn't fit its half used
// to push the other button past the dialog's edge: past the start, where it
// can't be scrolled to ("Annuler" beside "Enregistrer le nom"), or past the
// end (the recovery key's steps). Each dialog here is opened for real, in
// every language, and every control in it must stay inside it.

/** A vault with one patient, three folders and three documents (two in
 * folders with long names, one of them a single word), and no recovery key
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
        {
          id: "f2",
          profileId: "p1",
          parentId: null,
          name: "FAKE Letters from Riverside Family Health Clinic",
          createdAtMs: 1759400000000,
        },
        {
          id: "f3",
          profileId: "p1",
          parentId: null,
          name: "FAKE_Laboratory_Results_2026",
          createdAtMs: 1759500000000,
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
        {
          id: "r2",
          profileId: "p1",
          folderIds: ["f2"],
          displayName: "FAKE Referral.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 51200,
          importedAtMs: 1760100000000,
          available: true,
        },
        {
          id: "r3",
          profileId: "p1",
          folderIds: ["f3"],
          displayName: "FAKE Bloodwork.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 40960,
          importedAtMs: 1760200000000,
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
      // A button's words stay inside its padding. A word as wide as the
      // whole button still passes the check above, with no room to spare.
      if (control.tagName === "BUTTON") {
        const style = getComputedStyle(control);
        const start =
          box.left +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.paddingLeft);
        const end =
          box.right -
          parseFloat(style.borderRightWidth) -
          parseFloat(style.paddingRight);
        const words = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let outside = false;
        for (
          let text = words.nextNode();
          text && !outside;
          text = words.nextNode()
        ) {
          if (
            !text.textContent?.trim() ||
            text.parentElement?.closest(".sr-only")
          )
            continue;
          range.selectNodeContents(text);
          outside = Array.from(range.getClientRects()).some(
            (line) => line.left < start - 0.5 || line.right > end + 0.5,
          );
        }
        if (outside) found.push(`${name}: its words run into its padding`);
      }
    }
    return found;
  }, dialogName);
}

/** Commands the app sent that the fake vault did not expect. */
const unexpectedCommands = (page: Page): Promise<string[]> =>
  page.evaluate(() => Reflect.get(window, "__FAKE_UNEXPECTED__") as string[]);

// The default text size stays as set: nothing here takes a full-page
// screenshot, which puts Chrome's default text size back to 16px.
const rootFont = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

// Two ways to 200% text:
// - A phone's own text size, or the browser's default text: 32px on a phone
//   at 320 or 360px.
// - The app's Text size (Preferences), which zooms the whole webview: at
//   200% a 1280x720 window lays out like 640x360, drawn with twice the
//   pixels, with 16px text (as large-text-accessibility.spec.ts models it).
const LARGE_TEXT = [
  {
    name: "at 320px with 200% default text",
    width: 320,
    height: 900,
    font: 32,
    phone: true,
  },
  {
    name: "at 360px with 200% default text",
    width: 360,
    height: 900,
    font: 32,
    phone: true,
  },
  {
    name: "with the app's text size at 200%",
    width: 640,
    height: 360,
    font: 16,
    phone: false,
  },
  // Arial's widths: the app's font list ends in Helvetica and Arial, used
  // where there is no Roboto or Segoe UI. CI's Linux draws them in
  // Liberation Sans, which has Arial's widths, so with this case a machine
  // with Roboto finds what CI finds.
  {
    name: "at 320px with 200% default text in Arial's widths",
    width: 320,
    height: 900,
    font: 32,
    phone: true,
    family: '"Liberation Sans", Arial',
  },
];

for (const large of LARGE_TEXT)
  test(`keeps every dialog's buttons inside it ${large.name} in every language`, async ({
    browser,
  }, info) => {
    test.skip(info.project.name !== "desktop", "sets its own sizes");
    const problems: string[] = [];
    for (const locale of LOCALES) {
      const context = await browser.newContext({
        baseURL: info.project.use.baseURL,
        viewport: { width: large.width, height: large.height },
        ...(large.phone
          ? { isMobile: true, hasTouch: true }
          : { deviceScaleFactor: 2 }),
      });
      try {
        const page = await context.newPage();
        await fakeVault(page, locale);
        if (large.font !== 16) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Page.setFontSizes", {
            fontSizes: { standard: large.font },
          });
        }
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        if ("family" in large)
          await page.addStyleTag({
            content: `* { font-family: ${large.family}, sans-serif !important; }`,
          });
        const check = async (dialogName: string) => {
          expect(await rootFont(page), "text size").toBe(`${large.font}px`);
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

        // A document in a folder whose name is one long word.
        await page
          .getByRole("button", {
            name: translate(locale, "library.folder.open", {
              name: "FAKE_Laboratory_Results_2026",
            }),
          })
          .click();
        await page
          .getByRole("button", { name: /^FAKE Bloodwork\.pdf/ })
          .first()
          .click();
        await expect(
          page.getByRole("dialog", { name: "FAKE Bloodwork.pdf" }),
        ).toBeVisible();
        await check("Document details, one-word folder name");
        for (const command of await unexpectedCommands(page))
          problems.push(`${locale}: unexpected command ${command}`);
      } finally {
        await context.close();
      }
    }
    expect(problems, "controls outside their dialog").toEqual([]);
  });

// The metadata rows' wrap applies at every width. On a phone at 100% text a
// long value (here the folder's name) still wraps beside its label, as
// before; a screenshot shows it for review.
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
      .getByRole("button", {
        name: translate("en", "library.folder.open", {
          name: "FAKE Letters from Riverside Family Health Clinic",
        }),
      })
      .click();
    await page
      .getByRole("button", { name: /^FAKE Referral\.pdf/ })
      .first()
      .click();
    await expect(
      page.getByRole("dialog", { name: "FAKE Referral.pdf" }),
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
