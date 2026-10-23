import { expect, test, type Page } from "@playwright/test";
import { translate } from "../src/i18n/core";
import { expectOnlyFakedCommands, fakeVault } from "./support/a11y";

async function preferences(page: Page) {
  await page
    .getByRole("button", {
      name: /^(Preferences|Préférences|Preferencias|Preferencje|Preferências)$/,
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
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  expect(await page.evaluate(() => Reflect.get(window, "__initialLang"))).toBe(
    "pt-BR",
  );
  await preferences(page);
  await expect(
    page.getByRole("radio", { name: "Português (Brasil)" }),
  ).toBeChecked();
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
  await page.getByRole("combobox", { name: "Language" }).selectOption("fr");
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
  await page
    .getByRole("combobox", { name: translate("fr", "language.title") })
    .selectOption("pl");
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
