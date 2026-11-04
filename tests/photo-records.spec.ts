import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  escapeRegExp,
  fakeCalls,
  fakeSnapshot,
  fakeVaultWith,
  openDetails,
  sidebar,
} from "./support/vaultFake";

// A photo taken with the camera, once it is in the vault, is a document like
// any other, except that its details offer View photo instead of Read: the
// viewer shows it and closes back to the details; it is moved from its
// details and hidden, Security > Hidden lists it with where it was, and the
// history records each event under its name. On the phone project, the
// viewer is checked in phone-flows.spec.ts and the camera itself in
// camera-photo.spec.ts. The native side is faked (support/vaultFake.ts):
// the photo is a small JPEG made at run time.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the phone's photo viewer is checked in phone-flows.spec.ts",
  );
});

const PHOTO = "FAKE Photo, Oct 5, 2026.jpg";

test("a photo's details offer View photo, the viewer shows and closes; moved and hidden from its details, Hidden and the history name it", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", photos: [PHOTO] });
  await page.goto("/");
  const photoId = (await fakeSnapshot(page)).records.find(
    (record) => record.displayName === PHOTO,
  )?.id;
  expect(photoId).toBeDefined();

  // The details: a photo is viewed, not read.
  const details = await openDetails(page, PHOTO);
  const view = details.getByRole("button", {
    name: en("interface.RecordDetails.viewPhoto"),
    exact: true,
  });
  await expect(view).toBeVisible();
  await expect(
    details.getByRole("button", {
      name: en("interface.RecordDetails.read"),
      exact: true,
    }),
  ).toHaveCount(0);
  expect(await fakeCalls(page, "vault_is_photo")).toEqual([
    { request: { recordId: photoId } },
  ]);

  // The viewer: the photo itself, from the vault, then Close goes back.
  await view.click();
  const viewer = page.getByRole("dialog", { name: PHOTO, exact: true });
  const photo = viewer.getByRole("img", {
    name: en("photo.alt", { name: PHOTO }),
  });
  await expect(photo).toBeVisible();
  expect(
    await photo.evaluate((image: HTMLImageElement) => image.naturalWidth),
  ).toBeGreaterThan(0);
  expect(await fakeCalls(page, "vault_view_photo")).toEqual([
    { request: { recordId: photoId } },
  ]);
  await viewer
    .getByRole("button", { name: en("photo.close"), exact: true })
    .click();
  await expect(photo).toBeHidden();
  await expect(view).toBeVisible();

  // Moved into a folder from its details (one person: the plain folder
  // select), and said.
  await details
    .getByRole("combobox")
    .first()
    .selectOption({ label: "FAKE Results" });
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.move"),
      exact: true,
    })
    .click();
  await expect(
    details.getByRole("status").filter({
      hasText: en("interface.VaultLibrary.documentMoved"),
    }),
  ).toBeVisible();
  // The details now place it in the folder.
  await expect(
    details.getByRole("definition").filter({ hasText: "FAKE Results" }),
  ).toHaveCount(1);
  expect((await fakeCalls(page, "vault_assign_folders")).at(-1)).toEqual({
    request: { recordId: photoId, folderIds: [FAKE_IDS.folder] },
  });

  // Hidden from the same details: said, and gone from view.
  await details
    .getByRole("button", {
      name: en("interface.RecordDetails.hide"),
      exact: true,
    })
    .click();
  await expect(details).toBeHidden();
  await expect(
    page.getByText(en("interface.notice.hidden", { name: PHOTO }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: PHOTO, exact: true }),
  ).toHaveCount(0);
  expect(await fakeCalls(page, "vault_hide_record")).toEqual([
    { request: { recordId: photoId } },
  ]);

  // Security > Hidden lists it, with the folder it was in.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  const hiddenLabel = en("interface.HiddenDocuments.hidden");
  await page
    .getByRole("button", {
      name: new RegExp(`^${escapeRegExp(hiddenLabel)}\\s+1\\s+`),
    })
    .click();
  await expect(
    page.getByRole("heading", { name: hiddenLabel, exact: true, level: 1 }),
  ).toBeVisible();
  const listed = page.getByRole("article", {
    name: en("interface.hidden.record", { name: PHOTO }),
    exact: true,
  });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText("FAKE Results");

  // The history: hidden, then moved, newest first, each under the photo's
  // name (a photo already in the vault has no import event here), and the
  // vault's creation last.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await page
    .getByRole("button", { name: en("interface.history.title"), exact: true })
    .click();
  const items = page.locator("ol.audit-history-list > li");
  await expect(items.locator("h2")).toHaveText([
    en("interface.history.event.hidden"),
    en("interface.history.event.moved"),
    en("interface.history.event.created"),
  ]);
  for (const index of [0, 1])
    await expect(items.nth(index)).toContainText(PHOTO);
  await expect(items.nth(0)).toContainText(en("interface.history.how.patient"));
  await expect(items.nth(1)).toContainText("FAKE Results");
  await expectOnlyFakedCommands(page);
});
