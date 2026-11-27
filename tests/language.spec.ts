import { expect, test, type Page } from "@playwright/test";
import { LOCALES } from "../src/i18n/types";
import { translate } from "./support/fluent";
import {
  expectNoAxeViolations,
  expectOnlyFakedCommands,
  fakeVault,
} from "./support/a11y";

async function preferences(page: Page) {
  await page
    .getByRole("button", {
      name: /^(Preferences|Préférences|Preferencias|Preferencje|Preferências|偏好设置|偏好設定)$/,
    })
    .first()
    .click();
}

test("language choices persist, preserve High contrast and work from the keyboard", async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "languages", { get: () => ["en-CA"] });
    document.addEventListener("DOMContentLoaded", () =>
      Reflect.set(window, "__initialLang", document.documentElement.lang),
    );
  });
  await fakeVault(page, "unlocked");
  await page.goto("/");
  await preferences(page);
  await page.locator('.appearance-choice input[value="high-contrast"]').check();
  const english = page.getByRole("radio", { name: "English", exact: true });
  await english.check();
  await expect(english).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await english.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Français" })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  for (const [locale, autonym] of [
    ["en", "English"],
    ["fr", "Français"],
    ["es", "Español"],
    ["pl", "Polski"],
    ["pt-BR", "Português (Brasil)"],
    ["zh-CN", "简体中文 (Mandarin)"],
    ["zh-TW", "繁體中文"],
  ] as const) {
    const choice = page.getByRole("radio", { name: autonym, exact: true });
    await choice.check();
    await expect(choice).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(
      page.getByRole("heading", {
        name: translate(locale, "sidebar.preferences"),
        level: 1,
      }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  expect(await page.evaluate(() => Reflect.get(window, "__initialLang"))).toBe(
    "zh-TW",
  );
  await preferences(page);
  await expect(page.getByRole("radio", { name: "繁體中文" })).toBeChecked();
  await expect(
    page.locator('.appearance-choice input[value="high-contrast"]'),
  ).toBeChecked();
  await page.locator(".language-choice input").first().check();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".language-choice input").first()).toBeChecked();
  expect(
    await page.evaluate(() => localStorage.getItem("mycarlos.language.v1")),
  ).toBeNull();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const calls = await page.evaluate(
    () => Reflect.get(window, "__ipcCalls") as string[],
  );
  expect(
    calls.filter(
      (command) =>
        command.startsWith("vault_") &&
        ![
          "vault_status",
          "vault_snapshot",
          "vault_touch",
          "vault_set_auto_lock",
          // Reads the library makes at start (#359): they change nothing.
          "vault_video_pending",
          "vault_is_video",
        ].includes(command),
    ),
  ).toEqual([]);
  await page.screenshot({
    path: info.outputPath("language-screen.png"),
    fullPage: true,
  });
  await expectOnlyFakedCommands(page);
});

test("the language is chosen on the first screen only, and the set-up form follows it at 320px and enlarged text", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await fakeVault(page, "absent", { recoveryKey: false });
  await page.goto("/");
  await expect(
    page.getByRole("group", { name: "Language" }).getByRole("radio"),
  ).toHaveCount(8);
  await expect(page.getByRole("combobox", { name: "Language" })).toHaveCount(0);
  await page.getByRole("radio", { name: "English", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: "Français" })).toBeFocused();
  await expect(
    page.getByRole("heading", {
      name: translate("fr", "comfort.title"),
      level: 1,
    }),
  ).toBeVisible();
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  const choicesFit = await page
    .locator(".language-choice label")
    .evaluateAll((labels) =>
      labels.every((label) => {
        const box = label.getBoundingClientRect();
        const span = label.querySelector("span")!;
        // 36px for a mouse, 44px for a finger.
        const minimum = matchMedia(
          "(pointer: fine) and (not (any-pointer: coarse))",
        ).matches
          ? 36
          : 44;
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.height >= minimum &&
          span.scrollWidth <= span.clientWidth + 1
        );
      }),
    );
  expect(choicesFit).toBe(true);
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "";
  });
  await page
    .getByRole("button", {
      name: translate("fr", "comfort.continue"),
      exact: true,
    })
    .click();
  // The set-up form is in the language chosen on the first screen, and offers
  // no language choice of its own (nor does the unlock screen).
  await expect(page.getByRole("group", { name: "Language" })).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: translate("fr", "language.title") }),
  ).toHaveCount(0);
  const profile = page.getByRole("textbox", {
    name: translate("fr", "create.profile.label"),
  });
  const password = page.getByLabel(translate("fr", "passphrase.label"), {
    exact: true,
  });
  await profile.fill("FAKE Language Patient");
  await password.fill("FAKE draft");
  await expect(
    page.getByRole("heading", {
      name: translate("fr", "create.title"),
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator("#passphrase-too-short")).toHaveText(
    translate("fr", "passphrase.tooShort", { min: 15 }),
  );
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  const headingFits = await page
    .locator(".vault-card h1")
    .evaluate((heading) => heading.scrollWidth <= heading.clientWidth + 1);
  expect(headingFits).toBe(true);
  const create = page.getByRole("button", {
    name: translate("fr", "create.submit"),
    exact: true,
  });
  await create.scrollIntoViewIfNeeded();
  await expect(create).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const box = await create.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: info.outputPath("language-screen.png"),
    fullPage: true,
  });
  await expectOnlyFakedCommands(page);
});

