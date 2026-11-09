import { expect, test } from "@playwright/test";
import { fakeVaultWith, myRecords, fakeCalls } from "./support/vaultFake";
import { translate } from "./support/fluent";
import { expectOnlyFakedCommands } from "./support/a11y";

test("previous full-name suggestion is removable with keyboard at narrow large text and saves only the explicit draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  await fakeVaultWith(page, {
    start: "unlocked",
    platform: "windows",
    people: [
      { displayName: "FAKE Alias Person", fullName: "FAKE Original Name" },
    ],
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await page.addStyleTag({ content: ":root{font-size:200% !important}" });
  await page
    .getByRole("button", { name: "Security", exact: true })
    .locator("visible=true")
    .click();
  const opener = page.getByRole("button", {
    name: translate("en", "personDetails.editFor", {
      name: "FAKE Alias Person",
    }),
    exact: true,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", {
    name: "Edit details",
    exact: true,
  });
  const current = dialog.getByLabel(translate("en", "personDetails.fullName"), {
    exact: true,
  });
  await current.fill("FAKE New Name");
  const entry = dialog.getByLabel(
    translate("en", "personDetails.previousEntry", { number: 1 }),
    { exact: true },
  );
  await expect(entry).toHaveValue("FAKE Original Name");
  const remove = dialog.getByRole("button", {
    name: translate("en", "personDetails.previousRemove", { number: 1 }),
    exact: true,
  });
  await remove.focus();
  await page.keyboard.press("Enter");
  const add = dialog.getByRole("button", {
    name: translate("en", "personDetails.previousAdd"),
    exact: true,
  });
  await expect(add).toBeFocused();
  await current.fill("FAKE Final Name");
  await expect(entry).toHaveCount(0);
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(entry).toBeFocused();
  await entry.fill("FAKE Explicit Previous Name");
  await dialog
    .getByRole("button", {
      name: translate("en", "personDetails.save"),
      exact: true,
    })
    .click();
  await expect(dialog).toHaveCount(0);
  const calls = await fakeCalls(page, "vault_update_profile_details");
  expect(calls.at(-1)).toMatchObject({
    request: {
      details: {
        fullName: "FAKE Final Name",
        previousFullNames: ["FAKE Explicit Previous Name"],
      },
    },
  });
  await opener.click();
  await expect(entry).toHaveValue("FAKE Explicit Previous Name");
  await expect(
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).resolves.toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(opener).toBeFocused();
  await expectOnlyFakedCommands(page);
});
