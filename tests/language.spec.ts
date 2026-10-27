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
    ["zh-CN", "简体中文"],
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

test("setup language translates the form without resetting drafts at 320px and enlarged text", async ({
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
  await page
    .getByRole("button", {
      name: translate("fr", "comfort.continue"),
      exact: true,
    })
    .click();
  const profile = page.getByRole("textbox", {
    name: translate("fr", "create.profile.label"),
  });
  const password = page.getByLabel(translate("fr", "passphrase.label"), {
    exact: true,
  });
  await profile.fill("FAKE Language Patient");
  await password.fill("FAKE draft");
  await page.getByRole("radio", { name: "Polski" }).check();
  await expect(
    page.getByRole("textbox", {
      name: translate("pl", "create.profile.label"),
    }),
  ).toHaveValue("FAKE Language Patient");
  await expect(
    page.getByLabel(translate("pl", "passphrase.label"), { exact: true }),
  ).toHaveValue("FAKE draft");
  await expect(
    page.getByRole("heading", {
      name: translate("pl", "create.title"),
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator("#passphrase-too-short")).toHaveText(
    translate("pl", "passphrase.tooShort", { min: 15 }),
  );
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
  const headingFits = await page
    .locator(".vault-card h1")
    .evaluate((heading) => heading.scrollWidth <= heading.clientWidth + 1);
  expect(headingFits).toBe(true);
  const create = page.getByRole("button", {
    name: translate("pl", "create.submit"),
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