test("the unlock screen has a globe and language button that opens the list, with a 44px target and no shift of the passphrase field", async ({
  page,
}) => {
  await fakeVault(page, "locked");
  await page.goto("/");
  const field = page.getByLabel("Passphrase", { exact: true });
  await expect(field).toBeVisible();
  const before = await field.boundingBox();
  const button = page.getByRole("button", { name: /^English \(Language\)$/ });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  // Opening and closing the list does not move the passphrase field.
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Language" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  const reopened = await field.boundingBox();
  expect(Math.abs(reopened!.y - before!.y)).toBeLessThan(2);
  // A language chosen from the list applies and the button shows its own name.
  await button.click();
  await dialog.getByRole("radio", { name: "Español" }).check();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: /^Español \(/ })).toBeFocused();
  await expectOnlyFakedCommands(page);
});

for (const width of [320, 412, 1100]) {
  test(`the language dialog insets its list like its title and does not repeat the heading, at ${width}px`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 760 });
    await fakeVault(page, "locked");
    await page.goto("/");
    await page.getByRole("button", { name: /^English \(Language\)$/ }).click();
    const dialog = page.getByRole("dialog", { name: "Language" });
    await expect(dialog).toBeVisible();
    // The word is the dialog's title only: no second visible heading above the list, and
    // the list is still a named group.
    await expect(dialog.getByRole("heading", { name: "Language" })).toHaveCount(
      1,
    );
    await expect(dialog.locator(".language-title")).toHaveCount(0);
    await expect(dialog.getByRole("group", { name: "Language" })).toBeVisible();
    // The options line up with the title: inset from the dialog's edge by the same padding,
    // not flush against it.
    const box = (await dialog.boundingBox())!;
    const title = (await dialog
      .getByRole("heading", { name: "Language" })
      .boundingBox())!;
    const firstOption = (await dialog
      .getByRole("radio")
      .first()
      .boundingBox())!;
    const close = (await dialog
      .getByRole("button", { name: "Close" })
      .boundingBox())!;
    expect(title.x - box.x).toBeGreaterThanOrEqual(16);
    expect(firstOption.x - box.x).toBeGreaterThanOrEqual(16);
    expect(Math.abs(firstOption.x - title.x)).toBeLessThan(2);
    // Close is the dialog's own button, inside the dialog, in the title's row at the right with a
    // little room from the edge (the same place as the document details' Close), and no footer.
    expect(close.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(close.x + close.width).toBeLessThanOrEqual(box.x + box.width - 12);
    expect(close.x).toBeGreaterThan(title.x + title.width / 2);
    expect(close.y).toBeLessThan(title.y + title.height);
    expect(close.y + close.height).toBeLessThan(firstOption.y);
    expect(close.height).toBeGreaterThanOrEqual(44);
    await expect(dialog.locator("footer")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await expectNoAxeViolations(page, `the language dialog at ${width}px`);
    // Nothing runs out of the dialog sideways.
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`language-dialog-${width}.png`),
    });
    await expectOnlyFakedCommands(page);
  });
}

