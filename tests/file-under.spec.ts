import { expect, test, type Page } from "@playwright/test";
import { expectNoAxeViolations, expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_CLINIC_DOCUMENT,
  fakeCalls,
  fakePersonId,
  fakeSnapshot,
  fakeVaultWith,
  sidebar,
} from "./support/vaultFake";

// File under… (#340 phase 1): a clinic document that did not file itself shows the clinic's own
// name and birth date, and can be filed under a person in one step. Nothing is chosen for the
// patient, and a person's details are saved from the document only when the patient ticks the
// box that says exactly what will be saved. FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const CLINIC_NAME = "FAKE Maya J Example";
const CLINIC_BIRTH = "2015-04-17";
const CHILD = "FAKE Maya";

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "checked on the desktop project; the dialog reuses the record dialog's layout",
  );
});

async function arrive(
  page: Page,
  person: {
    fullName?: string;
    birthDate?: string;
    previousFullNames?: string[];
  } = {},
  words: {
    linkPerson?: string;
    linkedToHidden?: boolean;
    matchingPeople?: string[];
  } = {},
) {
  await fakeVaultWith(page, {
    start: "unlocked",
    portal: "linked",
    clinicPatient: { name: CLINIC_NAME, birthDate: CLINIC_BIRTH, ...words },
    people: [{ displayName: CHILD, ...person }],
  });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", {
      name: en("interface.LibrarySidebar.sharedWithMe"),
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: en("portal.check"), exact: true })
    .click();
  await page
    .getByRole("button", { name: FAKE_CLINIC_DOCUMENT, exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: FAKE_CLINIC_DOCUMENT,
    exact: true,
  });
  await expect(details).toBeVisible();
  return details;
}

test("A document waiting in Shared with me shows the clinic's own name and birth date", async ({
  page,
}) => {
  const details = await arrive(page);
  await expect(details).toContainText(en("fileUnder.fromClinic"));
  await expect(details).toContainText(
    en("fileUnder.words", { name: CLINIC_NAME, date: CLINIC_BIRTH }),
  );
});

test("File under… files by the patient's choice, saves details only when the box is ticked, and offers only what the person has none of", async ({
  page,
}) => {
  const details = await arrive(page);
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await expect(dialog).toBeVisible();
  // The clinic's words and the rule: nothing is chosen for the patient.
  await expect(dialog).toContainText(
    en("fileUnder.clinicWords", { name: CLINIC_NAME, date: CLINIC_BIRTH }),
  );
  await expect(dialog).toContainText(en("fileUnder.rule"));
  await expectNoAxeViolations(page);
  // The person has neither: both are offered, in words that say what is saved, never ticked.
  // Nobody is chosen for them: the button waits for a choice.
  await expect(
    dialog.getByRole("button", { name: en("fileUnder.choose") }),
  ).toBeDisabled();
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  const box = dialog.getByRole("checkbox");
  await expect(box).not.toBeChecked();
  await expect(dialog).toContainText(
    en("fileUnder.what.both", { name: CLINIC_NAME, date: CLINIC_BIRTH }),
  );
  // Filed without ticking: the document moves, the person's details are untouched.
  await dialog
    .getByRole("button", { name: en("fileUnder.confirm", { person: CHILD }) })
    .click();
  await expect
    .poll(async () => (await fakeCalls(page, "vault_move_to_person")).length)
    .toBe(1);
  expect(await fakeCalls(page, "vault_update_profile_details")).toEqual([]);
  const snapshot = await fakeSnapshot(page);
  const person = snapshot.profiles.find((p) => p.displayName === CHILD);
  expect(person?.fullName).toBeUndefined();
  expect(
    snapshot.records.find((r) => r.displayName === FAKE_CLINIC_DOCUMENT)
      ?.profileId,
  ).toBe(person?.id);
  await expectOnlyFakedCommands(page);
});

test("Ticking the box saves the clinic's name and birth date as the person's details, and nothing already there is overwritten", async ({
  page,
}) => {
  const details = await arrive(page, { fullName: CLINIC_NAME });
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  // They have a full name: only the birth date is offered.
  await expect(dialog).toContainText(
    en("fileUnder.what.date", { date: CLINIC_BIRTH }),
  );
  await expect(dialog).not.toContainText("“" + CLINIC_NAME + "”");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: en("fileUnder.confirm", { person: CHILD }) })
    .click();
  await expect
    .poll(
      async () =>
        (await fakeCalls(page, "vault_update_profile_details")).length,
    )
    .toBe(1);
  const [call] = await fakeCalls(page, "vault_update_profile_details");
  expect(call.request).toMatchObject({
    details: { fullName: CLINIC_NAME, birthDate: CLINIC_BIRTH },
  });
});

test("A person who already has a full name and a birth date is offered nothing to save", async ({
  page,
}) => {
  const details = await arrive(page, {
    fullName: "FAKE Existing Name",
    birthDate: "2014-01-01",
  });
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  // Escape closes it and nothing is sent.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await fakeCalls(page, "vault_move_to_person")).toEqual([]);
});

test("A person whose name or birth date differs from the clinic's is offered nothing to save, with a warning, and a name already known as a previous one is not a difference", async ({
  page,
}) => {
  const details = await arrive(page, { fullName: "FAKE Existing Name" });
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  await expect(dialog.getByRole("alert")).toHaveText(en("fileUnder.differs"));
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
});

test("A previous name that is the clinic's is no difference: the birth date alone is offered", async ({
  page,
}) => {
  const details = await arrive(page, {
    fullName: "FAKE Married Name",
    previousFullNames: [CLINIC_NAME],
  });
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog).toContainText(
    en("fileUnder.what.date", { date: CLINIC_BIRTH }),
  );
});

test("No promise that the next documents file themselves when the clinic's link is tied to someone else or another person already matches", async ({
  page,
}) => {
  const details = await arrive(page, {}, { matchingPeople: [fakePersonId(2)] });
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  await expect(dialog).toContainText(en("fileUnder.notOnItsOwn"));
  await expect(dialog).not.toContainText("on their own");
  await expect(dialog.getByRole("checkbox")).toBeVisible();
});

test("A clinic link tied to a hidden person also makes no promise, and the screen is told only that it is hidden", async ({
  page,
}) => {
  const details = await arrive(page, {}, { linkedToHidden: true });
  await details
    .getByRole("button", { name: en("fileUnder.button"), exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: en("fileUnder.title", { document: FAKE_CLINIC_DOCUMENT }),
  });
  await dialog
    .getByLabel(en("fileUnder.person"))
    .selectOption({ label: CHILD });
  await expect(dialog).toContainText(en("fileUnder.notOnItsOwn"));
  await expect(dialog).not.toContainText("on their own");
});
