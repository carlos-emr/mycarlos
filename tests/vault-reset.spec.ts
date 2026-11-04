import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeSnapshot,
  fakeVaultWith,
  myRecords,
  refusal,
  scriptFake,
} from "./support/vaultFake";

// Setting the vault aside (#71), from the unlock screen only, when the
// passphrase and the recovery key are both gone: the typed words enable the
// button, the native side asks once more and may keep the vault or refuse,
// and an erased vault starts myCarlos again from the comfort settings with a
// new, empty vault. The native side is faked (support/vaultFake.ts).

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

const PHRASE = en("native.reset.phrase");
const NEW_PATIENT = "FAKE New patient";
const NEW_PASSPHRASE = "FAKE correct horse battery staple";

/** The unlock screen's Set vault aside, typed up to its enabled button. */
async function typeTheWords(page: Parameters<typeof fakeVaultWith>[0]) {
  await expect(
    page.getByRole("heading", { name: en("unlock.title"), exact: true }),
  ).toBeVisible();
  await page.getByText(en("unlock.forgot.summary"), { exact: true }).click();
  const setAside = page.getByRole("button", {
    name: en("reset.submit"),
    exact: true,
  });
  await expect(setAside).toBeDisabled();
  const words = page.getByLabel(en("reset.type", { phrase: PHRASE }), {
    exact: true,
  });
  await words.fill(PHRASE);
  await expect(setAside).toBeEnabled();
  return { setAside, words };
}

test("Set vault aside: the native side keeping the vault, or refusing, changes nothing, and the vault still unlocks", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked", recoveryKey: null });
  await page.goto("/");
  const { setAside, words } = await typeTheWords(page);

  // The patient chose "Keep this vault" in the native dialog.
  await scriptFake(page, "vault_reset", { resolve: false });
  await setAside.click();
  await expect(
    page.getByText(en("notice.eraseCancelled"), { exact: true }),
  ).toBeVisible();
  const asked = await fakeCalls(page, "vault_reset");
  expect(asked).toHaveLength(1);
  expect(asked[0].request).toEqual({ confirmation: PHRASE });

  // The native side did not accept the words: the box to check is named,
  // and nothing is erased.
  await scriptFake(page, "vault_reset", {
    reject: refusal("invalid", "native.error.19"),
  });
  await words.fill(PHRASE);
  await expect(setAside).toBeEnabled();
  await setAside.click();
  await expect(
    page.getByText(en("error.checkBoxes", { boxes: en("box.typedWords") }), {
      exact: true,
    }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_reset")).toHaveLength(2);
  expect((await fakeSnapshot(page)).records.map((r) => r.displayName)).toEqual([
    "FAKE Bloodwork.pdf",
    "FAKE Letter.pdf",
  ]);

  // Still the same vault: the passphrase opens it.
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  await expect(myRecords(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("Set vault aside erases the vault: myCarlos starts again from the comfort settings, also after a reload, and a new vault opens with nothing in it", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked", recoveryKey: null });
  await page.goto("/");
  const { setAside } = await typeTheWords(page);
  await setAside.click();

  // Erased natively: nothing is left, and the app starts as a fresh install
  // does, with the comfort settings.
  const comfort = page.getByRole("heading", {
    name: en("comfort.title"),
    exact: true,
  });
  await expect(comfort).toBeVisible();
  expect(await fakeCalls(page, "vault_reset")).toHaveLength(1);
  expect((await fakeSnapshot(page)).records).toEqual([]);

  // The native side says there is no vault now: a reload lands in the same
  // place, not on the unlock screen.
  await page.reload();
  await expect(comfort).toBeVisible();
  await expect(
    page.getByRole("heading", { name: en("unlock.title"), exact: true }),
  ).toHaveCount(0);

  // A new vault, for a new name, with a new passphrase.
  await page
    .getByRole("button", { name: en("comfort.usual"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("create.title"), exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: en("create.profile.label"), exact: true })
    .fill(NEW_PATIENT);
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(NEW_PASSPHRASE);
  await page
    .getByLabel(en("passphrase.confirm.label"), { exact: true })
    .fill(NEW_PASSPHRASE);
  await page
    .getByRole("button", { name: en("create.submit"), exact: true })
    .click();
  // A new vault opens on setting up its recovery key.
  await expect(page.getByRole("dialog")).toBeVisible();
  const created = await fakeCalls(page, "vault_create");
  expect(created).toHaveLength(1);
  expect(created[0].request).toMatchObject({
    initialProfileName: NEW_PATIENT,
    passphrase: NEW_PASSPHRASE,
  });
  // Nothing of the old vault came along: its documents, its people, its key.
  const fresh = await fakeSnapshot(page);
  expect(fresh.records).toEqual([]);
  expect(fresh.recoveryKeySetAtMs).toBeNull();
  await expectOnlyFakedCommands(page);
});
