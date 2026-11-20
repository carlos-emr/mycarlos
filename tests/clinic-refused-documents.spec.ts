import { expect, test, type Locator, type Page } from "@playwright/test";
import { translate } from "./support/fluent";
import {
  FAKE_CLINIC,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// A clinic's documents that failed their checks are remembered (#143): the
// clinic's card says how many, "Try again" forgets them and checks again, and
// a card with none shows neither the line nor the button. The native side is
// faked (support/vaultFake.ts); the remembering itself is covered by the Rust
// tests.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

/** Opens Security: from the sidebar on a desktop, from the section tabs on a
 * phone. */
async function openClinicCard(page: Page, project: string) {
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const entry =
    project === "phone"
      ? page.getByRole("navigation", {
          name: en("interface.VaultLibrary.section"),
          exact: true,
        })
      : sidebar(page);
  await entry
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("portal.title"), exact: true }),
  ).toBeVisible();
}

const tryAgain = (page: Page) =>
  page.getByRole("button", {
    name: en("portal.tryAgainFor", { clinic: FAKE_CLINIC }),
    exact: true,
  });

const line = (page: Page, count: number): Locator =>
  page.getByText(en("portal.refusedDocuments", { count }), { exact: true });

for (const count of [1, 2]) {
  test(`the clinic card says ${count} document${count === 1 ? "" : "s"} could not be verified, and Try again forgets them and puts the focus on the clinic's heading`, async ({
    page,
  }, testInfo) => {
    await fakeVaultWith(page, {
      start: "unlocked",
      portal: "linked",
      refusedDeliveries: count,
    });
    await openClinicCard(page, testInfo.project.name);
    await expect(line(page, count)).toBeVisible();
    const button = tryAgain(page);
    await expect(button).toHaveText(en("portal.tryAgain"));
    // The line describes the button, so it is read with it.
    await expect(button).toHaveAccessibleDescription(
      en("portal.refusedDocuments", { count }),
    );
    await button.click();
    await expect(line(page, count)).toHaveCount(0);
    await expect(tryAgain(page)).toHaveCount(0);
    // Nothing is left to try again with: the focus goes to the clinic's
    // heading, as the app does for a card that lost its button.
    await expect(
      page.getByRole("heading", { name: FAKE_CLINIC, exact: true }),
    ).toBeFocused();
  });
}

test("a clinic card with no refused documents shows no line and no Try again", async ({
  page,
}, testInfo) => {
  await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
  await openClinicCard(page, testInfo.project.name);
  await expect(page.getByText(en("portal.approved"))).toBeVisible();
  await expect(page.locator(".portal-refused")).toHaveCount(0);
  await expect(tryAgain(page)).toHaveCount(0);
});
