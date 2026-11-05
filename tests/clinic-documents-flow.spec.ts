import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  FAKE_CLINIC,
  FAKE_CLINIC_DOCUMENT,
  FAKE_DEVICE_CODE,
  escapeRegExp,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  refusal,
  scriptFake,
  sidebar,
} from "./support/vaultFake";

// Clinic documents, myCarlos's anchor workflow: linking this device to a
// clinic's patient portal in Security (a refused code is not kept, the link,
// asking the clinic to approve the device, copying its device code), then
// checking for new documents from the library, which arrive in Shared with
// me. The native side is faked (support/vaultFake.ts); Rust tests cover the
// portal protocol, keys and verification. The panel's layout and spoken
// names are other specs' (open PRs #148, #149, #153 at the time of writing).

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

const PORTAL = "https://fake-clinic.example.com";

/** The sidebar's My records, whose name ends with how many it holds. */
const openMyRecords = (page: Page) =>
  sidebar(page)
    .getByRole("button", {
      name: new RegExp(`^${escapeRegExp(en("sidebar.myRecords"))}\\b`),
    })
    .click();

test("links this device to a clinic: a refused code is not kept, then the link, the approval request and the device code", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fakeVaultWith(page, { start: "unlocked", portal: "unlinked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  // Nothing is linked yet, so the library offers no check.
  await expect(
    page.getByRole("button", { name: en("portal.check"), exact: true }),
  ).toHaveCount(0);

  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("portal.title"), exact: true }),
  ).toBeVisible();
  const address = page.getByLabel(en("portal.address"), { exact: true });
  const code = page.getByLabel(en("portal.code"), { exact: true });
  const device = page.getByLabel(en("portal.deviceName"), { exact: true });
  const link = page.getByRole("button", {
    name: en("portal.link"),
    exact: true,
  });
  // The device is named after this computer's system to begin with.
  await expect(device).toHaveValue(/Windows/);
  const deviceName = await device.inputValue();

  // The portal refuses the code: said, and the one-use code is not kept.
  await scriptFake(page, "vault_portal_link", {
    reject: refusal("portal_link_code_rejected", "portal.errorCodeRejected"),
  });
  await address.fill(PORTAL);
  await code.fill("FAKE-CODE-1");
  await link.click();
  await expect(
    page.getByText(en("portal.errorCodeRejected"), { exact: true }),
  ).toBeVisible();
  await expect(code).toHaveValue("");
  await expect(address).toHaveValue(PORTAL);
  await expect(
    page.getByRole("heading", { name: FAKE_CLINIC, exact: true }),
  ).toHaveCount(0);

  // A new code links it: the clinic is shown with this device's code, not
  // yet approved.
  await code.fill("FAKE-CODE-2");
  await link.click();
  const clinic = page.getByRole("heading", {
    name: FAKE_CLINIC,
    exact: true,
    level: 3,
  });
  await expect(clinic).toBeVisible();
  await expect(code).toHaveValue("");
  await expect(
    page.getByText(en("portal.errorCodeRejected"), { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(en("portal.notRequested"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel(en("portal.deviceCode"), { exact: true }),
  ).toHaveValue(FAKE_DEVICE_CODE);
  expect(await fakeCalls(page, "vault_portal_link")).toEqual([
    {
      request: {
        portalBase: PORTAL,
        code: "FAKE-CODE-1",
        deviceName,
        profileId: null,
      },
    },
    {
      request: {
        portalBase: PORTAL,
        code: "FAKE-CODE-2",
        deviceName,
        profileId: null,
      },
    },
  ]);

  // Asking the clinic to approve this device.
  await page
    .getByRole("button", { name: en("portal.requestApproval"), exact: true })
    .click();
  await expect(
    page.getByText(en("portal.awaiting"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(en("portal.notRequested"), { exact: true }),
  ).toHaveCount(0);
  expect(await fakeCalls(page, "vault_request_device_approval")).toEqual([
    { linkId: FAKE_IDS.link },
  ]);

  // The device code, copied for the clinic's staff.
  await page
    .getByRole("button", { name: en("portal.copy"), exact: true })
    .click();
  await expect(
    page.getByText(en("portal.copied"), { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    FAKE_DEVICE_CODE,
  );

  // Once linked, the library offers the check beside its search.
  await openMyRecords(page);
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: en("portal.check"), exact: true }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("Check for new documents brings a clinic's document into Shared with me, and says when a check fails", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const check = page.getByRole("button", {
    name: en("portal.check"),
    exact: true,
  });

  // One new document, verified as the clinic's.
  await check.click();
  await expect(
    page.getByText(en("portal.result", { added: 1, refused: 0 }), {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_check_documents")).toEqual([{}]);
  const shared = en("interface.LibrarySidebar.sharedWithMe");
  await sidebar(page)
    .getByRole("button", { name: shared, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: shared, exact: true, level: 1 }),
  ).toBeVisible();
  const arrived = page.getByRole("article", {
    name: en("library.document.label", { name: FAKE_CLINIC_DOCUMENT }),
    exact: true,
  });
  await expect(arrived).toBeVisible();
  await expect(arrived).toContainText(
    en("portal.sourceVerified", { clinic: FAKE_CLINIC }),
  );

  // Back in My records: a second check finds nothing new.
  await openMyRecords(page);
  await expect(myRecords(page)).toBeVisible();
  await check.click();
  await expect(
    page.getByText(en("portal.result", { added: 0, refused: 0 }), {
      exact: true,
    }),
  ).toBeVisible();

  // A check that fails (a document that could not be verified): said, and
  // the check can be tried again.
  await scriptFake(page, "vault_check_documents", {
    reject: refusal("pickup_refused", "portal.errorRefused"),
  });
  await check.click();
  await expect(
    page.getByText(en("portal.errorRefused"), { exact: true }),
  ).toBeVisible();
  await expect(check).toBeEnabled();
  expect(await fakeCalls(page, "vault_check_documents")).toHaveLength(3);
  await expectOnlyFakedCommands(page);
});
