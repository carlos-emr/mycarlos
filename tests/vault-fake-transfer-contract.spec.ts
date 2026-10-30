import { expect, test, type Page } from "@playwright/test";
import {
  FAKE_IDS,
  FAKE_PASSPHRASE,
  fakePickFiles,
  fakeVaultWith,
  myRecords,
} from "./support/vaultFake";

test.beforeEach(({}, info) =>
  test.skip(
    info.project.name === "phone",
    "native transfer contract is independent of viewport",
  ),
);
async function invoke(page: Page, command: string, args: unknown = {}) {
  return page.evaluate(
    async ({ command, args }) => {
      const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (c: string, a: unknown) => Promise<unknown>;
      };
      try {
        return { value: await ipc.invoke(command, args) };
      } catch (error) {
        return { error };
      }
    },
    { command, args },
  );
}

test("import picks are bound to their target, consumed once, and record IDs survive reload", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const target = { profileId: FAKE_IDS.profile, folderIds: [] as string[] };
  await fakePickFiles(page, ["FAKE First.pdf"]);
  const first = (await invoke(page, "vault_import_pick", { request: target }))
    .value;
  expect(
    (
      await invoke(page, "vault_import_picked", {
        request: { pickId: first, ...target, folderIds: [FAKE_IDS.folder] },
      })
    ).error,
  ).toMatchObject({ code: "invalid" });
  expect(
    (
      await invoke(page, "vault_import_picked", {
        request: { pickId: first, ...target },
      })
    ).error,
  ).toMatchObject({ code: "not_found" });
  const second = (await invoke(page, "vault_import_pick", { request: target }))
    .value;
  expect(second).not.toBe(first);
  const imported = (
    await invoke(page, "vault_import_picked", {
      request: { pickId: second, ...target },
    })
  ).value as { imported: string[] };
  expect(imported.imported).toHaveLength(1);
  expect(
    (
      await invoke(page, "vault_import_picked", {
        request: { pickId: second, ...target },
      })
    ).error,
  ).toMatchObject({ code: "not_found" });
  await page.reload();
  await expect(myRecords(page)).toBeVisible();
  await fakePickFiles(page, ["FAKE Second.pdf"]);
  const third = (await invoke(page, "vault_import_pick", { request: target }))
    .value;
  const after = (
    await invoke(page, "vault_import_picked", {
      request: { pickId: third, ...target },
    })
  ).value as { imported: string[] };
  expect(after.imported).toHaveLength(1);
  expect(after.imported[0]).not.toBe(imported.imported[0]);
  const snapshot = (await invoke(page, "vault_snapshot")).value as {
    records: { id: string }[];
  };
  expect(new Set(snapshot.records.map((r) => r.id)).size).toBe(
    snapshot.records.length,
  );
});

test("backup tickets are one-use and recovery refuses both picker and write", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const first = (await invoke(page, "vault_backup_pick")).value;
  expect(
    (await invoke(page, "vault_backup_picked", { request: { pickId: first } }))
      .value,
  ).toMatchObject({ bytes: expect.any(Number) });
  expect(
    (await invoke(page, "vault_backup_picked", { request: { pickId: first } }))
      .error,
  ).toMatchObject({ code: "not_found" });
  const second = (await invoke(page, "vault_backup_pick")).value;
  expect(second).not.toBe(first);
  // Model an encrypted file disappearing after the destination was picked.
  await page.evaluate(() => {
    const state = JSON.parse(
      sessionStorage.getItem("mycarlos-e2e-fake-vault")!,
    );
    state.snapshot.recovery = "lostObjects";
    sessionStorage.setItem("mycarlos-e2e-fake-vault", JSON.stringify(state));
  });
  await page.reload();
  await expect(myRecords(page)).toBeVisible();
  expect((await invoke(page, "vault_backup_pick")).error).toMatchObject({
    code: "recovery_mode",
    messageKey: "native.error.40",
  });
  expect(
    (await invoke(page, "vault_backup_picked", { request: { pickId: second } }))
      .error,
  ).toMatchObject({ code: "recovery_mode", messageKey: "native.error.40" });
});

test("restore refuses an active session and consumes a successful restore pick", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    backup: { replaces: "sameVault", documents: ["FAKE Restored.pdf"] },
  });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const first = (await invoke(page, "vault_restore_pick")).value;
  const request = { pickId: first, passphrase: FAKE_PASSPHRASE, replace: true };
  for (const command of ["vault_restore_inspect", "vault_restore"])
    expect((await invoke(page, command, { request })).error).toMatchObject({
      code: "invalid",
      messageKey: "native.error.19",
    });
  await invoke(page, "vault_lock");
  expect(
    (await invoke(page, "vault_restore_inspect", { request })).error,
  ).toMatchObject({ code: "not_found" });
  const second = (await invoke(page, "vault_restore_pick")).value;
  expect(second).not.toBe(first);
  request.pickId = second;
  expect(
    (await invoke(page, "vault_restore_inspect", { request })).value,
  ).toMatchObject({ documentCount: 1 });
  expect((await invoke(page, "vault_restore", { request })).value).toBe(true);
  expect(
    (await invoke(page, "vault_restore", { request })).error,
  ).toMatchObject({ code: "not_found" });
});
