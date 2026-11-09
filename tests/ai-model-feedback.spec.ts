import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  AI_COMMANDS,
  aiCalls,
  aiHeld,
  fakeAiWith,
  holdAi,
} from "./support/aiFake";
import { catalogRows, FAKE_CATALOG } from "./support/modelCatalogFake";
import { fakeVaultWith, myRecords } from "./support/vaultFake";
import { expectOnlyFakedCommands } from "./support/a11y";

const stage = process.env.FEEDBACK_STAGE ?? "after";
const source = process.env.FEEDBACK_SOURCE ?? process.cwd();
for (const mode of [
  "desktop",
  "narrow-200-text",
  "dark",
  "forced-colors",
] as const) {
  for (const phase of ["downloading", "installing"] as const) {
    test(`${mode}: ${phase} keeps the row busy and counts below the bar`, async ({
      page,
      baseURL,
    }) => {
      const allowedOrigin = new URL(baseURL ?? "http://127.0.0.1:4173").origin;
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
      await page.emulateMedia({
        colorScheme: mode === "dark" ? "dark" : "light",
        forcedColors: mode === "forced-colors" ? "active" : "none",
        reducedMotion: "reduce",
      });
      await fakeVaultWith(page, { start: "unlocked" });
      await fakeAiWith(page, { models: catalogRows([0]) });
      await page.goto("/");
      await expect(myRecords(page)).toBeVisible();
      await holdAi(page, AI_COMMANDS.download);
      await page.evaluate(
        ({ command, total, phase }) => {
          const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
            invoke: (c: string, args: unknown) => Promise<unknown>;
          };
          Reflect.set(
            window,
            "__feedbackPending",
            ipc.invoke(command, { request: { index: 1 } }),
          );
          if (phase === "installing") {
            const fake = Reflect.get(window, "__fakeAi") as {
              answer: (c: string, value: unknown) => void;
            };
            fake.answer("ai_model_add_active", {
              kind: "download",
              index: 1,
              done: total,
              total,
            });
          }
        },
        {
          command: AI_COMMANDS.download,
          total: FAKE_CATALOG[1].sizeBytes,
          phase,
        },
      );
      await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.download]);
      await page
        .getByRole("button", { name: "AI helper", exact: true })
        .locator("visible=true")
        .first()
        .click();
      const row = page.getByRole("region", {
        name: FAKE_CATALOG[1].name,
        exact: true,
      });
      const percent = phase === "installing" ? "100" : "50";
      await expect(row.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        percent,
      );
      if (mode === "narrow-200-text") {
        await page.addStyleTag({
          content: ":root { font-size:200% !important; }",
        });
        await page.setViewportSize({ width: 320, height: 1000 });
      }
      const caption =
        stage === "before"
          ? "Download"
          : phase === "installing"
            ? "Installing"
            : "Downloading";
      const button = row.getByRole("button", {
        name: `${caption} ${FAKE_CATALOG[1].name}`,
        exact: true,
      });
      await expect(button).toBeDisabled(); // aria-disabled baseline; native disabled after
      await expect(
        page.getByRole("radio", { name: FAKE_CATALOG[0].name, exact: true }),
      ).toBeChecked();
      const layout = await row.evaluate((element) => {
        const bar = element.querySelector('[role="progressbar"]')!;
        const counts = element.querySelector(".native-ai-model-percent")!;
        const download = element.querySelector(
          ".native-ai-model-actions button",
        ) as HTMLButtonElement;
        return {
          bar: bar.getBoundingClientRect().toJSON(),
          counts: counts.getBoundingClientRect().toJSON(),
          visibleCounts: counts.textContent,
          nativeDisabled: download.disabled,
          rootFont: getComputedStyle(document.documentElement).fontSize,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
          theme: document.documentElement.dataset.theme,
          forced: matchMedia("(forced-colors: active)").matches,
        };
      });
      if (stage !== "before") {
        expect(layout.nativeDisabled).toBe(true);
        expect(layout.counts.top).toBeGreaterThanOrEqual(layout.bar.bottom);
        expect(layout.visibleCounts).toMatch(/MB/);
        expect(layout.visibleCounts).toContain(`${percent}%`);
      }
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
      if (mode === "narrow-200-text") expect(layout.rootFont).toBe("32px");
      if (mode === "dark") expect(layout.theme).toBe("dark");
      if (mode === "forced-colors") expect(layout.forced).toBe(true);
      if (process.env.FEEDBACK_SHOTS) {
        const out = `${process.env.FEEDBACK_SHOTS}/${stage}`;
        await mkdir(out, { recursive: true });
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeInViewport();
        await page.screenshot({
          path: `${out}/${mode}-${phase}-controls.png`,
          animations: "disabled",
        });
        await row
          .getByRole("button", { name: "Cancel", exact: true })
          .scrollIntoViewIfNeeded();
        await expect(
          row.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeInViewport();
        await page.screenshot({
          path: `${out}/${mode}-${phase}-progress.png`,
          animations: "disabled",
        });
        if (mode === "narrow-200-text")
          await page.screenshot({
            path: `${out}/${mode}-${phase}-context.png`,
            fullPage: true,
            animations: "disabled",
          });
        await writeFile(
          `${out}/${mode}-${phase}.json`,
          JSON.stringify(
            {
              head: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
                encoding: "utf8",
              }).trim(),
              source,
              mode,
              phase,
              stage,
              synthetic: true,
              fixture:
                "FAKE accepted catalogue; first in use; second native-side copy pending; final byte phase via synthetic active snapshot",
              layout,
              external,
            },
            null,
            2,
          ),
        );
      }
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(row.getByRole("progressbar")).toHaveCount(0);
      await expect(
        row.getByRole("button", {
          name: `Download ${FAKE_CATALOG[1].name}`,
          exact: true,
        }),
      ).toBeEnabled();
      expect(await aiCalls(page, AI_COMMANDS.download)).toEqual([
        { request: { index: 1 } },
      ]);
      expect(external).toEqual([]);
      await expectOnlyFakedCommands(page);
    });
  }
}
