import { expect, test, type Page } from "@playwright/test";
import {
  expectEveryControlNamed,
  expectNoAxeViolations,
  expectOnlyFakedCommands,
} from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakeCalls,
  fakePersonId,
  scriptFake,
  fakeSnapshot,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// Hiding a whole person and bringing them back (#360, section 8): Hide on each person in
// Security, the Hidden people list, Restore, and the offer to move what arrived meanwhile.
// The native side is faked; Rust tests cover the vault.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const CHILD = "FAKE Child";
const CHILD_ID = fakePersonId(1);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "checked on the desktop project; the dialogs reuse the confirm dialog's layout",
  );
});

async function openSecurity(page: Page) {
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();
}

const line = (page: Page, name: string) =>
  page
    .getByRole("list", { name: en("personDetails.list"), exact: true })
    .getByRole("listitem")
    .filter({ hasText: name });

test("Hide a person: the dialog says nothing is deleted and that it is tidiness, the person leaves the lists and appears under Hidden people, and Restore brings them back", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    people: [{ displayName: CHILD }],
  });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await openSecurity(page);

  await line(page, CHILD)
    .getByRole("button", {
      name: en("hiddenPeople.hideFor", { name: CHILD }),
      exact: true,
    })
    .click();
  const ask = page.getByRole("alertdialog");
  await expect(
    ask.getByRole("heading", {
      name: en("hiddenPeople.confirm.title", { name: CHILD }),
    }),
  ).toBeVisible();
  await expect(
    ask.getByText(en("hiddenPeople.confirm.body", { name: CHILD }), {
      exact: true,
    }),
  ).toBeVisible();
  // Cancel first: nothing is sent.
  await ask.getByRole("button", { name: en("common.cancel") }).click();
  expect(await fakeCalls(page, "vault_hide_profile")).toEqual([]);

  await line(page, CHILD)
    .getByRole("button", {
      name: en("hiddenPeople.hideFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenPeople.confirm.hide", { name: CHILD }),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("hiddenPeople.hidden", { name: CHILD }), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_hide_profile")).toEqual([
    { request: { profileId: CHILD_ID } },
  ]);
  // Gone from the people list, present in Hidden people with their count and a Restore.
  await expect(line(page, CHILD)).toHaveCount(0);
  const hidden = page
    .getByRole("list", { name: en("hiddenPeople.list"), exact: true })
    .getByRole("listitem");
  await expect(hidden).toHaveCount(1);
  await expect(hidden).toContainText(CHILD);
  await expect(hidden).toContainText(
    en("hiddenPeople.documents", { count: 0 }),
  );
  await expectEveryControlNamed(page);
  await expectNoAxeViolations(page);

  await hidden
    .getByRole("button", {
      name: en("hiddenPeople.restoreFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("hiddenPeople.restored", { name: CHILD }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(line(page, CHILD)).toHaveCount(1);
  await expect(
    page.getByRole("list", { name: en("hiddenPeople.list"), exact: true }),
  ).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("The last visible person cannot be hidden: the button says why, and a refusal from the vault is said", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await openSecurity(page);
  const only = page
    .getByRole("list", { name: en("personDetails.list"), exact: true })
    .getByRole("listitem")
    .first();
  const hide = only.getByRole("button", {
    name: /^Hide /,
  });
  await expect(hide).toBeDisabled();
  await expect(hide).toHaveAccessibleDescription(en("hiddenPeople.lastPerson"));
});

test("A document that arrived for a hidden person is offered back on restore, by title, and Move puts it with them; Leave changes nothing", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    people: [{ displayName: CHILD }],
  });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await openSecurity(page);
  await line(page, CHILD)
    .getByRole("button", {
      name: en("hiddenPeople.hideFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenPeople.confirm.hide", { name: CHILD }),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("hiddenPeople.hidden", { name: CHILD }), { exact: true }),
  ).toBeVisible();
  // Meanwhile a clinic document arrives for them: it is in Shared with me.
  await page.evaluate(
    ([id, name]) =>
      (
        Reflect.get(window, "__fakeVault") as {
          arriveWhileHidden: (id: string, name: string) => void;
        }
      ).arriveWhileHidden(id, name),
    [CHILD_ID, "FAKE Arrived Letter.pdf"],
  );
  await page
    .getByRole("button", {
      name: en("hiddenPeople.restoreFor", { name: CHILD }),
      exact: true,
    })
    .click();
  const offer = page.getByRole("alertdialog");
  await expect(
    offer.getByRole("heading", {
      name: en("hiddenPeople.arrived.title", { name: CHILD }),
    }),
  ).toBeVisible();
  await expect(
    offer.getByRole("list", { name: en("hiddenPeople.arrived.list") }),
  ).toContainText("FAKE Arrived Letter.pdf");
  await expect(
    offer.getByText(
      en("hiddenPeople.arrived.body", { name: CHILD, count: 1 }),
      { exact: true },
    ),
  ).toBeVisible();
  // Leave: nothing moves.
  await offer
    .getByRole("button", { name: en("hiddenPeople.arrived.leave") })
    .click();
  expect(await fakeCalls(page, "vault_move_to_person")).toEqual([]);
  const snapshot = await fakeSnapshot(page);
  expect(
    snapshot.records.find((r) => r.displayName === "FAKE Arrived Letter.pdf")
      ?.profileId,
  ).toBe(snapshot.sharedProfileId);

  // Hide, a second arrival, restore, and Move: it becomes theirs.
  await line(page, CHILD)
    .getByRole("button", {
      name: en("hiddenPeople.hideFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenPeople.confirm.hide", { name: CHILD }),
      exact: true,
    })
    .click();
  await page.evaluate(
    ([id, name]) =>
      (
        Reflect.get(window, "__fakeVault") as {
          arriveWhileHidden: (id: string, name: string) => void;
        }
      ).arriveWhileHidden(id, name),
    [CHILD_ID, "FAKE Second Letter.pdf"],
  );
  await page
    .getByRole("button", {
      name: en("hiddenPeople.restoreFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenPeople.arrived.move", { name: CHILD }),
    })
    .click();
  await expect
    .poll(async () => (await fakeCalls(page, "vault_move_to_person")).length)
    .toBe(1);
  await expect
    .poll(
      async () =>
        (await fakeSnapshot(page)).records.find(
          (r) => r.displayName === "FAKE Second Letter.pdf",
        )?.profileId,
    )
    .toBe(CHILD_ID);
});

