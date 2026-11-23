import { expect, test } from "@playwright/test";
import {
  dialogByKeyboard,
  expectEveryControlNamed,
  expectNoAxeViolations,
  expectOnlyFakedCommands,
} from "./support/a11y";
import { LOCALES } from "../src/i18n/types";
import { translate } from "./support/fluent";
import {
  fakeCalls,
  fakeCommands,
  fakeVaultWith,
  myRecords,
  scriptFake,
  sidebar,
} from "./support/vaultFake";

// Handing a person's records over and adding one from a file (#360): the two
// dialogs in Security. The native side is faked; Rust tests cover the files.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "these flows are checked on the desktop project only, as the backup's are; the dialogs reuse the recovery key dialog's layout, whose phone layout large-text-dialogs.spec.ts covers",
  );
});

async function openSecurity(page: import("@playwright/test").Page) {
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();
}

test("Hand records over: the key is shown to be written down, the file is saved, read back and said", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await page
    .getByRole("button", { name: en("handover.export.button"), exact: true })
    .click();
  // The dialog is named by its step's heading, so it is found as the one open.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(en("handover.export.caution"), { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: en("handover.export.continue") })
    .click();

  // The key, in groups, and Continue only once it is written down.
  await expect(
    dialog.getByRole("heading", { name: en("handover.export.keyTitle") }),
  ).toBeVisible();
  const groups = dialog.getByRole("list", {
    name: en("handover.export.keyLabel"),
  });
  await expect(groups.getByRole("listitem")).toHaveCount(7);
  // The key's step, as a screen reader meets it: no violations, every control named.
  await expectNoAxeViolations(page, "the handover key step");
  await expectEveryControlNamed(dialog, "the handover key step");
  const next = dialog.getByRole("button", {
    name: en("handover.export.continue"),
  });
  await expect(next).toBeDisabled();
  await dialog.getByLabel(en("handover.export.keySaved")).check();
  await next.click();

  // What will be in it, then where to save it.
  await expect(
    dialog.getByText(en("handover.count.documents", { count: 3 })),
  ).toBeVisible();
  await expect(
    dialog.getByText(en("handover.export.apart"), { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: en("handover.export.chooseWhere") })
    .click();
  await expect(
    dialog.getByRole("heading", { name: en("handover.export.doneTitle") }),
  ).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText(
    en("handover.export.done", { documents: 3, name: "FAKE Person" }).slice(
      0,
      14,
    ),
  );
  expect(
    (await fakeCommands(page)).filter((c) => c.includes("profile_export")),
  ).toEqual([
    "vault_profile_export_prepare",
    "vault_profile_export_pick",
    "vault_profile_export_picked",
  ]);
  // The key is not on screen once the file is written.
  await expect(groups).toHaveCount(0);
  await dialog.getByRole("button", { name: en("handover.close") }).click();
  await expect(dialog).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("Hand records over: a cancelled picker says nothing was saved and keeps the key", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await openSecurity(page);
  await page
    .getByRole("button", { name: en("handover.export.button"), exact: true })
    .click();
  // The dialog is named by its step's heading, so it is found as the one open.
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: en("handover.export.continue") })
    .click();
  await dialog.getByLabel(en("handover.export.keySaved")).check();
  await dialog
    .getByRole("button", { name: en("handover.export.continue") })
    .click();
  await scriptFake(page, "vault_profile_export_pick", { resolve: null });
  await dialog
    .getByRole("button", { name: en("handover.export.chooseWhere") })
    .click();
  await expect(
    dialog.getByText(en("handover.export.noLocation"), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_profile_export_picked")).toEqual([]);
});

test("Add a person from a file: the key is checked, what the file says is shown, the person is added with a receipt code", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await openSecurity(page);
  await page
    .getByRole("button", { name: en("handover.import.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: en("handover.import.choose") })
    .click();

  // A mistyped key is said, and can be tried again.
  const key = dialog.getByLabel(en("handover.import.key"), { exact: true });
  await key.fill("BAD");
  await dialog
    .getByRole("button", { name: en("handover.import.open") })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en("handover.import.error.typo"),
  );
  await key.fill("2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX");
  await dialog
    .getByRole("button", { name: en("handover.import.open") })
    .click();

  // The file's own words, in the file's voice, and the name to give.
  await expect(
    dialog.getByRole("heading", { name: en("handover.import.previewTitle") }),
  ).toBeVisible();
  await expect(
    dialog.getByText(en("handover.import.says", { name: "FAKE Child" }), {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByText(en("handover.import.evidenceNote"), { exact: true }),
  ).toBeVisible();
  const name = dialog.getByLabel(en("handover.import.nameLabel"));
  await expect(name).toHaveValue("FAKE Child");
  await name.fill("FAKE Child's records");
  await dialog.getByRole("button", { name: en("handover.import.add") }).click();

  await expect(
    dialog.getByRole("heading", { name: en("handover.import.doneTitle") }),
  ).toBeVisible();
  await expect(dialog.getByText("AB12-CD34").first()).toBeVisible();
  await expect(
    dialog.getByText(en("handover.import.receiptNote"), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_profile_import")).toEqual([
    {
      request: expect.objectContaining({
        key: "2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX",
        displayName: "FAKE Child's records",
        allowDuplicate: false,
      }),
    },
  ]);
  await dialog.getByRole("button", { name: en("handover.close") }).click();
  // The new person is among the people on the page now.
  await expect(page.getByText("FAKE Child's records").first()).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("The handover dialogs open from the keyboard, take focus, name every control, and Escape gives focus back", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await dialogByKeyboard(
    page,
    page.getByRole("button", {
      name: en("handover.export.button"),
      exact: true,
    }),
    en("handover.export.title"),
  );
  await dialogByKeyboard(
    page,
    page.getByRole("button", {
      name: en("handover.import.button"),
      exact: true,
    }),
    en("handover.import.title"),
  );
  await expectOnlyFakedCommands(page);
});

/** Controls in the open dialog that run past its edges, and the dialog scrolling sideways. */
function outsideDialog(
  page: import("@playwright/test").Page,
  where: string,
): Promise<string[]> {
  return page.evaluate((where) => {
    const found: string[] = [];
    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ).filter((dialog) => dialog.checkVisibility());
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return [`${where}: no dialog open`];
    const edge = dialog.getBoundingClientRect();
    if (dialog.scrollWidth > dialog.clientWidth + 1)
      found.push(`${where} scrolls sideways`);
    for (const control of Array.from(
      dialog.querySelectorAll<HTMLElement>("button, input, select, label"),
    ).filter((control) => control.checkVisibility())) {
      const box = control.getBoundingClientRect();
      const name = `${where} ${control.tagName.toLowerCase()} "${(control.textContent ?? "").trim().slice(0, 40)}"`;
      if (box.left < edge.left - 1) found.push(`${name} runs past the start`);
      if (box.right > edge.right + 1) found.push(`${name} runs past the end`);
      if (
        control.tagName === "BUTTON" &&
        (control.scrollWidth > control.clientWidth + 1 ||
          control.scrollHeight > control.clientHeight + 1)
      )
        found.push(`${name} spills out of its own box`);
    }
    return found;
  }, where);
}

test("At the app's 200% text, in every language, every step of the handover dialogs keeps its controls inside it", async ({
  browser,
}, info) => {
  // Seven languages, each with six steps.
  test.setTimeout(240_000);
  const problems: string[] = [];
  for (const locale of LOCALES) {
    // A 1280x720 window at 200% lays out like 640x360, drawn with twice the pixels.
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 2,
    });
    try {
      const page = await context.newPage();
      await page.addInitScript((locale) => {
        localStorage.setItem("mycarlos.language.v1", locale);
      }, locale);
      await fakeVaultWith(page, { start: "unlocked" });
      await page.goto("/");
      await page
        .getByRole("button", {
          name: translate(locale, "security.title"),
          exact: true,
        })
        .click();
      const check = async (where: string) => {
        for (const problem of await outsideDialog(page, where))
          problems.push(`${locale}: ${problem}`);
      };
      await page
        .getByRole("button", {
          name: translate(locale, "handover.export.button"),
          exact: true,
        })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await check("Hand over: choose");
      await dialog
        .getByRole("button", {
          name: translate(locale, "handover.export.continue"),
        })
        .click();
      await expect(
        dialog.getByRole("heading", {
          name: translate(locale, "handover.export.keyTitle"),
        }),
      ).toBeVisible();
      await check("Hand over: the key");
      await dialog
        .getByLabel(translate(locale, "handover.export.keySaved"))
        .check();
      await dialog
        .getByRole("button", {
          name: translate(locale, "handover.export.continue"),
        })
        .click();
      await expect(
        dialog.getByRole("button", {
          name: translate(locale, "handover.export.chooseWhere"),
        }),
      ).toBeVisible();
      await check("Hand over: save");
      await dialog
        .getByRole("button", {
          name: translate(locale, "common.cancel"),
          exact: true,
        })
        .click();
      await expect(dialog).toHaveCount(0);
      await page
        .getByRole("button", {
          name: translate(locale, "handover.import.button"),
          exact: true,
        })
        .click();
      await check("Add from a file: choose");
      await dialog
        .getByRole("button", {
          name: translate(locale, "handover.import.choose"),
        })
        .click();
      await dialog
        .getByLabel(translate(locale, "handover.import.key"), { exact: true })
        .fill("2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX");
      await check("Add from a file: key");
      await dialog
        .getByRole("button", {
          name: translate(locale, "handover.import.open"),
        })
        .click();
      await expect(
        dialog.getByRole("button", {
          name: translate(locale, "handover.import.add"),
        }),
      ).toBeVisible();
      await check("Add from a file: what the file says");
    } finally {
      await context.close();
    }
  }
  expect(problems, "controls outside their dialog").toEqual([]);
});