// With 200% text on a phone the title may take more than one line in some languages: it folds and
// Close stays at the top right of the dialog, inside it, with room from the edge.
test("the language dialog's Close stays at the top right of its title with 200% text, in every language", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "sets its own sizes");
  const problems: string[] = [];
  for (const locale of LOCALES) {
    const context = await browser.newContext({
      baseURL: info.project.use.baseURL,
      viewport: { width: 320, height: 900 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await page.addInitScript((locale) => {
        localStorage.setItem("mycarlos.language.v1", locale);
      }, locale);
      await fakeVault(page, "locked");
      const cdp = await context.newCDPSession(page);
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const title = translate(locale, "language.title");
      await page
        .getByRole("button", { name: new RegExp(`\\(${title}\\)$`) })
        .click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      const heading = (await dialog
        .getByRole("heading", { name: title })
        .boundingBox())!;
      const closeName = translate(locale, "interface.AnonymizePreview.close");
      const close = dialog.getByRole("button", { name: closeName });
      const at = (await close.boundingBox())!;
      if (at.x + at.width > box.x + box.width - 8)
        problems.push(`${locale}: Close touches the dialog's right edge`);
      if (at.x < box.x) problems.push(`${locale}: Close starts outside`);
      if (at.y > heading.y + heading.height)
        problems.push(`${locale}: Close is below the title's row`);
      if (heading.x + heading.width > at.x + 1)
        problems.push(`${locale}: the title runs under Close`);
      if (!(await dialog.evaluate((n) => n.scrollWidth <= n.clientWidth)))
        problems.push(`${locale}: the dialog scrolls sideways`);
      await expect(close).toBeFocused();
      await expectNoAxeViolations(page, `the language dialog in ${locale}`);
      await page.screenshot({
        path: info.outputPath(`language-dialog-200pc-${locale}.png`),
      });
    } finally {
      await context.close();
    }
  }
  expect(problems).toEqual([]);
});

// The language list in Preferences is a grid of real radio buttons: one column in a narrow
// space or with enlarged text, two in a medium one, three in a wide one. The breakpoints are
// the grid's own width in rem (22rem and 40rem), so enlarged text goes to fewer columns.
for (const [width, zoom] of [
  [320, ""],
  [412, ""],
  [1100, ""],
  [1100, "200%"],
  [320, "200%"],
] as const) {
  test(`Preferences lays the language buttons out by the room they have at ${width}px${zoom ? " with text at " + zoom : ""}`, async ({
    page,
  }, info) => {
    test.skip(
      info.project.name === "phone" && width > 500,
      "a wide window is measured on the desktop project",
    );
    await fakeVault(page, "unlocked");
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await preferences(page);
    if (zoom)
      await page.locator("html").evaluate((element, size) => {
        element.style.fontSize = size;
      }, zoom);
    const group = page.getByRole("group", { name: "Language" });
    await expect(group.getByRole("radio")).toHaveCount(8);
    const layout = await group.evaluate((fieldset) => {
      const labels = [...fieldset.querySelectorAll("label")];
      const rem = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const room = fieldset.getBoundingClientRect().width / rem;
      const minimum = matchMedia(
        "(pointer: fine) and (not (any-pointer: coarse))",
      ).matches
        ? 36
        : 44;
      return {
        room,
        columns: new Set(
          labels.map((l) => Math.round(l.getBoundingClientRect().left)),
        ).size,
        inside: labels.every((l) => {
          const box = l.getBoundingClientRect();
          return box.left >= 0 && box.right <= innerWidth;
        }),
        tallEnough: labels.every(
          (l) => l.getBoundingClientRect().height >= minimum,
        ),
        sideways: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(layout.columns).toBe(
      layout.room >= 40 ? 3 : layout.room >= 22 ? 2 : 1,
    );
    if (width === 320) expect(layout.columns).toBe(1);
    if (width === 1100 && !zoom) expect(layout.columns).toBe(3);
    if (zoom) expect(layout.columns).toBeLessThan(3);
    expect(layout.inside).toBe(true);
    expect(layout.tallEnough).toBe(true);
    expect(layout.sideways).toBe(true);
    // The chosen one is set, and a name stays in its own script.
    await expect(
      group.getByRole("radio", { name: "System default" }),
    ).toBeChecked();
    await expect(group.locator('[lang="zh-CN"]')).toHaveText("简体中文");
  });
}
