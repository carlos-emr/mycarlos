import { expect, test, type Page } from "@playwright/test";
import {
  expectAnnounced,
  expectOnlyFakedCommands,
  recordAnnouncements,
} from "./support/a11y";
import { messagePattern, translate } from "./support/fluent";
import {
  FAKE_PASSPHRASE,
  FAKE_VAULT_KEY,
  escapeRegExp,
  fakeCalls,
  fakeVaultWith,
  mistypedKey,
  refusal,
  scriptFake,
} from "./support/vaultFake";

// Unlocking when it goes wrong, every day's first screen: a wrong
// passphrase, the wait after several wrong tries (#43), then the right one;
// and the recovery key form under "Forgot your passphrase?" with a wrong key,
// then the right one. Each message is checked where it is said (by the box it
// answers), and what the native side was sent is checked as it received it.
// The native side is faked (support/vaultFake.ts); the waiting itself is
// counted natively (src-tauri/src/throttle.rs) and tested in Rust.

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

const WRONG_PASSPHRASE = "FAKE wrong passphrase";
const NEW_PASSPHRASE = "FAKE new passphrase after recovery";

const escaped = (text: string) => new RegExp(escapeRegExp(text));

function unlockScreen(page: Page) {
  return {
    heading: page.getByRole("heading", {
      name: en("unlock.title"),
      exact: true,
    }),
    passphrase: page.getByLabel(en("passphrase.label"), { exact: true }),
    unlock: page.getByRole("button", {
      name: en("unlock.submit"),
      exact: true,
    }),
  };
}

test("a wrong passphrase, then the wait after wrong tries, are said by the Passphrase box, and the right passphrase opens the vault", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "locked" });
  await recordAnnouncements(page);
  await page.goto("/");
  const { heading, passphrase, unlock } = unlockScreen(page);
  await expect(heading).toBeVisible();

  // Wrong: said by the box, which is emptied for the next try.
  await passphrase.fill(WRONG_PASSPHRASE);
  await unlock.click();
  const wrong = en("native.error.16");
  await expect(page.getByText(wrong, { exact: true })).toBeVisible();
  await expect(passphrase).toHaveAccessibleDescription(
    messagePattern("en", "native.error.16"),
  );
  await expect(passphrase).toHaveValue("");
  await expect(heading).toBeVisible();
  expect(await fakeCalls(page, "vault_unlock")).toEqual([
    { request: { passphrase: WRONG_PASSPHRASE } },
  ]);

  // Too many wrong tries: the native side refuses before checking, and says
  // how long to wait. That replaces the earlier message.
  await scriptFake(page, "vault_unlock", {
    reject: refusal("too_many_attempts", "native.error.05", {
      retryAfterMs: 30_000,
    }),
  });
  await passphrase.fill(FAKE_PASSPHRASE);
  await unlock.click();
  const wait = `${en("native.error.05")} ${en("error.retryIn", { count: 30 })}`;
  await expect(page.getByText(wait, { exact: true })).toBeVisible();
  await expect(passphrase).toHaveAccessibleDescription(escaped(wait));
  await expect(page.getByText(wrong, { exact: true })).toHaveCount(0);
  await expect(passphrase).toHaveValue("");
  await expect(heading).toBeVisible();

  // The right passphrase, once the wait is over, opens the vault.
  await passphrase.fill(FAKE_PASSPHRASE);
  await unlock.click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.myRecords"), exact: true }),
  ).toBeVisible();
  await expectAnnounced(page, en("notice.unlocked"));
  expect(await fakeCalls(page, "vault_unlock")).toEqual([
    { request: { passphrase: WRONG_PASSPHRASE } },
    { request: { passphrase: FAKE_PASSPHRASE } },
    { request: { passphrase: FAKE_PASSPHRASE } },
  ]);

  // Locked again, the screen says so, and nothing of the earlier refusals.
  await page
    .getByRole("button", {
      name: en("interface.VaultLibrary.unlockedLockNow"),
      exact: true,
    })
    .click();
  await expect(heading).toBeVisible();
  await expect(passphrase).toHaveAccessibleDescription(
    messagePattern("en", "notice.locked"),
  );
  await expect(page.getByText(wrong, { exact: true })).toHaveCount(0);
  await expect(page.getByText(wait, { exact: true })).toHaveCount(0);
  expect(await fakeCalls(page, "vault_lock")).toHaveLength(1);
  await expectOnlyFakedCommands(page);
});

test("Forgot your passphrase: a wrong recovery key is said in that form and kept to correct, and the right key opens the vault with a new passphrase", async ({
  page,
}) => {
  const key = FAKE_VAULT_KEY;
  await fakeVaultWith(page, { start: "locked", recoveryKey: key });
  await page.goto("/");
  const { heading, passphrase } = unlockScreen(page);
  await expect(heading).toBeVisible();

  const summary = en("unlock.forgot.summary");
  await page.getByText(summary, { exact: true }).click();
  const forgot = page
    .getByRole("group")
    .filter({ has: page.getByText(summary, { exact: true }) });
  const keyBox = forgot.getByLabel(en("recover.key.label"), { exact: true });
  const newPassphrase = forgot.getByLabel(en("passphrase.new.label"), {
    exact: true,
  });
  const confirmNew = forgot.getByLabel(en("passphrase.confirmNew.label"), {
    exact: true,
  });
  const submit = forgot.getByRole("button", {
    name: en("recover.submit"),
    exact: true,
  });

  // A typo in the key: said in this form, not by the Unlock box above it.
  // The key stays, to be corrected; the new passphrase does not.
  const typo = mistypedKey(key);
  await keyBox.fill(typo);
  await newPassphrase.fill(NEW_PASSPHRASE);
  await confirmNew.fill(NEW_PASSPHRASE);
  await submit.click();
  const refused = en("native.error.44");
  await expect(forgot.getByRole("status")).toHaveText(refused);
  await expect(passphrase).not.toHaveAccessibleDescription(escaped(refused));
  await expect(keyBox).toHaveValue(typo);
  await expect(newPassphrase).toHaveValue("");
  await expect(confirmNew).toHaveValue("");
  await expect(heading).toBeVisible();
  expect(await fakeCalls(page, "vault_recover")).toEqual([
    { request: { recoveryKey: typo, newPassphrase: NEW_PASSPHRASE } },
  ]);

  // The right key, typed in groups with spaces, opens the vault and replaces
  // the passphrase.
  const typed = key.split("-").join(" ");
  await keyBox.fill(typed);
  await newPassphrase.fill(NEW_PASSPHRASE);
  await confirmNew.fill(NEW_PASSPHRASE);
  await submit.click();
  await expect(
    page.getByRole("heading", { name: en("sidebar.myRecords"), exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(en("notice.recovered"), { exact: true }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_recover")).toEqual([
    { request: { recoveryKey: typo, newPassphrase: NEW_PASSPHRASE } },
    { request: { recoveryKey: typed, newPassphrase: NEW_PASSPHRASE } },
  ]);
  // Opened with its key, the vault is not offered another one.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectOnlyFakedCommands(page);
});
