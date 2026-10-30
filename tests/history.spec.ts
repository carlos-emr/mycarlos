import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  fakePickFiles,
  fakeVaultWith,
  myRecords,
  openDetails,
  sidebar,
} from "./support/vaultFake";

// The audit history (#71): after a session of actions, Security > Audit
// history lists what happened, newest first, with the names as they were;
// and a damaged history says what cannot be shown (D129/D146). The native
// side is faked (support/vaultFake.ts) and writes its own history as the
// vault does; this is about what the screen shows after actions, not about
// how a screen reader reads it (screen-reader-flows covers that).

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

async function openHistory(page: import("@playwright/test").Page) {
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByRole("button", { name: en("interface.history.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: en("interface.history.title"),
      level: 1,
    }),
  ).toBeVisible();
  return page.locator("ol.audit-history-list > li");
}

test("after adding, renaming, moving, hiding and backing up, the history lists each event newest first with the names as they were", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();

  // The actions.
  await fakePickFiles(page, ["FAKE Scan.pdf"]);
  await page
    .getByRole("button", {
      name: en("interface.VaultApp.chooseFilesToImport"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.imported", { count: 1 }), {
      exact: true,
    }),
  ).toBeVisible();
  let details = await openDetails(page, "FAKE Scan.pdf");
  await details
    .getByRole("button", { name: en("rename.title.document"), exact: true })
    .click();
  const rename = page.getByRole("dialog", {
    name: en("rename.title.document"),
    exact: true,
  });
  await rename
    .getByLabel(en("rename.label.document"), { exact: true })
    .fill("FAKE Scan renamed.pdf");
  await rename
    .getByRole("button", { name: en("rename.save"), exact: true })
    .click();
  await expect(rename).toBeHidden();
  // The details stay open after a rename: close them and open the renamed
  // document's afresh.
  await page
    .getByRole("button", {
      name: en("interface.RecordDetails.closeDocumentDetails"),
      exact: true,
    })
    .click();
  details = await openDetails(page, "FAKE Scan renamed.pdf");
  // One person: the move control is the plain folder select.
  await details.getByRole("combobox").first().selectOption({
    label: "FAKE Results",
  });
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.move"),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "FAKE Scan renamed.pdf", exact: true }),
  ).toHaveCount(0);
  // The details stay open after a move too.
  await page
    .getByRole("button", {
      name: en("interface.RecordDetails.closeDocumentDetails"),
      exact: true,
    })
    .click();
  details = await openDetails(page, "FAKE Letter.pdf");
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.hidden", { name: "FAKE Letter.pdf" }), {
      exact: true,
    }),
  ).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByRole("button", { name: en("security.backup.save"), exact: true })
    .click();
  await expect(
    page.getByText(
      en("interface.VaultLibrary.encryptedBackupSavedKeepItSomewhereOther"),
      { exact: true },
    ),
  ).toBeVisible();

  // The history: newest first, each with its name as it was then.
  const items = await openHistory(page);
  const headings = items.locator("h2");
  await expect(headings).toHaveText([
    en("interface.history.event.backupSaved"),
    en("interface.history.event.hidden"),
    en("interface.history.event.moved"),
    en("interface.history.event.renamed"),
    en("interface.history.event.imported"),
    en("interface.history.event.created"),
  ]);
  const detail = (index: number, label: string) =>
    items
      .nth(index)
      .locator("dl > div")
      .filter({ has: page.locator("dt").getByText(label, { exact: true }) })
      .locator("dd");
  await expect(detail(0, en("interface.history.place"))).toHaveText(
    "FAKE Backups/myCarlos backup.mycarlosbackup",
  );
  await expect(detail(1, en("interface.history.name"))).toHaveText(
    "FAKE Letter.pdf",
  );
  await expect(detail(1, en("interface.history.how"))).toHaveText(
    en("interface.history.how.patient"),
  );
  await expect(detail(2, en("interface.history.name"))).toHaveText(
    "FAKE Scan renamed.pdf",
  );
  await expect(detail(2, en("interface.history.to"))).toContainText(
    "FAKE Results",
  );
  await expect(detail(3, en("interface.history.name"))).toHaveText(
    "FAKE Scan renamed.pdf",
  );
  await expect(detail(3, en("interface.history.previousName"))).toHaveText(
    "FAKE Scan.pdf",
  );
  await expect(detail(4, en("interface.history.name"))).toHaveText(
    "FAKE Scan.pdf",
  );
  await expect(detail(4, en("interface.history.how"))).toHaveText(
    en("interface.history.how.picked"),
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});

test("a damaged history says which events cannot be shown and lists only what its end proves", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", damagedHistory: true });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  // One action after the damage, so the end has something to prove.
  const details = await openDetails(page, "FAKE Letter.pdf");
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("interface.notice.hidden", { name: "FAKE Letter.pdf" }), {
      exact: true,
    }),
  ).toBeVisible();
  const items = await openHistory(page);
  await expect(page.getByRole("alert")).toContainText(
    /^Part of this history is damaged\. Events before .+ can't be checked and aren't shown\.$/,
  );
  // The vault opened before the damage: only the hide is proven.
  await expect(items.locator("h2")).toHaveText([
    en("interface.history.event.hidden"),
  ]);
  await expectOnlyFakedCommands(page);
});
