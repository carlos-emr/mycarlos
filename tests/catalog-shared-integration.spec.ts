import { expect, test } from "@playwright/test";
import {
  AI_COMMANDS,
  aiCalls,
  aiHeld,
  fakeAiWith,
  holdAi,
} from "./support/aiFake";
import { catalogRows, FAKE_CATALOG } from "./support/modelCatalogFake";
import {
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";
import { expectOnlyFakedCommands } from "./support/a11y";

// Source-only integration coverage: no model download or native backend.
test("catalogue progress survives visiting Shared while Check stays in its reserved view", async ({
  page,
  baseURL,
}, info) => {
  test.skip(info.project.name === "phone", "the AI helper runs on computers");
  expect(baseURL).toBeTruthy();
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["data:", "blob:"].includes(url.protocol)) {
      await route.continue();
    } else {
      external.push(url.origin);
      await route.abort();
    }
  });
  await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
  await fakeAiWith(page, { models: catalogRows([0]) });
  await page.goto("/");
  await expect(myRecords(page)).toBeVisible();
  const check = page.getByRole("button", {
    name: "Check for new documents",
    exact: true,
  });
  await expect(check).toHaveCount(0);
  const navigate = async (name: string | RegExp) => {
    await sidebar(page).getByRole("button", { name, exact: true }).click();
  };
  await navigate("AI helper");
  await expect(
    page.getByRole("heading", { name: "AI helper", level: 1, exact: true }),
  ).toBeVisible();
  await expect(check).toHaveCount(0);
  const row = page.getByRole("region", {
    name: FAKE_CATALOG[1].name,
    exact: true,
  });
  await holdAi(page, AI_COMMANDS.download);
  await row
    .getByRole("button", {
      name: `Download ${FAKE_CATALOG[1].name}`,
      exact: true,
    })
    .click();
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.download]);
  const busy = row.getByRole("button", {
    name: `Downloading ${FAKE_CATALOG[1].name}`,
    exact: true,
  });
  await expect(busy).toBeDisabled();
  await expect(row.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await navigate(/^Shared with me/);
  await expect(check).toBeEnabled();
  await page.getByRole("searchbox").fill("FAKE");
  await expect(check).toBeVisible();
  // Neither navigating nor searching starts a clinic operation.
  expect(await fakeCalls(page, "vault_check_documents")).toEqual([]);
  await navigate("AI helper");
  await expect(check).toHaveCount(0);
  await expect(busy).toBeDisabled();
  await expect(row.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(
    page.getByRole("radio", { name: FAKE_CATALOG[0].name, exact: true }),
  ).toBeChecked();
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => aiHeld(page)).toEqual([]);
  await expect(row.getByRole("progressbar")).toHaveCount(0);
  expect(await aiCalls(page, AI_COMMANDS.download)).toEqual([
    { request: { index: 1 } },
  ]);
  await navigate("Preferences");
  await expect(
    page.getByRole("heading", { name: "Preferences", level: 1, exact: true }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(check).toHaveCount(0);
  await navigate("Security");
  await expect(
    page.getByRole("heading", { name: "Clinic documents", exact: true }),
  ).toBeVisible();
  await expect(check).toHaveCount(0);
  await navigate(/^Shared with me/);
  await expect(check).toBeEnabled();
  await check.click();
  await expect
    .poll(() => fakeCalls(page, "vault_check_documents"))
    .toHaveLength(1);
  await expect(check).toBeEnabled();
  await navigate(/^FAKE Letters/);
  await expect(check).toHaveCount(0);
  expect(external).toEqual([]);
  await expectOnlyFakedCommands(page);
});
