import { expect, test, type Page } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import {
  FAKE_IDS,
  FAKE_PASSPHRASE,
  FAKE_DOCUMENT_PASSWORD,
  fakeVaultWith,
  myRecords,
  scriptFake,
  fakeViewDraws,
} from "./support/vaultFake";

// Exercise the native-boundary refusals on which the daily-flow specs rely.
// These do not replace native tests; they keep the test double from silently
// accepting impossible payloads or leaving cancelled work alive.
test.beforeEach(({}, info) =>
  test.skip(
    info.project.name === "phone",
    "native fake contract is independent of viewport",
  ),
);
async function invoke(page: Page, command: string, args: unknown = {}) {
  return page.evaluate(
    async ({ command, args }) => {
      const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (command: string, args: unknown) => Promise<unknown>;
      };
      try {
        return { value: await ipc.invoke(command, args) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : error };
      }
    },
    { command, args },
  );
}

test("snapshot captures increase within the fake runtime across renderer reload", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const first = (await invoke(page, "vault_snapshot")).value as {
    capture: { epoch: string; sequence: number };
  };
  const second = (await invoke(page, "vault_snapshot")).value as typeof first;
  expect(first.capture.epoch).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.capture.epoch).toBe(first.capture.epoch);
  expect(second.capture.sequence).toBeGreaterThan(first.capture.sequence);
  expect(Number.isSafeInteger(second.capture.sequence)).toBe(true);
  await scriptFake(page, "vault_snapshot", { resolve: first });
  expect((await invoke(page, "vault_snapshot")).value).toEqual(first);
  await scriptFake(page, "vault_snapshot", {
    resolve: { profiles: [], folders: [], records: [], recovery: null },
  });
  expect((await invoke(page, "vault_snapshot")).error).toContain(
    "requires capture-time metadata",
  );
  await page.reload();
  // Reload hides the old window and locks its native session; the fake runtime survives.
  await expect(
    page.getByRole("heading", { name: "Unlock your vault", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(myRecords(page)).toBeVisible();
  const afterReload = (await invoke(page, "vault_snapshot"))
    .value as typeof first;
  expect(afterReload.capture.epoch).toBe(first.capture.epoch);
  expect(afterReload.capture.sequence).toBeGreaterThan(second.capture.sequence);
  await expectOnlyFakedCommands(page);
});

test("fixture IDs are UUIDs and malformed native IDs are refused", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const snapshot = (await invoke(page, "vault_snapshot")).value as {
    profiles: { id: string }[];
    folders: { id: string; profileId: string }[];
    records: {
      id: string;
      profileId: string;
      folderIds: string[];
      sourceKind: string;
    }[];
    portalLinks: { id: string }[];
  };
  const ids = [
    ...snapshot.profiles.map((x) => x.id),
    ...snapshot.folders.flatMap((x) => [x.id, x.profileId]),
    ...snapshot.records.flatMap((x) => [x.id, x.profileId, ...x.folderIds]),
    ...snapshot.portalLinks.map((x) => x.id),
  ];
  for (const id of ids)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  expect(snapshot.records.every((r) => r.sourceKind === "manual")).toBe(true);
  for (const [command, args] of [
    ["vault_request_device_approval", { linkId: "FAKE-link-1" }],
    ["vault_hide_record", { request: { recordId: "letter" } }],
    [
      "vault_assign_folders_batch",
      { request: { recordIds: [FAKE_IDS.letter], folderIds: ["folder"] } },
    ],
  ] as const)
    expect((await invoke(page, command, args)).error).toContain("invalid UUID");
  await expectOnlyFakedCommands(page);
});

test("unlocking the same original twice refuses without creating another copy", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", lockedPdf: true });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const args = {
    request: { recordId: FAKE_IDS.locked, password: FAKE_DOCUMENT_PASSWORD },
  };
  expect((await invoke(page, "vault_unlock_pdf", args)).value).toMatchObject({
    recordId: FAKE_IDS.unlocked,
  });
  expect((await invoke(page, "vault_unlock_pdf", args)).error).toMatchObject({
    code: "pdf_already_unlocked",
    messageKey: "native.error.25",
  });
  const records = (
    (await invoke(page, "vault_snapshot")).value as {
      records: { id: string }[];
    }
  ).records;
  expect(records).toHaveLength(4);
  expect(new Set(records.map((r) => r.id)).size).toBe(4);
  await expectOnlyFakedCommands(page);
});

test("overlapping clinic checks refuse and release the guard afterwards", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const outcomes = await page.evaluate(async () => {
    const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
      invoke: (command: string) => Promise<unknown>;
    };
    return Promise.allSettled([
      ipc.invoke("vault_check_documents"),
      ipc.invoke("vault_check_documents"),
    ]);
  });
  expect(outcomes[0].status).toBe("fulfilled");
  expect(outcomes[1]).toMatchObject({
    status: "rejected",
    reason: { code: "invalid", messageKey: "native.error.19" },
  });
  expect((await invoke(page, "vault_check_documents")).value).toMatchObject({
    added: 0,
  });
  await expectOnlyFakedCommands(page);
});

test("cancelling a pending page draw settles it with the native cancellation refusal", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked" });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  await scriptFake(page, "vault_view_page", { pending: true });
  await page.evaluate(
    ({ recordId }) => {
      const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (command: string, args: unknown) => Promise<unknown>;
      };
      void ipc
        .invoke("vault_view_page", {
          request: { recordId, page: 0, width: 600, password: null },
        })
        .then(
          (value) => Reflect.set(window, "__drawResult", { value }),
          (error) => Reflect.set(window, "__drawResult", { error }),
        );
    },
    { recordId: FAKE_IDS.letter },
  );
  await expect
    .poll(() => fakeViewDraws(page))
    .toEqual({ pending: 1, cancelled: 0 });
  await invoke(page, "vault_view_cancel");
  await expect
    .poll(() => fakeViewDraws(page))
    .toEqual({ pending: 0, cancelled: 1 });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "__drawResult")))
    .toMatchObject({
      error: { code: "cancelled", messageKey: "native.error.36" },
    });
  await expectOnlyFakedCommands(page);
});
