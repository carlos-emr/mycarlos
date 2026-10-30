import { expect, test } from "@playwright/test";
import { FAKE_IDS, fakeVaultWith, myRecords } from "./support/vaultFake";

test("replaying unchanged moves and hides does not invent history or change the hide time", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "phone",
    "native history contract is independent of viewport",
  );
  await page.clock.install();
  // Optional people/received/identities are deliberately omitted, as older callers do.
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const result = await page.evaluate(
    async ({ record, folder }) => {
      const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (c: string, a?: unknown) => Promise<unknown>;
      };
      await ipc.invoke("vault_assign_folders", {
        request: { recordId: record, folderIds: [folder] },
      });
      await ipc.invoke("vault_assign_folders_batch", {
        request: { recordIds: [record], folderIds: [folder] },
      });
      await ipc.invoke("vault_rename_record", {
        request: { recordId: record, name: "FAKE Bloodwork.pdf" },
      });
      await ipc.invoke("vault_rename_record", {
        request: { recordId: record, name: "FAKE Results renamed.pdf" },
      });
      await ipc.invoke("vault_rename_record", {
        request: { recordId: record, name: "FAKE Results renamed.pdf" },
      });
      await ipc.invoke("vault_hide_record", { request: { recordId: record } });
      const first = await ipc.invoke("vault_snapshot");
      const history = await ipc.invoke("vault_history");
      return { first, history };
    },
    { record: FAKE_IDS.record, folder: FAKE_IDS.folder },
  );
  expect(result.history).toMatchObject({
    entries: [{ event: "created" }, { event: "renamed" }, { event: "hidden" }],
  });
  await page.clock.fastForward(2000);
  const replay = await page.evaluate(
    async ({ record }) => {
      const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (c: string, a?: unknown) => Promise<unknown>;
      };
      await ipc.invoke("vault_hide_record", { request: { recordId: record } });
      return {
        snapshot: await ipc.invoke("vault_snapshot"),
        history: await ipc.invoke("vault_history"),
      };
    },
    { record: FAKE_IDS.record },
  );
  expect(replay.snapshot).toEqual(result.first);
  expect(replay.history).toEqual(result.history);
});
