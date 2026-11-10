import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";

// Changing the passphrase in Security: the form refuses what it can see is
// wrong (too short, not matching) before asking the native side, a wrong
// current passphrase is refused by the native side and said, and after a
// change only the new passphrase opens the vault. The native side is faked
// (support/vaultFake.ts).

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

const NEW_PASSPHRASE = "FAKE new passphrase for this vault";
const MIN = 15;

test("Change passphrase: the form's own checks, a wrong current passphrase said, then only the new one opens the vault", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await sidebar(page)
    .getByRole("button", { name: en("security.title"), exact: true })
    .click();
  const section = page.locator("section.setting-row").filter({
    has: page.getByRole("heading", {
      name: en("security.passphrase.title"),
      exact: true,
    }),
  });
  await expect(
    section.getByText(en("security.passphrase.rules", { min: MIN }), {
      exact: true,
    }),
  ).toBeVisible();
  const current = section.getByLabel(en("security.passphrase.current"), {
    exact: true,
  });
  const next = section.getByLabel(en("passphrase.new.label"), { exact: true });
  const confirm = section.getByLabel(en("passphrase.confirmNew.label"), {
    exact: true,
  });
  const submit = section.getByRole("button", {
    name: en("security.passphrase.submit"),
    exact: true,
  });

  // Too short: said, and nothing is sent.
  await current.fill(FAKE_PASSPHRASE);
  await next.fill("FAKE short");
  await confirm.fill("FAKE short");
  await expect(
    section.getByText(en("security.passphrase.newTooShort", { min: MIN }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();

  // Not matching: said, and nothing is sent.
  await next.fill(NEW_PASSPHRASE);
  await confirm.fill(NEW_PASSPHRASE + " typo");
  await expect(
    section.getByText(en("security.passphrase.mismatch"), { exact: true }),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  expect(await fakeCalls(page, "vault_change_passphrase")).toEqual([]);

  // A wrong current passphrase: the native side refuses, and it is said.
  await confirm.fill(NEW_PASSPHRASE);
  await current.fill(FAKE_PASSPHRASE + " wrong");
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.getByText(en("native.error.16"), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_change_passphrase")).toHaveLength(1);

  // The right one: changed, and said.
  await current.fill(FAKE_PASSPHRASE);
  await next.fill(NEW_PASSPHRASE);
  await confirm.fill(NEW_PASSPHRASE);
  await submit.click();
  await expect(
    page.getByText(en("interface.VaultLibrary.passphraseChanged"), {
      exact: true,
    }),
  ).toBeVisible();
  expect((await fakeCalls(page, "vault_change_passphrase")).at(-1)).toEqual({
    request: {
      currentPassphrase: FAKE_PASSPHRASE,
      newPassphrase: NEW_PASSPHRASE,
    },
  });
  // The form keeps no passphrase after a change.
  await expect(current).toHaveValue("");
  await expect(next).toHaveValue("");
  await expect(confirm).toHaveValue("");

  // Lock: the old passphrase is refused, the new one opens the vault.
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.unlockedLockNow"),
      exact: true,
    })
    .click();
  const passphrase = page.getByLabel(en("passphrase.label"), { exact: true });
  const unlock = page.getByRole("button", { name: en("unlock.submit") });
  await passphrase.fill(FAKE_PASSPHRASE);
  await unlock.click();
  await expect(
    page.getByText(en("native.error.16"), { exact: true }),
  ).toBeVisible();
  await passphrase.fill(NEW_PASSPHRASE);
  await unlock.click();
  await expect(myRecords(page)).toBeVisible();
  await expectOnlyFakedCommands(page);
});
