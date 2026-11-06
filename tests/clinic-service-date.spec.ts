import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_CLINIC_DOCUMENT,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// A clinic document's service date, as the clinic sent it, shown beside the
// document in the library and in the reader; "Date not recorded" when the
// clinic sent none; and no such line for a document the patient added.
// Until now only the unit tests covered it. The native side is faked
// (support/vaultFake.ts). FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const serviceDate = (date: string) => en("portal.serviceDate", { date });

/** Checks the linked clinic, then opens Shared with me, where its document
 * arrives, and returns that document's row. */
async function checkedDocument(page: Page, clinicServiceDate: string) {
  await fakeVaultWith(page, {
    start: "unlocked",
    portal: "linked",
    clinicServiceDate,
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await page
    .getByRole("button", { name: en("portal.check"), exact: true })
    .click();
  await expect(
    page.getByText(en("portal.result", { added: 1, refused: 0 }), {
      exact: true,
    }),
  ).toBeVisible();
  const shared = en("interface.LibrarySidebar.sharedWithMe");
  await sidebar(page)
    .getByRole("button", { name: shared, exact: true })
    .click();
  const row = page.getByRole("article", {
    name: en("library.document.label", { name: FAKE_CLINIC_DOCUMENT }),
    exact: true,
  });
  await expect(row).toBeVisible();
  return row;
}

async function openReader(page: Page) {
  await page
    .getByRole("button", { name: FAKE_CLINIC_DOCUMENT, exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: FAKE_CLINIC_DOCUMENT,
    exact: true,
  });
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  return page.getByRole("dialog", { name: FAKE_CLINIC_DOCUMENT, exact: true });
}

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the PDF reader opens on a computer",
  );
});

test("a clinic document shows the service date the clinic sent, in the library and the reader", async ({
  page,
}) => {
  const row = await checkedDocument(page, "2026-10-13");
  await expect(row).toContainText(serviceDate("2026-10-13"));
  const reader = await openReader(page);
  await expect(reader).toContainText(serviceDate("2026-10-13"));
  await expectOnlyFakedCommands(page);
});

test("a clinic document whose service date was not recorded says so", async ({
  page,
}) => {
  const row = await checkedDocument(page, "");
  const unknown = serviceDate(en("portal.dateNotRecorded"));
  await expect(row).toContainText(unknown);
  await expect(await openReader(page)).toContainText(unknown);
});

test("a document the patient added has no service date line", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await expect(page.getByText(/^Service date:/, { exact: false })).toHaveCount(
    0,
  );
});
