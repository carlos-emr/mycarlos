import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeCommands,
  fakeOtherVault,
  fakeUnlisted,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

// Several vaults on one device (#357): "Use a different vault" on the unlock screen (by keyboard
// alone), "Find my other vaults" and the names it asks for, and the setup screen, which the native
// add reaches only from an open vault and which it locks first. The native side is faked
// (support/vaultFake.ts); the real rules are Rust tests.

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

const disclosure = (page: import("@playwright/test").Page) =>
  page.getByText(en("unlock.otherVault.summary"), { exact: true });
const passphraseBox = (page: import("@playwright/test").Page) =>
  page.getByLabel(en("passphrase.label"), { exact: true });

test("a vault is opened by its name, by keyboard alone, and an empty name still opens the main one", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked" });
  await page.goto("/");
  await fakeOtherVault(page, "FAKE Garden", "FAKE garden passphrase");
  // The disclosure is closed, and its name field is not on the page until it is opened.
  await expect(disclosure(page)).toBeVisible();
  await expect(
    page.getByLabel(en("unlock.otherVault.name"), { exact: true }),
  ).toBeHidden();
  await disclosure(page).focus();
  await page.keyboard.press("Enter");
  await expectNoAxeViolations(
    page,
    "the unlock screen with the name field open",
  );
  await page.getByLabel(en("unlock.otherVault.name"), { exact: true }).focus();
  await page.keyboard.type("  fake garden ");
  await passphraseBox(page).focus();
  await page.keyboard.type("FAKE garden passphrase");
  await page.keyboard.press("Enter");
  await expect(myRecords(page)).toBeVisible();
  const named = await fakeCalls(page, "vault_unlock_named");
  expect(named).toHaveLength(1);
  expect(named[0]).toEqual({
    request: { name: "fake garden", passphrase: "FAKE garden passphrase" },
  });
});

test("a wrong name and a wrong passphrase are one and the same refusal", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked" });
  await page.goto("/");
  await fakeOtherVault(page, "FAKE Garden", "FAKE garden passphrase");
  await disclosure(page).click();
  const nameBox = page.getByLabel(en("unlock.otherVault.name"), {
    exact: true,
  });
  const submit = page.getByRole("button", {
    name: en("unlock.submit"),
    exact: true,
  });
  await nameBox.fill("No such vault");
  await passphraseBox(page).fill("FAKE garden passphrase");
  await submit.click();
  // The unlock screen's one message line.
  const message = page.locator("#auth-notice");
  await expect(message).not.toBeEmpty();
  const wrongName = await message.innerText();
  await nameBox.fill("FAKE Garden");
  await passphraseBox(page).fill("wrong passphrase");
  await submit.click();
  await expect(message).toHaveText(wrongName);
  await expect(myRecords(page)).toBeHidden();
});

test("Find my other vaults says counts only, asks a number for each, and saves the names together", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked" });
  await page.goto("/");
  await fakeUnlisted(page, ["slot-a", "slot-b"], 1, 2);
  await disclosure(page).click();
  await passphraseBox(page).fill(FAKE_PASSPHRASE);
  await page
    .getByRole("button", {
      name: en("unlock.otherVault.findButton"),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(en("unlock.otherVault.found", { count: 2 }), {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(en("unlock.otherVault.notOpened", { count: 1 }), {
      exact: true,
    }),
  ).toBeVisible();
  // The opaque ids are never on the page.
  expect(await page.locator("body").innerText()).not.toContain("slot-a");
  await page
    .getByLabel(en("unlock.otherVault.nameLabel", { number: 1, count: 2 }), {
      exact: true,
    })
    .fill("FAKE Garden");
  const save = page.getByRole("button", {
    name: en("unlock.otherVault.save"),
    exact: true,
  });
  await expect(save).toBeDisabled();
  await page
    .getByLabel(en("unlock.otherVault.nameLabel", { number: 2, count: 2 }), {
      exact: true,
    })
    .fill("FAKE Orchard");
  await expectNoAxeViolations(page, "the names asked for the vaults found");
  await save.click();
  await expect(
    page.getByText(en("unlock.otherVault.named"), { exact: true }),
  ).toBeVisible();
  const named = await fakeCalls(page, "vault_name_found_vaults");
  expect(named).toEqual([
    {
      request: {
        vaults: [
          { id: "slot-a", name: "FAKE Garden" },
          { id: "slot-b", name: "FAKE Orchard" },
        ],
      },
    },
  ]);
});

test("another vault is set up from Security, asked of the open vault, and the page never locks first", async ({
  page,
}) => {
  test.skip(
    test.info().project.name === "phone",
    "the sidebar's Security entry is laid out differently on a phone",
  );
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  // From an open vault it is in Security (the lock screen's own button is covered by the
  // component tests, as the confirmation is the device's and the fake agrees to it).
  await page
    .getByRole("button", { name: en("security.title") })
    .first()
    .click();
  await page
    .getByRole("button", { name: en("security.newVault.button"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("newVault.title"), exact: true }),
  ).toBeVisible();
  await expectNoAxeViolations(page, "the setup screen for another vault");
  await page
    .getByLabel(en("newVault.name.label"), { exact: true })
    .fill("FAKE Garden");
  await page
    .getByLabel(en("create.profile.label"), { exact: true })
    .fill("FAKE Robin");
  for (const box of await page.getByLabel(/passphrase/i).all())
    await box.fill("FAKE garden passphrase 934");
  await page
    .getByRole("button", { name: en("newVault.submit"), exact: true })
    .click();
  await expect(
    page.getByText(en("notice.newVaultReady"), { exact: true }),
  ).toBeVisible();
  const commands = await fakeCommands(page);
  expect(commands).toContain("vault_add_vault");
  // The native add locks the open vault; the page does not lock first.
  expect(commands).not.toContain("vault_lock");
  const added = await fakeCalls(page, "vault_add_vault");
  expect(added).toEqual([
    {
      locale: "en",
      request: {
        name: "FAKE Garden",
        passphrase: "FAKE garden passphrase 934",
        initialProfileName: "FAKE Robin",
      },
    },
  ]);
});
