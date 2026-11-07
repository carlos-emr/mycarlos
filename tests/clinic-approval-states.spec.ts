import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  refusal,
  scriptFake,
  sidebar,
  escapeRegExp,
} from "./support/vaultFake";

// A clinic link whose approval request did not end in approval: what
// Security says for an expired, cancelled or refused request, when a new
// request may be started (expired and cancelled, not refused), what
// starting one does, and a restart the native side refuses. The native side
// is faked (support/vaultFake.ts); the approval protocol itself is covered
// by the Rust tests and the portal's own checks.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

/** A request awaiting the clinic: "saved" at first, and "the clinic has it"
 * once the clinic view's automatic check (#137) has confirmed it. */
const awaiting = (page: Page) =>
  page.getByText(
    new RegExp(
      `^(${escapeRegExp(en("portal.awaiting"))}|${escapeRegExp(en("portal.awaitingClinic"))})$`,
    ),
  );

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "these flows are checked on the desktop project only; the vault screens' phone layout is covered by large-text-accessibility.spec.ts",
  );
});

async function openClinicDocuments(page: Page) {
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("portal.title"), exact: true }),
  ).toBeVisible();
  return {
    // These links already sent a request, so the ordinary one is offered
    // as retrying the saved request (#136).
    request: page.getByRole("button", {
      name: en("portal.retryApproval"),
      exact: true,
    }),
    restart: page.getByRole("button", {
      name: en("portal.restartApproval"),
      exact: true,
    }),
  };
}

// #137's card words: an expired request names the button that starts a
// new one.
for (const [status, said] of [
  ["expired", "portal.approvalExpiredCard"],
  ["cancelled", "portal.approvalCancelled"],
] as const) {
  test(`${status === "expired" ? "an expired" : "a cancelled"} approval request is said, cannot be sent again, and a new one can be started, which is then awaiting the clinic`, async ({
    page,
  }) => {
    await fakeVaultWith(page, {
      start: "unlocked",
      portal: "linked",
      approval: { status },
    });
    const { request, restart } = await openClinicDocuments(page);
    await expect(page.getByText(en(said), { exact: true })).toBeVisible();
    await expect(request).toBeDisabled();
    await expect(restart).toBeEnabled();

    await restart.click();
    await expect(awaiting(page)).toBeVisible();
    // Require the fake-driven automatic read as well as its confirmed text.
    await expect
      .poll(() => fakeCalls(page, "vault_refresh_device_approval"), {
        timeout: 15_000,
      })
      .toContainEqual({ linkId: FAKE_IDS.link });
    await expect(
      page.getByText(en("portal.awaitingClinic"), { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(en(said), { exact: true })).toHaveCount(0);
    expect(await fakeCalls(page, "vault_restart_device_approval")).toEqual([
      { linkId: FAKE_IDS.link },
    ]);
    // One new request at a time: no second restart, and the ordinary
    // request can be sent again.
    await expect(restart).toHaveCount(0);
    await expect(request).toBeEnabled();
    await expectOnlyFakedCommands(page);
  });
}

test("a refused approval request is said, with no way to send or start one: the clinic decides", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    portal: "linked",
    approval: { status: "refused" },
  });
  const { request, restart } = await openClinicDocuments(page);
  await expect(
    page.getByText(en("portal.approvalRefused"), { exact: true }),
  ).toBeVisible();
  await expect(request).toBeDisabled();
  await expect(restart).toHaveCount(0);
  expect(await fakeCalls(page, "vault_restart_device_approval")).toEqual([]);
  await expectOnlyFakedCommands(page);
});

test("a restart the native side refuses leaves the expired request as it was", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    portal: "linked",
    approval: { status: "expired" },
  });
  const { request, restart } = await openClinicDocuments(page);
  await scriptFake(page, "vault_restart_device_approval", {
    reject: refusal("invalid", "native.error.19"),
  });
  await restart.click();
  await expect(
    page.getByText(en("native.error.19"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(en("portal.approvalExpiredCard"), { exact: true }),
  ).toBeVisible();
  await expect(restart).toBeEnabled();
  await expect(request).toBeDisabled();
  expect(await fakeCalls(page, "vault_restart_device_approval")).toHaveLength(
    1,
  );
  await expectOnlyFakedCommands(page);
});
