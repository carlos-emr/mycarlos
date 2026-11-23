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
  FAKE_PASSPHRASE,
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
    en("handover.export.done", { count: 3, name: "FAKE Person" }).slice(0, 14),
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

/** The window sent to the background, as the webview tells the page: the app locks at once. */
async function hide(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function openKeyStep(page: import("@playwright/test").Page) {
  await openSecurity(page);
  await page
    .getByRole("button", { name: en("handover.export.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: en("handover.export.continue") })
    .click();
  await expect(
    dialog.getByRole("heading", { name: en("handover.export.keyTitle") }),
  ).toBeVisible();
  return dialog;
}

test("A lock while the key is shown ends the handover, and the next unlock says that any key copied opens nothing", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const dialog = await openKeyStep(page);
  // The key is described to a screen reader with its warning.
  await expect(dialog).toHaveAttribute(
    "aria-describedby",
    "handover-key-about",
  );
  await hide(page);
  await expect(
    page.getByRole("heading", { name: en("unlock.title") }),
  ).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "visibilityState");
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  await expect(page.getByText(en("handover.unfinished"))).toBeVisible();
  // Said once.
  await page
    .locator(".titlebar")
    .getByRole("button", { name: en("security.lockNow"), exact: true })
    .click();
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  await expect(page.getByText(en("handover.unfinished"))).toHaveCount(0);
});

test("On the key step Escape and Cancel ask before leaving, a click outside does nothing, and leaving ends the handover quietly", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const dialog = await openKeyStep(page);
  // A click outside does not close it.
  await page.mouse.click(2, 2);
  await expect(dialog).toBeVisible();
  // Escape asks.
  await page.keyboard.press("Escape");
  const ask = page.getByRole("alertdialog");
  await expect(ask).toBeVisible();
  await expect(
    ask.getByText(en("handover.export.leave.body"), { exact: true }),
  ).toBeVisible();
  await ask.getByRole("button", { name: en("common.cancel") }).click();
  await expect(ask).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // Cancel asks too, and leaving closes it with no file asked for.
  await dialog.getByRole("button", { name: en("common.cancel") }).click();
  await ask
    .getByRole("button", { name: en("handover.export.leave.confirm") })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await fakeCalls(page, "vault_profile_export_pick")).toEqual([]);
  // Locked and unlocked again, nothing is said: the patient left on purpose.
  await page
    .locator(".titlebar")
    .getByRole("button", { name: en("security.lockNow"), exact: true })
    .click();
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  await expect(page.getByText(en("handover.unfinished"))).toHaveCount(0);
});

test("On a phone the key cannot be copied (leaving the app would lock the vault) and the dialog says why", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", platform: "android" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const dialog = await openKeyStep(page);
  await expect(
    dialog.getByRole("button", { name: en("handover.export.copy") }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(en("handover.export.leavingWarning"), { exact: true }),
  ).toBeVisible();
});

test("A failed save, or a picker that fails after the preparation was spent, starts again with a new key; a weak passphrase says why", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await page
    .getByRole("button", { name: en("handover.export.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const go = async () => {
    await dialog
      .getByRole("button", { name: en("handover.export.continue") })
      .click();
    await dialog.getByLabel(en("handover.export.keySaved")).check();
    await dialog
      .getByRole("button", { name: en("handover.export.continue") })
      .click();
  };
  // The save fails: back to the start, with the refusal, and a new key on the next try.
  await go();
  await scriptFake(page, "vault_profile_export_picked", {
    reject: { code: "storage", messageKey: "native.error.19" },
  });
  await dialog
    .getByRole("button", { name: en("handover.export.chooseWhere") })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: en("handover.export.title") }),
  ).toBeVisible();
  // The picker fails after the preparation was spent (not found): the same.
  await go();
  await scriptFake(page, "vault_profile_export_pick", {
    reject: { code: "not_found", messageKey: "native.error.18" },
  });
  await dialog
    .getByRole("button", { name: en("handover.export.chooseWhere") })
    .click();
  await expect(
    dialog.getByRole("heading", { name: en("handover.export.title") }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_profile_export_prepare")).toHaveLength(2);
  // A passphrase refused as weak says why, naming the vault's own secrets.
  await dialog.getByLabel(en("handover.export.keyKind.passphrase")).check();
  await dialog.getByLabel(en("handover.export.passphrase")).fill("short");
  await scriptFake(page, "vault_profile_export_prepare", {
    reject: { code: "weak_passphrase", messageKey: "native.error.19" },
  });
  await dialog
    .getByRole("button", { name: en("handover.export.continue") })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    en("handover.export.error.weak"),
  );
  // After five tries in one unlocked session the native side stops checking typed ones, and
  // the refusal says to lock and unlock again or let myCarlos make the key.
  await scriptFake(page, "vault_profile_export_prepare", {
    reject: {
      code: "package_passphrase_tries_used",
      messageKey: "native.error.49",
    },
  });
  await dialog
    .getByRole("button", { name: en("handover.export.continue") })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(en("native.error.49"));
});

test("Add a person from a file: a passphrase file asks for a passphrase, a duplicate asks first, and each kind of refusal is said", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  await page
    .getByRole("button", { name: en("handover.import.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await scriptFake(page, "vault_profile_import_key_kind", {
    resolve: "passphrase",
  });
  await dialog
    .getByRole("button", { name: en("handover.import.choose") })
    .click();
  const field = dialog.getByLabel(en("handover.import.passphrase"), {
    exact: false,
  });
  await expect(field).toBeVisible();
  // Each refusal in its own words.
  const refusals: [string, string][] = [
    ["package_key_is_recovery_key", en("handover.import.error.recovery")],
    ["wrong_passphrase", en("handover.import.error.wrong")],
    ["vault_newer_format", en("handover.import.error.newer")],
    ["invalid", en("handover.import.error.damaged")],
  ];
  await field.fill("FAKE passphrase of the file");
  for (const [code, text] of refusals) {
    await scriptFake(page, "vault_profile_import_inspect", {
      reject: { code, messageKey: "native.error.19" },
    });
    await dialog
      .getByRole("button", { name: en("handover.import.open") })
      .click();
    await expect(dialog.getByRole("alert")).toHaveText(text);
  }
  // Opened: a duplicate by content says what the vault found, and waits for a choice.
  await scriptFake(page, "vault_profile_import_inspect", {
    resolve: {
      exportedAtMs: Date.UTC(2026, 10, 14),
      displayName: "FAKE Child",
      fullName: null,
      birthDate: null,
      documents: 3,
      hidden: 0,
      folders: 0,
      aiAnswers: 0,
      withClinicEvidence: 0,
      historyEntries: 0,
      plaintextBytes: 100,
      alreadyHere: { profileId: "p", by: "content", matchingDocuments: 2 },
    },
  });
  await dialog
    .getByRole("button", { name: en("handover.import.open") })
    .click();
  await expect(
    dialog.getByText(en("handover.import.duplicate.content", { count: 2 }), {
      exact: true,
    }),
  ).toBeVisible();
  const add = dialog.getByRole("button", { name: en("handover.import.add") });
  await expect(add).toBeDisabled();
  await dialog.getByLabel(en("handover.import.duplicate.anyway")).check();
  await expect(add).toBeEnabled();
  await add.click();
  expect(await fakeCalls(page, "vault_profile_import")).toEqual([
    {
      request: expect.objectContaining({
        passphrase: "FAKE passphrase of the file",
        allowDuplicate: true,
      }),
    },
  ]);
});
