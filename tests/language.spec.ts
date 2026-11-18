import { expect, test, type Page } from "@playwright/test";
import { translate } from "./support/fluent";
import { expectOnlyFakedCommands, fakeVault } from "./support/a11y";

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
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          box.height >= 44 &&
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
  const button = page.getByRole("button", { name: /^Language: English$/ });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Language" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Español" }).check();
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  const own = page.getByRole("button", { name: /Español$/ });
  await expect(own).toBeFocused();
  // Choosing a language does not move the passphrase field.
  const after = await page
    .getByLabel(translate("es", "passphrase.label"), { exact: true })
    .boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(2);
  await expectOnlyFakedCommands(page);
});
