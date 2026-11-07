import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  AI_COMMANDS,
  aiCalls,
  aiCancelled,
  aiHeld,
  fakeAiWith,
  holdAi,
  releaseAi,
} from "./support/aiFake";
import { expectOnlyFakedCommands, WCAG_TAGS } from "./support/a11y";
import { translate } from "./support/fluent";
import { catalogRows, FAKE_CATALOG } from "./support/modelCatalogFake";
import {
  FAKE_PASSPHRASE,
  fakeVaultWith,
  myRecords,
  openDetails,
  sidebar,
} from "./support/vaultFake";

// Catalog-only #276A. Device state and model commands are synthetic; no model is fetched/run.
const first = FAKE_CATALOG[0];
const second = FAKE_CATALOG[1];
const tr = (key: Parameters<typeof translate>[1]) => translate("en", key);
const region = (page: Page, index: number) =>
  page.getByRole("region", { name: FAKE_CATALOG[index].name, exact: true });
const action = (page: Page, index: number, verb: "download" | "remove") =>
  region(page, index).getByRole("button", {
    name: `${tr(`ai.models.${verb}`)} ${FAKE_CATALOG[index].name}`,
    exact: true,
  });
async function preferences(
  page: Page,
  locale: Parameters<typeof translate>[0] = "en",
) {
  await page
    .getByRole("navigation", {
      name: translate(locale, "sidebar.label"),
      exact: true,
    })
    .getByRole("button", {
      name: translate(locale, "ai.preferences.title"),
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: translate(locale, "ai.preferences.title"),
      level: 1,
    }),
  ).toBeVisible();
}
async function start(
  page: Page,
  installed: number[] = [],
  pickedIndex = 1,
  locale: Parameters<typeof translate>[0] = "en",
) {
  await fakeVaultWith(page, { start: "unlocked" });
  await fakeAiWith(page, { models: catalogRows(installed), pickedIndex });
  await page.addInitScript(
    (locale) => localStorage.setItem("mycarlos.language.v1", locale),
    locale,
  );
  await page.goto("/");
  await preferences(page, locale);
}
async function pendingAnswer(page: Page) {
  await holdAi(page, AI_COMMANDS.summarize);
  await page.evaluate((command) => {
    const ipc = Reflect.get(window, "__TAURI_INTERNALS__") as {
      invoke: (command: string) => Promise<unknown>;
    };
    Reflect.set(
      window,
      "__heldCatalogAnswer",
      ipc.invoke(command).catch(() => null),
    );
  }, AI_COMMANDS.summarize);
  await expect.poll(() => aiHeld(page)).toEqual([AI_COMMANDS.summarize]);
}
async function remove(page: Page, index: number) {
  await action(page, index, "remove").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", {
      name: `${tr("ai.models.remove")} ${FAKE_CATALOG[index].name}`,
      exact: true,
    })
    .click();
}
test.beforeEach(({}, info) =>
  test.skip(
    info.project.name === "phone",
    "the AI helper runs on computers; narrow desktop reflow is covered below",
  ),
);

