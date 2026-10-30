import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  escapeRegExp,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

// The daily flows on a phone, where the sidebar is a row of section tabs:
// unlock, the tabs, a document's details, hide, Security > Hidden and
// Restore, back, Preferences. The other round-1/2 specs skip the phone
// project; this one runs only there. The native side is faked (the same
// fake; only the viewport differs).

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name !== "phone",
    "the phone layout's navigation; the desktop sidebar is covered by the other specs",
  );
});

const LETTER = "FAKE Letter.pdf";

test("on a phone: unlock, the section tabs, details, hide, Hidden and Restore, back, Preferences", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked" });
  await page.goto("/");
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();

  // The section tabs, with the current one marked.
  const tabs = page.getByRole("navigation", {
    name: en("interface.VaultLibrary.section"),
    exact: true,
  });
  const tab = (key: Parameters<typeof translate>[1]) =>
    tabs.getByRole("button", { name: en(key), exact: true });
  await expect(tab("interface.VaultLibrary.records")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(tab("security.title")).toBeVisible();
  await expect(tab("sidebar.preferences")).toBeVisible();

  // A document's details, and Hide.
  await page.getByRole("button", { name: LETTER, exact: true }).click();
  const details = page.getByRole("dialog", { name: LETTER, exact: true });
  await expect(details).toBeVisible();
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.hidden", { name: LETTER }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: LETTER, exact: true }),
  ).toHaveCount(0);

  // Security > Hidden > Restore, then back.
  await tab("security.title").click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();
  await expect(tab("security.title")).toHaveAttribute("aria-current", "page");
  await page
    .getByRole("button", {
      name: new RegExp(
        `^${escapeRegExp(en("interface.HiddenDocuments.hidden"))}\\s+1\\s+`,
      ),
    })
    .click();
  const listed = page.getByRole("article", {
    name: en("interface.hidden.record", { name: LETTER }),
    exact: true,
  });
  await expect(listed).toBeVisible();
  await listed
    .getByRole("button", {
      name: en("interface.hidden.restore", { name: LETTER }),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.restored", { name: LETTER }), {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: en("hidden.backToSecurity"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("security.title"), level: 1 }),
  ).toBeVisible();

  // Preferences, then Records again, where the document is back.
  await tab("sidebar.preferences").click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.preferences"), level: 1 }),
  ).toBeVisible();
  await tab("interface.VaultLibrary.records").click();
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: LETTER, exact: true }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});
