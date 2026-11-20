import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  FAKE_SPEED_REPORT,
  fakeCalls,
  fakeSettle,
  fakeVaultWith,
  myRecords,
  refusal,
  scriptFake,
  sidebar,
} from "./support/vaultFake";

// The passphrase speed test in Security, for testers (#39): measuring while
// the device works, then one line to copy into the benchmark record; a
// native side busy with another check says so; and a test answered "locked"
// (the automatic lock does not wait for it) locks the app instead of leaving
// the library on screen. The native side is faked (support/vaultFake.ts).

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

async function openSpeedTest(page: Page) {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  const section = page.getByRole("heading", {
    name: en("security.speed.title"),
    exact: true,
  });
  await expect(section).toBeVisible();
  const run = page.getByRole("button", {
    name: en("security.speed.run"),
    exact: true,
  });
  // The status line next to the button (SecuritySettings.tsx).
  const status = page.locator(".native-dialog-status[role=status]");
  return { run, status };
}

/** The line as Security writes it (speedTestLine in SecuritySettings.tsx).
 * The samples are joined as plain numbers where Security formats each for
 * the locale: the same text only because FAKE_SPEED_REPORT stays under a
 * thousand, where no locale puts a separator. */
function reportLine(report: typeof FAKE_SPEED_REPORT) {
  return [
    en("interface.speed.runs", {
      count: report.samplesMs.length,
      samples: report.samplesMs.join(", "),
    }),
    en("interface.speed.median", {
      median: report.medianMs,
      max: report.maxMs,
    }),
    en("interface.speed.parameters", {
      memory: report.memoryKib / 1024,
      iterations: report.iterations,
      lanes: report.lanes,
    }),
    en("interface.speed.platform", {
      platform: report.platform,
      architecture: report.architecture,
      version: report.appVersion,
    }),
    en("interface.SecuritySettings.evaluationBuild") + ".",
  ].join(" ");
}

test("the speed test says it is measuring and holds its button until the device answers, then gives the device's line; a native side busy with another check is said", async ({
  page,
}) => {
  const { run, status } = await openSpeedTest(page);

  // Running: measuring, and the button is held until the answer comes.
  await scriptFake(page, "kdf_benchmark", { pending: true });
  await run.click();
  await expect(status).toHaveText(en("security.speed.measuring"));
  await expect(run).toBeDisabled();
  expect(await fakeCalls(page, "kdf_benchmark")).toHaveLength(1);

  // Done: the line a tester copies, from the device's own numbers.
  await fakeSettle(page, "kdf_benchmark", { resolve: FAKE_SPEED_REPORT });
  await expect(status).toHaveText(reportLine(FAKE_SPEED_REPORT));
  await expect(run).toBeEnabled();

  // The native side already busy with a passphrase check: said, no line.
  await scriptFake(page, "kdf_benchmark", {
    reject: refusal("busy", "native.error.11"),
  });
  await run.click();
  // Said beside the button (other forms on Security keep their own alerts).
  await expect(
    page.getByRole("alert").filter({ hasText: en("native.error.11") }),
  ).toBeVisible();
  await expect(status).toHaveText("");
  await expect(run).toBeEnabled();
  expect(await fakeCalls(page, "kdf_benchmark")).toHaveLength(2);
  // The vault itself is untouched by a speed test.
  expect(await fakeCalls(page, "vault_lock")).toEqual([]);
  await expectOnlyFakedCommands(page);
});

test("a speed test answered 'locked' locks the app too, and the vault unlocks again afterwards", async ({
  page,
}) => {
  const { run } = await openSpeedTest(page);
  await scriptFake(page, "kdf_benchmark", {
    reject: refusal("locked", "native.error.36"),
  });
  await run.click();
  await expect(
    page.getByRole("heading", { name: en("unlock.title"), exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(en("notice.locked"), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  await expectOnlyFakedCommands(page);
});

test("a late 'locked' answer, after leaving Security or after the vault locked by itself, locks nothing more", async ({
  page,
}) => {
  const { run } = await openSpeedTest(page);

  // Still measuring when the patient leaves Security: its answer, "locked",
  // lands on a screen that is gone, and the library stays open.
  await scriptFake(page, "kdf_benchmark", { pending: true });
  await run.click();
  await sidebar(page)
    .getByRole("button", { name: /^My records\b/ })
    .click();
  await expect(myRecords(page)).toBeVisible();
  await fakeSettle(page, "kdf_benchmark", {
    reject: refusal("locked", "native.error.36"),
  });
  await expect(myRecords(page)).toBeVisible();
  expect(await fakeCalls(page, "vault_lock")).toEqual([]);

  // Still measuring when the vault is locked by hand: the late "locked"
  // answer must not lock a second time.
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  await scriptFake(page, "kdf_benchmark", { pending: true });
  await run.click();
  await page
    // The window's own Lock now, named by its words (#121).
    .locator(".titlebar")
    .getByRole("button", { name: en("security.lockNow"), exact: true })
    .click();
  const unlockTitle = page.getByRole("heading", {
    name: en("unlock.title"),
    exact: true,
  });
  await expect(unlockTitle).toBeVisible();
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  await fakeSettle(page, "kdf_benchmark", {
    reject: refusal("locked", "native.error.36"),
  });
  await expect(unlockTitle).toBeVisible();
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  expect(await fakeCalls(page, "kdf_benchmark")).toHaveLength(2);
  await expectOnlyFakedCommands(page);
});