test("lists both offered models; downloading several keeps the first In use", async ({
  page,
}) => {
  await start(page);
  await expect(
    page.getByRole("radiogroup", { name: tr("ai.models.group") }),
  ).toBeVisible();
  for (const [index, model] of FAKE_CATALOG.entries()) {
    await expect(region(page, index)).toContainText(model.licence);
    await expect(action(page, index, "download")).toBeVisible();
    await expect(
      page.getByRole("radio", { name: model.name, exact: true }),
    ).toBeDisabled();
  }
  await action(page, 0, "download").click();
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeChecked();
  await action(page, 1, "download").click();
  await expect(action(page, 1, "remove")).toBeVisible();
  await expect(action(page, 0, "remove")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeChecked();
  expect(await aiCalls(page, AI_COMMANDS.download)).toEqual([
    { request: { index: 0 } },
    { request: { index: 1 } },
  ]);
  await expectOnlyFakedCommands(page);
});

test("another download leaves the answer running; switching In use stops it", async ({
  page,
}) => {
  await start(page, [0]);
  await pendingAnswer(page);
  await holdAi(page, AI_COMMANDS.download);
  await action(page, 1, "download").click();
  await expect(region(page, 1).getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(region(page, 0).getByRole("progressbar")).toHaveCount(0);
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeChecked();
  expect(await aiHeld(page)).toEqual([
    AI_COMMANDS.summarize,
    AI_COMMANDS.download,
  ]);
  await releaseAi(page, AI_COMMANDS.download);
  await expect(action(page, 1, "remove")).toBeVisible();
  expect(await aiHeld(page)).toEqual([AI_COMMANDS.summarize]);
  await page.getByRole("radio", { name: second.name, exact: true }).check();
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeChecked();
  await expect.poll(() => aiHeld(page)).toEqual([]);
  expect(await aiCancelled(page)).toContainEqual({
    command: AI_COMMANDS.summarize,
    by: AI_COMMANDS.use,
  });
  expect(await aiCalls(page, AI_COMMANDS.use)).toEqual([
    { request: { index: 1 } },
  ]);
  await expectOnlyFakedCommands(page);
});

test("a keyboard choice is read back after the window reloads", async ({
  page,
}) => {
  await start(page, [0, 1]);
  const chosen = page.getByRole("radio", { name: first.name, exact: true });
  await chosen.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeFocused();
  await page.reload();
  // A reload locks the vault; the device's model choice survives the unlock.
  await expect(
    page.getByRole("heading", { name: "Unlock your vault", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Passphrase", { exact: true }).fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(myRecords(page)).toBeVisible();
  await preferences(page);
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeChecked();
  await expect(action(page, 0, "remove")).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("Add an accepted file keeps both models and marks only the picked one", async ({
  page,
}) => {
  await start(page, [0]);
  await page
    .getByRole("button", { name: tr("ai.model.add"), exact: true })
    .click();
  await expect(region(page, 1)).toContainText(tr("ai.models.addedByYou"));
  await expect(action(page, 0, "remove")).toBeVisible();
  await expect(action(page, 1, "remove")).toBeVisible();
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeChecked();
  expect(await aiCalls(page, AI_COMMANDS.addPicked)).toEqual([{}]);
  await expectOnlyFakedCommands(page);
});

test("removing inactive leaves In use; removing In use falls back, then to none", async ({
  page,
}) => {
  await start(page, [0, 1]);
  await remove(page, 1);
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeChecked();
  await action(page, 1, "download").click();
  await expect(action(page, 1, "remove")).toBeVisible();
  await remove(page, 0);
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeChecked();
  await remove(page, 1);
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeDisabled();
  await expect(action(page, 0, "download")).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("the correct row reattaches, Cancel resets it, and a resumed bar starts half way", async ({
  page,
}) => {
  await start(page, [0]);
  await holdAi(page, AI_COMMANDS.download);
  await action(page, 1, "download").click();
  await expect(region(page, 1).getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await sidebar(page)
    .getByRole("button", { name: tr("security.title"), exact: true })
    .click();
  await preferences(page);
  await expect(region(page, 1).getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await expect(region(page, 0).getByRole("progressbar")).toHaveCount(0);
  await region(page, 1)
    .getByRole("button", { name: tr("common.cancel"), exact: true })
    .click();
  await expect(region(page, 1).getByRole("progressbar")).toHaveCount(0);
  await expect(action(page, 1, "download")).toBeEnabled();
  await expect(
    page.getByRole("radio", { name: first.name, exact: true }),
  ).toBeChecked();
  await holdAi(page, AI_COMMANDS.download);
  await action(page, 1, "download").click();
  await expect(region(page, 1).getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  await releaseAi(page, AI_COMMANDS.download);
  await expect(action(page, 1, "remove")).toBeVisible();
  await expectOnlyFakedCommands(page);
});

test("the answer still identifies the model selected for that answer", async ({
  page,
}) => {
  await start(page, [0, 1]);
  await page.getByRole("radio", { name: second.name, exact: true }).check();
  await expect(
    page.getByRole("radio", { name: second.name, exact: true }),
  ).toBeChecked();
  await sidebar(page)
    .getByRole("button", { name: /My records/ })
    .first()
    .click();
  await expect(myRecords(page)).toBeVisible();
  const details = await openDetails(page, "FAKE Letter.pdf");
  await details
    .getByRole("button", {
      name: tr("interface.RecordDetails.read"),
      exact: true,
    })
    .click();
  const reader = page.getByRole("dialog", {
    name: "FAKE Letter.pdf",
    exact: true,
  });
  await reader
    .getByRole("button", { name: tr("ai.summary.button"), exact: true })
    .click();
  await page
    .getByRole("dialog", { name: tr("aiHelper.notice.title"), exact: true })
    .getByRole("button", {
      name: tr("interface.AiHelperNotice.continue"),
      exact: true,
    })
    .click();
  await expect(
    reader.getByRole("region", { name: tr("ai.summary.title"), exact: true }),
  ).toContainText(second.name);
  await expectOnlyFakedCommands(page);
});

for (const locale of [
  "en",
  "es",
  "fr",
  "pl",
  "pt-BR",
  "zh-CN",
  "zh-TW",
] as const) {
  test(`catalog controls remain named and fit 320px / 200% in ${locale}`, async ({
    page,
  }) => {
    await start(page, [0], 1, locale);
    await page.addStyleTag({
      content: ":root { font-size: 200% !important; }",
    });
    await page.setViewportSize({ width: 320, height: 1000 });
    const group = page.getByRole("radiogroup", {
      name: translate(locale, "ai.models.group"),
      exact: true,
    });
    await expect(group).toBeVisible();
    const download = region(page, 1).getByRole("button", {
      name: `${translate(locale, "ai.models.download")} ${second.name}`,
      exact: true,
    });
    await holdAi(page, AI_COMMANDS.download);
    await download.click();
    const cancel = region(page, 1).getByRole("button", {
      name: translate(locale, "common.cancel"),
      exact: true,
    });
    await cancel.scrollIntoViewIfNeeded();
    await expect(cancel).toBeInViewport();
    await expect(region(page, 1).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("html")).toHaveCSS("font-size", "32px");
    const axe = await new AxeBuilder({ page })
      .include(".native-ai-model")
      .withTags(WCAG_TAGS)
      .analyze();
    expect(axe.violations).toEqual([]);
    await cancel.click();
    await expect(region(page, 1).getByRole("progressbar")).toHaveCount(0);
    await expectOnlyFakedCommands(page);
  });
}
