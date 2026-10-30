import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeUuid,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// Keeping records for more than one person: a person is added in Security
// with their details, their details are edited, a document is moved to
// them, and their folder is renamed. The native side is faked
// (support/vaultFake.ts); Rust tests cover what the vault writes.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "these flows are checked on the desktop project only; the vault screens' phone layout is covered by large-text-accessibility.spec.ts",
  );
});

const CHILD = "FAKE Child";
const CHILD_FULL_NAME = "FAKE Child Example";
const CHILD_BIRTH_DATE = "2015-06-07";
const LETTER = "FAKE Letter.pdf";

test("a person is added with their details in Security, their details are edited, a document is moved to them, and their folder is renamed", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();

  // Add a person, with the details clinic documents would carry.
  const profiles = page.locator("section.setting-row").filter({
    has: page.getByRole("heading", {
      name: en("security.profiles.title"),
      exact: true,
    }),
  });
  await profiles
    .getByLabel(en("security.profiles.label"), { exact: true })
    .fill(CHILD);
  await profiles
    .getByLabel(en("personDetails.fullName"), { exact: true })
    .fill(CHILD_FULL_NAME);
  await profiles
    .getByLabel(en("personDetails.birthDate"), { exact: true })
    .fill(CHILD_BIRTH_DATE);
  await profiles
    .getByRole("button", { name: en("security.profiles.add"), exact: true })
    .click();
  await expect(
    page.getByText(en("interface.notice.personAdded", { name: CHILD }), {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_create_profile")).toEqual([
    {
      request: {
        displayName: CHILD,
        details: { fullName: CHILD_FULL_NAME, birthDate: CHILD_BIRTH_DATE },
        today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    },
  ]);

  // Their details are listed, and can be edited: the birth date becomes
  // unknown, which is saved as no date.
  const details = page
    .getByRole("list", { name: en("personDetails.list"), exact: true })
    .getByRole("listitem")
    .filter({ hasText: CHILD });
  await expect(details).toContainText(CHILD_FULL_NAME);
  await expect(details).toContainText(CHILD_BIRTH_DATE);
  await details
    .getByRole("button", {
      name: en("personDetails.editFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await details
    .getByLabel(en("personDetails.birthDateUnknown"), { exact: true })
    .check();
  await details
    .getByRole("button", { name: en("personDetails.save"), exact: true })
    .click();
  await expect(
    page.getByText(en("personDetails.saved", { name: CHILD }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(details).toContainText(en("personDetails.noDate"));
  expect(
    (await fakeCalls(page, "vault_update_profile_details")).at(-1),
  ).toEqual({
    request: {
      profileId: fakeUuid(202),
      details: { fullName: CHILD_FULL_NAME },
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    },
  });

  // The library now has two people; a document moves to the new one.
  const child = sidebar(page).getByRole("button", {
    name: new RegExp(`^${CHILD}\\b`),
  });
  await expect(child).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: /^FAKE Patient\b/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "FAKE Patient", level: 1 }),
  ).toBeVisible();
  // Two people now: the heading is the person's, not "My records".
  await page.getByRole("button", { name: LETTER, exact: true }).click();
  const letterDetails = page.getByRole("dialog", { name: LETTER, exact: true });
  await expect(letterDetails).toBeVisible();
  await letterDetails
    .getByLabel(en("interface.RecordDetails.moveTo"), { exact: true })
    .selectOption({ label: en("interface.person.records", { name: CHILD }) });
  await letterDetails
    .getByRole("button", {
      name: en("interface.RecordDetails.move"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      en("interface.notice.movedNamed", {
        name: LETTER,
        where: en("interface.person.records", { name: CHILD }),
      }),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_move_to_person")).toEqual([
    {
      request: {
        recordIds: [FAKE_IDS.letter],
        profileId: fakeUuid(202),
        folderIds: [],
      },
    },
  ]);
  await expect(
    page.getByRole("button", { name: LETTER, exact: true }),
  ).toHaveCount(0);
  await child.click();
  await expect(
    page.getByRole("heading", { name: CHILD, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: LETTER, exact: true }),
  ).toBeVisible();

  // The person's folder is renamed; their documents stay.
  await page
    .getByRole("button", {
      name: en("rename.profile.action", { name: CHILD }),
      exact: true,
    })
    .click();
  const rename = page.getByRole("dialog", {
    name: en("rename.title.profile"),
    exact: true,
  });
  await rename
    .getByLabel(en("rename.label.profile"), { exact: true })
    .fill("FAKE Kid");
  await rename
    .getByRole("button", { name: en("rename.save"), exact: true })
    .click();
  await expect(rename).toBeHidden();
  expect(await fakeCalls(page, "vault_rename_profile")).toEqual([
    { request: { profileId: fakeUuid(202), displayName: "FAKE Kid" } },
  ]);
  await expect(
    sidebar(page).getByRole("button", { name: /^FAKE Kid\b/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "FAKE Kid", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: LETTER, exact: true }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});
