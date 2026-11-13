// Screenshots for Ben's look at #258 (never committed). FAKE data, the e2e fake native side.
// SHOTS_SIDE=before|after, SHOTS_DIR=<folder>. Shots that only exist after the change skip before.
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import * as path from "node:path";
import { translate } from "./support/fluent";
import { fakeVaultWith, myRecords, refusal, scriptFake, sidebar } from "./support/vaultFake";

const SIDE = process.env.SHOTS_SIDE === "after" ? "after" : "before";
const DIR = process.env.SHOTS_DIR ?? "shots";
const AFTER = SIDE === "after";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const en = (key: string, params?: Record<string, string>) => translate("en", key as any, params as any);

const PASSPHRASE = "river-azimuth-cobalt-sparrow-934";

async function shot(page: Page, info: TestInfo, name: string, fullPage = false) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(DIR, SIDE, `${name}-${info.project.name}.png`),
    fullPage,
    animations: "disabled",
    caret: "hide",
  });
}

async function createForm(page: Page) {
  await fakeVaultWith(page, { start: "absent" });
  await page.goto("/");
  await page.getByRole("button", { name: en("comfort.continue"), exact: true }).click();
  await page.getByLabel(en("create.profile.label"), { exact: true }).fill("FAKE Robin");
}

async function passphrases(page: Page) {
  await page.getByLabel(en("passphrase.label"), { exact: true }).fill(PASSPHRASE);
  await page.getByLabel(en("passphrase.confirm.label"), { exact: true }).fill(PASSPHRASE);
}

const group = (page: Page) => page.getByRole("group", { name: en("personDetails.setup"), exact: true });

async function openSection(page: Page, info: TestInfo, section: "records" | "security") {
  if (info.project.name === "phone") {
    await page
      .getByRole("navigation", { name: en("interface.VaultLibrary.section"), exact: true })
      .getByRole("button", {
        name: en(section === "records" ? "interface.VaultLibrary.records" : "security.title"),
        exact: true,
      })
      .click();
    return;
  }
  await sidebar(page)
    .getByRole("button", {
      name: section === "records" ? new RegExp(`^${en("sidebar.myRecords")}\\b`) : en("security.title"),
      ...(section === "security" && { exact: true }),
    })
    .click();
}

test("01 create screen", async ({ page }, info) => {
  await createForm(page);
  await shot(page, info, "01-create-screen", true);
  if (AFTER) {
    await group(page).scrollIntoViewIfNeeded();
    await shot(page, info, "01b-create-details-group");
  }
});

test("02 create: Add them later ticked", async ({ page }, info) => {
  test.skip(!AFTER, "new in #258");
  await createForm(page);
  await page.getByRole("checkbox", { name: en("personDetails.later"), exact: true }).check();
  await group(page).scrollIntoViewIfNeeded();
  await shot(page, info, "02-create-add-them-later");
});

test("03 create: what is missing, once only the details hold Create back", async ({ page }, info) => {
  test.skip(!AFTER, "new in #258");
  await createForm(page);
  await passphrases(page);
  await expect(page.getByRole("button", { name: en("create.submit"), exact: true })).toBeDisabled();
  await group(page).scrollIntoViewIfNeeded();
  await shot(page, info, "03-create-refusal-details-missing");
});

test("04 create: date of birth unknown", async ({ page }, info) => {
  test.skip(!AFTER, "new in #258");
  await createForm(page);
  await group(page).getByLabel(en("personDetails.fullName"), { exact: true }).fill("FAKE Robin Example");
  await group(page).getByLabel(en("personDetails.birthDateUnknown"), { exact: true }).check();
  await passphrases(page);
  await expect(page.getByRole("button", { name: en("create.submit"), exact: true })).toBeEnabled();
  await group(page).scrollIntoViewIfNeeded();
  await shot(page, info, "04-create-birth-date-unknown");
});

test("05 Add profile dialog", async ({ page }, info) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSection(page, info, "security");
  await page.getByRole("button", { name: en("security.profiles.add"), exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: en("security.profiles.add"), exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(en("security.profiles.label"), { exact: true }).fill("FAKE Child");
  await shot(page, info, "05-add-profile-dialog");
  if (AFTER) {
    await dialog.getByRole("checkbox", { name: en("personDetails.later"), exact: true }).check();
    await shot(page, info, "05b-add-profile-dialog-later");
  }
});

test("06 library", async ({ page }, info) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  if (AFTER) {
    await expect(page.getByRole("note", { name: en("personDetails.setup"), exact: true })).toBeVisible();
  }
  await shot(page, info, "06-library");
});

test("07 Edit details dialog", async ({ page }, info) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  if (AFTER) {
    // From the reminder: Security opens with the dialog, the focus in Full name.
    await page
      .getByRole("note", { name: en("personDetails.setup"), exact: true })
      .getByRole("button", { name: en("personDetails.edit"), exact: true })
      .click();
  } else {
    await openSection(page, info, "security");
    await page
      .getByRole("button", { name: en("personDetails.editFor", { name: "FAKE Patient" }), exact: true })
      .click();
  }
  const form = page.getByRole("form", { name: en("personDetails.for", { name: "FAKE Patient" }), exact: true });
  await expect(form).toBeVisible();
  await shot(page, info, AFTER ? "07-edit-details-from-reminder" : "07-edit-details");
});

test("08 rare failure: details not saved", async ({ page }, info) => {
  test.skip(!AFTER, "new in #258");
  await createForm(page);
  await group(page).getByLabel(en("personDetails.fullName"), { exact: true }).fill("FAKE Robin Example");
  await group(page).getByLabel(en("personDetails.birthDate"), { exact: true }).fill("1980-04-12");
  await passphrases(page);
  // The details save fails, and so does the recovery key's start, so the library says it at once.
  await scriptFake(page, "vault_update_profile_details", { reject: refusal("io", "native.error.07") });
  await scriptFake(page, "vault_recovery_key_begin", { reject: refusal("io", "native.error.07") });
  await page.getByRole("button", { name: en("create.submit"), exact: true }).click();
  await expect(page.getByText(en("personDetails.notSaved"), { exact: true })).toBeVisible();
  await shot(page, info, "08-details-not-saved-notice");
});
