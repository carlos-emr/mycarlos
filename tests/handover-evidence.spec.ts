import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakeVaultWith,
  myRecords,
  openDetails,
  sidebar,
} from "./support/vaultFake";

// What a document that came in a handover file shows (#360, PR 6). Anyone who holds the file's
// key can write evidence that stands up by itself, so the screens say what the FILE says and
// that this vault has not checked it: never "Verified", no check mark. Only a link of this
// vault to the same clinic, holding its signing key, makes it Verified. FAKE data only.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const LETTER = "FAKE Letter.pdf";

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "checked on the desktop project; the line wraps like any source line",
  );
});

test("A document that came in a file shows only what the file says, as unverified and without a check mark, however consistent its evidence", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", fileSays: [LETTER] });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const details = await openDetails(page, LETTER);
  // The file's claim, in words that do not say the vault checked it.
  const claim = details.locator(".record-file-claim");
  await expect(claim).toContainText(
    "says it was checked on the device it came from",
  );
  await expect(claim).toContainText("This vault has not checked it.");
  // Unverified, never Verified, and no mark.
  await expect(
    details.getByText(en("library.status.unverified"), { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText(en("library.status.verified"), { exact: true }),
  ).toHaveCount(0);
  await expect(details.locator(".record-source.verified")).toHaveCount(0);
  await expect(details.locator(".record-file-claim svg")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("When a link of this vault to the same clinic holds the key, the document becomes Verified, the claim goes, and the vault says so", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    portal: "linked",
    fileSays: [LETTER],
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await page.evaluate(() =>
    (
      Reflect.get(window, "__fakeVault") as {
        verifyCarried: (clinic: string) => void;
      }
    ).verifyCarried("FAKE Demo Clinic"),
  );
  // The vault learns it when it reads itself again: a check for new documents does.
  await sidebar(page)
    .getByRole("button", {
      name: en("interface.LibrarySidebar.sharedWithMe"),
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: en("portal.check"), exact: true })
    .click();
  await expect(
    page.getByText(
      en("handover.nowVerified", { clinic: "FAKE Demo Clinic", count: 1 }),
    ),
  ).toBeVisible();
  await sidebar(page)
    .getByRole("button", {
      name: new RegExp(
        `^${en("sidebar.myRecords").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      ),
    })
    .click();
  const details = await openDetails(page, LETTER);
  await expect(
    details.getByText(en("library.status.verified"), { exact: true }),
  ).toBeVisible();
  await expect(details.locator(".record-file-claim")).toHaveCount(0);
});
