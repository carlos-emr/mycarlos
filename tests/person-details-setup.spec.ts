import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakeCalls,
  fakeSnapshot,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// A person's full name and date of birth, asked for when the vault is made
// and when a person is added, or left for later (#234, Ben's decision): a
// reminder then stays in the library until they are added, and leads to
// Edit details. The native side is faked (support/vaultFake.ts). FAKE data
// only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const PASSPHRASE = "river-azimuth-cobalt-sparrow-934";
const FULL_NAME = "FAKE Robin Example";
const BIRTH_DATE = "1980-04-12";

/** The comfort screen, then the Create form with whose records these are. */
async function createForm(page: Page) {
  await fakeVaultWith(page, { start: "absent" });
  await page.goto("/");
  await page
    .getByRole("button", { name: en("comfort.continue"), exact: true })
    .click();
  await page
    .getByLabel(en("create.profile.label"), { exact: true })
    .fill("FAKE Robin");
}

async function passphraseAndCreate(page: Page) {
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(PASSPHRASE);
  await page
    .getByLabel(en("passphrase.confirm.label"), { exact: true })
    .fill(PASSPHRASE);
  await page
    .getByRole("button", { name: en("create.submit"), exact: true })
    .click();
  // A new vault opens on setting up its recovery key.
  await expect(page.getByRole("dialog")).toBeVisible();
}

/** The reminder, named apart from the build's own banner note. */
const reminders = (page: Page) =>
  page.getByRole("note", { name: en("personDetails.setup"), exact: true });
const reminder = (page: Page, name: string) =>
  reminders(page).filter({
    hasText: en("personDetails.reminder", { name }),
  });

/** Opens My records or Security: from the sidebar, or on a phone from the
 * row of section tabs that takes its place (#67). */
async function openSection(
  page: Page,
  info: TestInfo,
  section: "records" | "security",
) {
  if (info.project.name === "phone") {
    await page
      .getByRole("navigation", {
        name: en("interface.VaultLibrary.section"),
        exact: true,
      })
      .getByRole("button", {
        name: en(
          section === "records"
            ? "interface.VaultLibrary.records"
            : "security.title",
        ),
        exact: true,
      })
      .click();
    return;
  }
  await sidebar(page)
    .getByRole("button", {
      name:
        section === "records"
          ? new RegExp(`^${en("sidebar.myRecords")}\\b`)
          : en("security.title"),
      ...(section === "security" && { exact: true }),
    })
    .click();
}

