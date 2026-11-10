import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  fakeCalls,
  fakeVaultWith,
  myRecords,
  sidebar,
} from "./support/vaultFake";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
const stage = process.env.CHECK_STAGE ?? "after";
for (const view of ["ordinary", "shared"] as const) {
  test(`Check scope: ${view} folder`, async ({ page, baseURL, isMobile }) => {
    expect(baseURL).toBeTruthy();
    const allowedOrigin = new URL(baseURL!).origin;
    const external: string[] = [];
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin === allowedOrigin ||
        ["data:", "blob:"].includes(url.protocol)
      )
        await route.continue();
      else {
        external.push(url.origin);
        await route.abort();
      }
    });
    await fakeVaultWith(page, { start: "unlocked", portal: "linked" });
    await page.goto("/");
    await expect(myRecords(page)).toBeVisible();
    const check = page.getByRole("button", {
      name: "Check for new documents",
      exact: true,
    });
    if (stage === "after") await expect(check).toHaveCount(0);
    const openLetters = async () => {
      await sidebar(page)
        .getByRole("button", { name: /^My records/ })
        .click();
      await page
        .getByRole("main")
        .getByRole("button", {
          name: translate("en", "library.folder.open", { name: "FAKE Letters" }),
          exact: true,
        })
        .click();
    };
    const sectionNavigation = isMobile
      ? page.getByRole("navigation", { name: "Section", exact: true })
      : sidebar(page);
    if (view === "shared")
      await sidebar(page)
        .getByRole("button", { name: /^Shared with me/ })
        .click();
    else await openLetters();
    const expected = stage === "before" || view === "shared";
    if (expected) await expect(check).toBeEnabled();
    else await expect(check).toHaveCount(0);
    const search = page.getByRole("searchbox");
    await search.scrollIntoViewIfNeeded();
    if (process.env.CHECK_SHOTS) {
      const dir = `${process.env.CHECK_SHOTS}/${stage}`;
      await mkdir(dir, { recursive: true });
      await page.screenshot({
        path: `${dir}/${view}.png`,
        animations: "disabled",
      });
      await writeFile(
        `${dir}/${view}.json`,
        JSON.stringify(
          {
            head: execFileSync(
              "git",
              [
                "-C",
                process.env.CHECK_SOURCE ?? process.cwd(),
                "rev-parse",
                "HEAD",
              ],
              { encoding: "utf8" },
            ).trim(),
            stage,
            view,
            synthetic: true,
            checkCount: await check.count(),
            rootFont: await page
              .locator("html")
              .evaluate((e) => getComputedStyle(e).fontSize),
            viewport: page.viewportSize(),
            external,
          },
          null,
          2,
        ),
      );
    }
    if (stage === "after") {
      await sidebar(page)
        .getByRole("button", { name: /^Shared with me/ })
        .click();
      await expect(check).toBeEnabled();
      await search.fill("FAKE");
      await expect(check).toBeVisible();
      await openLetters();
      await expect(check).toHaveCount(0);
      await sectionNavigation
        .getByRole("button", { name: "Security", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Clinic documents", exact: true }),
      ).toBeVisible();
      await expect(check).toHaveCount(0);
      await sectionNavigation
        .getByRole("button", { name: "Preferences", exact: true })
        .click();
      await expect(check).toHaveCount(0);
      expect(await fakeCalls(page, "vault_check_documents")).toEqual([]);
    }
    expect(external).toEqual([]);
    await expectOnlyFakedCommands(page);
  });
}