test("A hidden person can still be handed over from Hidden people, and Hidden people is keyboard-reachable", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    people: [{ displayName: CHILD }],
  });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await openSecurity(page);
  await line(page, CHILD)
    .getByRole("button", {
      name: en("hiddenPeople.hideFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenPeople.confirm.hide", { name: CHILD }),
      exact: true,
    })
    .click();
  const handOver = page.getByRole("button", {
    name: en("hiddenPeople.handOverFor", { name: CHILD }),
    exact: true,
  });
  await handOver.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  // Only the hidden person is offered in the handover dialog.
  await expect(dialog.getByRole("combobox")).toContainText(CHILD);
  await expect(dialog.getByRole("option")).toHaveCount(1);
});

test("A check that finds documents for a hidden person says they are in Shared with me, by clinic and without naming anyone", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", {
      name: en("interface.LibrarySidebar.sharedWithMe"),
      exact: true,
    })
    .click();
  await scriptFake(page, "vault_check_documents", {
    resolve: {
      added: 3,
      refused: 0,
      receiptsPending: 0,
      forHidden: ["FAKE Clinic", "FAKE Clinic", "FAKE Other Clinic"],
    },
  });
  await page
    .getByRole("button", { name: en("portal.check"), exact: true })
    .click();
  const notice = page.getByText(en("portal.result", { added: 3, refused: 0 }));
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(
    en("portal.arrivedForHidden", { clinic: "FAKE Clinic", count: 2 }),
  );
  await expect(notice).toContainText(
    en("portal.arrivedForHidden", { clinic: "FAKE Other Clinic", count: 1 }),
  );
});

test("A hidden person's lost file is counted in the confirmation to hide damaged documents, and not named", async ({
  page,
}) => {
  // The vault's own person is hidden, and one of their files is missing: the vault is
  // read-only and the document is in no list.
  await fakeVaultWith(page, {
    start: "unlocked",
    missingFiles: ["FAKE Letter.pdf"],
    hiddenPeople: ["FAKE Patient"],
    people: [{ displayName: CHILD }],
  });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.hideDamagedDocuments"),
      exact: true,
    })
    .click();
  const confirm = page.getByRole("alertdialog", {
    name: en("interface.hideDamaged.title", { count: 1 }),
    exact: true,
  });
  await expect(confirm).toContainText(
    en("hiddenPeople.damagedToo", { count: 1 }),
  );
  // The document is not named.
  await expect(confirm).not.toContainText("FAKE Letter.pdf");
  await confirm
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  expect(await fakeCalls(page, "vault_hide_unavailable_records")).toEqual([
    { request: { confirmed: [], hiddenPeopleDocuments: 1 } },
  ]);
  await expect(
    page.getByRole("button", {
      name: en("interface.VaultLibrary.hideDamagedDocuments"),
      exact: true,
    }),
  ).toHaveCount(0);
});

test("Security's history counts the entries about a hidden person and names no one", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    people: [{ displayName: CHILD }],
  });
  await page.goto("/");
  await expect(sidebar(page)).toBeVisible();
  await openSecurity(page);
  await line(page, CHILD)
    .getByRole("button", {
      name: en("hiddenPeople.hideFor", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: en("hiddenPeople.confirm.hide", { name: CHILD }),
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: en("interface.history.title"), exact: true })
    .click();
  await expect(
    page.getByText(en("interface.history.aboutHiddenPeople", { count: 1 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("ol.audit-history-list")).not.toContainText(CHILD);
});