test("a new vault keeps the first person's full name and date of birth, as Edit details does", async ({
  page,
}) => {
  await createForm(page);
  const create = page.getByRole("button", {
    name: en("create.submit"),
    exact: true,
  });
  const details = page.getByRole("group", {
    name: en("personDetails.setup"),
    exact: true,
  });
  await expect(details).toBeVisible();
  // Not "Later": a full name and a date (or "unknown") are needed.
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(PASSPHRASE);
  await page
    .getByLabel(en("passphrase.confirm.label"), { exact: true })
    .fill(PASSPHRASE);
  await expect(create).toBeDisabled();
  await details
    .getByLabel(en("personDetails.fullName"), { exact: true })
    .fill(FULL_NAME);
  await expect(create).toBeDisabled();
  await details
    .getByLabel(en("personDetails.birthDate"), { exact: true })
    .fill(BIRTH_DATE);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const [created] = await fakeCalls(page, "vault_create");
  const snapshot = await fakeSnapshot(page);
  const first = snapshot.profiles.find(
    (person) => person.id !== snapshot.sharedProfileId,
  )!;
  expect(await fakeCalls(page, "vault_update_profile_details")).toEqual([
    {
      request: {
        profileId: first.id,
        details: { fullName: FULL_NAME, birthDate: BIRTH_DATE },
        today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    },
  ]);
  expect(created).toBeTruthy();
  expect(first).toMatchObject({ fullName: FULL_NAME, birthDate: BIRTH_DATE });
  await expectOnlyFakedCommands(page);
});

test("a new vault can leave the details for later: nothing is saved for them", async ({
  page,
}) => {
  await createForm(page);
  await page
    .getByRole("checkbox", { name: en("personDetails.later"), exact: true })
    .check();
  await expect(
    page.getByLabel(en("personDetails.fullName"), { exact: true }),
  ).toHaveCount(0);
  await passphraseAndCreate(page);
  expect(await fakeCalls(page, "vault_update_profile_details")).toEqual([]);
  const snapshot = await fakeSnapshot(page);
  expect(snapshot.profiles[0].fullName).toBeUndefined();
});

test("the library reminds until a person's details are added, and its button opens Edit details", async ({
  page,
}, info) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const note = reminder(page, "FAKE Patient");
  await expect(note).toBeVisible();
  await note
    .getByRole("button", { name: en("personDetails.edit"), exact: true })
    .click();
  // Security, with FAKE Patient's form open and the focus in its first box.
  const form = page.getByRole("form", {
    name: en("personDetails.for", { name: "FAKE Patient" }),
    exact: true,
  });
  const fullName = form.getByLabel(en("personDetails.fullName"), {
    exact: true,
  });
  await expect(fullName).toBeFocused();
  await fullName.fill(FULL_NAME);
  // A date of birth marked unknown completes them too.
  await form
    .getByLabel(en("personDetails.birthDateUnknown"), { exact: true })
    .check();
  await form
    .getByRole("button", { name: en("personDetails.save"), exact: true })
    .click();
  await expect(
    page.getByText(en("personDetails.saved", { name: "FAKE Patient" }), {
      exact: true,
    }),
  ).toBeVisible();
  // One person: the sidebar's top entry is My records.
  await openSection(page, info, "records");
  await expect(myRecords(page)).toBeVisible();
  await expect(reminders(page)).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("a person added with their details left for later is reminded about too", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "phone",
    "this one moves between two people in the sidebar, which a phone does not have; the test above covers the reminder on a phone",
  );
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSection(page, info, "security");
  // Add profile opens a dialog (#165).
  await page
    .getByRole("button", { name: en("security.profiles.add"), exact: true })
    .click();
  const addProfile = page.getByRole("dialog", {
    name: en("security.profiles.add"),
    exact: true,
  });
  await addProfile
    .getByLabel(en("security.profiles.label"), { exact: true })
    .fill("FAKE Child");
  await addProfile
    .getByRole("checkbox", { name: en("personDetails.later"), exact: true })
    .check();
  await addProfile
    .getByRole("button", { name: en("security.profiles.add"), exact: true })
    .click();
  await expect(addProfile).toHaveCount(0);
  await expect(
    page.getByText(en("interface.notice.personAdded", { name: "FAKE Child" }), {
      exact: true,
    }),
  ).toBeVisible();
  expect((await fakeCalls(page, "vault_create_profile")).at(-1)).toEqual({
    request: {
      displayName: "FAKE Child",
      details: {},
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
  });
  // The open person is reminded about first; once their details are in,
  // the one added with them for later.
  await sidebar(page)
    .getByRole("button", { name: /^FAKE Patient\b/ })
    .click();
  const first = reminder(page, "FAKE Patient");
  await expect(first).toBeVisible();
  await first
    .getByRole("button", { name: en("personDetails.edit"), exact: true })
    .click();
  const form = page.getByRole("form", {
    name: en("personDetails.for", { name: "FAKE Patient" }),
    exact: true,
  });
  await form
    .getByLabel(en("personDetails.fullName"), { exact: true })
    .fill(FULL_NAME);
  await form
    .getByLabel(en("personDetails.birthDate"), { exact: true })
    .fill(BIRTH_DATE);
  await form
    .getByRole("button", { name: en("personDetails.save"), exact: true })
    .click();
  await expect(
    page.getByText(en("personDetails.saved", { name: "FAKE Patient" }), {
      exact: true,
    }),
  ).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: /^FAKE Patient\b/ })
    .click();
  await expect(reminder(page, "FAKE Child")).toBeVisible();
});
