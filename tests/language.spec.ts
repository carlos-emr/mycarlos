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
  // Preferences shows the language in use on the unlock screen's button, which opens the same
  // dialog: one real radio for each language, focus back on the button when it closes.
  const opener = () => page.locator(".language-preference .language-button");
  const dialog = () => page.locator(".native-language-dialog");
  await expect(page.getByRole("radio", { name: "English" })).toHaveCount(0);
  await opener().click();
  const english = dialog().getByRole("radio", { name: "English", exact: true });
  await english.check();
  await expect(english).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await english.focus();
  await page.keyboard.press("ArrowDown");
  await expect(dialog().getByRole("radio", { name: "Français" })).toBeFocused();
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
    const choice = dialog().getByRole("radio", { name: autonym, exact: true });
    await choice.check();
    await expect(choice).toBeChecked();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    // The dialog speaks the chosen language: its own title is the translated word.
    await expect(
      dialog().getByRole("heading", {
        name: translate(locale, "language.title"),
      }),
    ).toBeVisible();
  }
  // Close: the dialog goes, the focus is back on the button, and the page speaks the language.
  await dialog()
    .getByRole("button", {
      name: translate("zh-TW", "interface.AnonymizePreview.close"),
    })
    .click();
  await expect(dialog()).toHaveCount(0);
  await expect(opener()).toBeFocused();
  await expect(
    page.getByRole("heading", {
      name: translate("zh-TW", "sidebar.preferences"),
      level: 1,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
  expect(await page.evaluate(() => Reflect.get(window, "__initialLang"))).toBe(
    "zh-TW",
  );
  await preferences(page);
  await opener().click();
  await expect(dialog().getByRole("radio", { name: "繁體中文" })).toBeChecked();
  await dialog()
    .getByRole("button", {
      name: translate("zh-TW", "interface.AnonymizePreview.close"),
    })
    .click();
  await expect(
    page.locator('.appearance-choice input[value="high-contrast"]'),
  ).toBeChecked();
  await opener().click();
  await dialog().locator(".language-choice input").first().check();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    dialog().locator(".language-choice input").first(),
  ).toBeChecked();
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
    // Close is the dialog's own button, inside the dialog.
    expect(close.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(close.x + close.width).toBeLessThanOrEqual(box.x + box.width + 1);
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

// The language list (in the dialog Preferences opens) is a grid of real radio buttons: one column in a narrow
// space or with enlarged text, two in a medium one (the dialog's, even in a wide window). The breakpoints are
// the grid's own width in rem (22rem and 40rem), so enlarged text goes to fewer columns.
for (const [width, zoom] of [
  [320, ""],
  [412, ""],
  [1100, ""],
  [1100, "200%"],
  [320, "200%"],
] as const) {
  test(`Preferences' language dialog lays the language buttons out by the room they have at ${width}px${zoom ? " with text at " + zoom : ""}`, async ({
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
    // The list is the language dialog's, opened from Preferences' language button.
    await page.locator(".language-preference .language-button").click();
    const group = page
      .locator(".native-language-dialog")
      .getByRole("group", { name: "Language" });
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
    // The dialog is narrower than the page: a wide window gets its two columns, not three.
    if (width === 1100 && !zoom) expect(layout.columns).toBe(2);
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
