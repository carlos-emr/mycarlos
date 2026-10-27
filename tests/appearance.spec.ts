import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

async function fakeVault(
  page: Page,
  platform: string,
  locked = false,
  recovery: string | null = null,
) {
  await page.addInitScript(
    ({ platform, locked, recovery }) => {
      let status = locked ? "locked" : "unlocked";
      const calls: string[] = [];
      const themes: unknown[] = [];
      Reflect.set(window, "__appearanceCommands", calls);
      Reflect.set(window, "__appearanceNativeThemes", themes);
      Reflect.set(window, "__TAURI_INTERNALS__", {
        metadata: { currentWindow: { label: "main" } },
        invoke: async (command: string, args?: { value?: unknown }) => {
          calls.push(command);
          if (command === "runtime_info") return { platform };
          if (command === "vault_status") return status;
          if (command === "vault_snapshot")
            return {
              profiles: [
                { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
              ],
              folders: [
                {
                  id: "folder",
                  profileId: "profile",
                  parentId: null,
                  name: "FAKE Results",
                  createdAtMs: Date.UTC(2026, 9, 1, 12),
                },
              ],
              records: [
                {
                  id: "record",
                  profileId: "profile",
                  folderIds: [],
                  displayName: "FAKE Example.pdf",
                  sourceLabel: "Manual import — unverified",
                  mediaType: "application/pdf",
                  plaintextSize: 200,
                  importedAtMs: Date.UTC(2026, 9, 2, 12),
                  available: true,
                },
              ],
              recovery,
              recoveryKeySetAtMs: 1,
              recoveryKeyLabel: "FAKE Example label",
            };
          if (command === "vault_lock") {
            status = "locked";
            return;
          }
          if (command === "plugin:window|set_theme") {
            themes.push(args?.value);
            return;
          }
          if (
            [
              "vault_touch",
              "vault_set_auto_lock",
              "plugin:webview|set_webview_zoom",
            ].includes(command)
          )
            return;
          throw new Error(`Unexpected test IPC command: ${command}`);
        },
      });
    },
    { platform, locked, recovery },
  );
}

async function section(
  page: Page,
  info: TestInfo,
  value: "records" | "preferences" | "security",
) {
  const name = {
    records: "My records",
    preferences: "Preferences",
    security: "Security",
  }[value];
  // A narrow window has a row of section tabs (#67) where the sidebar was.
  const tabs = page.getByRole("navigation", { name: "Section" });
  const sidebar = page.getByRole("button", {
    name: new RegExp(`^${name}(?:\\s|$)`),
  });
  await expect(tabs.or(sidebar).first()).toBeVisible();
  // On a phone the records tab is "Records": it holds the people and
  // Shared with me, as the sidebar's top-level folders do (Ben, 21 Oct).
  const tab = value === "records" ? "Records" : name;
  if (info.project.name === "phone" || (await tabs.isVisible()))
    await tabs.getByRole("button", { name: tab, exact: true }).click();
  else await sidebar.first().click();
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
}

/**
 * WCAG 1.4.11 for the unchecked Appearance radios: the browser draws each
 * ring from color-scheme (or system colours), so there is no CSS border to
 * read. Each unchecked radio is photographed, and its pixel furthest from the
 * corner (the row behind it) must differ by at least 3:1.
 */
async function radioRingsReadable(page: Page) {
  const radios = page
    .getByRole("group", { name: "Appearance" })
    .getByRole("radio", { checked: false });
  const shots = await Promise.all(
    (await radios.all()).map(async (radio) =>
      (await radio.screenshot({ animations: "disabled" })).toString("base64"),
    ),
  );
  expect(shots).toHaveLength(3);
  // A blank page decodes them, out of reach of the app's own policies.
  const scratch = await page.context().newPage();
  try {
    const ratios = await scratch.evaluate(async (images) => {
      const luminance = (r: number, g: number, b: number) =>
        [r, g, b]
          .map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ratios: number[] = [];
      for (const data of images) {
        const image = new Image();
        image.src = `data:image/png;base64,${data}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(
          0,
          0,
          image.width,
          image.height,
        ).data;
        const back = luminance(pixels[0], pixels[1], pixels[2]);
        let best = 1;
        for (let i = 0; i < pixels.length; i += 4) {
          const value = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
          const ratio =
            (Math.max(value, back) + 0.05) / (Math.min(value, back) + 0.05);
          best = Math.max(best, ratio);
        }
        ratios.push(best);
      }
      return ratios;
    }, shots);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(3);
  } finally {
    await scratch.close();
  }
}

/** The four Appearance radio buttons (#67), by the mode each one chooses. */
function appearanceChoices(page: Page) {
  const group = page.getByRole("group", { name: "Appearance" });
  return {
    system: group.getByRole("radio", { name: "System" }),
    light: group.getByRole("radio", { name: "Light" }),
    dark: group.getByRole("radio", { name: "Dark" }),
    highContrast: group.getByRole("radio", { name: "High contrast" }),
  };
}

/** axe's WCAG 2.0, 2.1 and 2.2 A/AA rules, as #78 runs them. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(result.violations).toEqual([]);
}

/** Measure composed text colours and authored control/focus indicators, not just palette pairs. */
async function contrast(
  page: Page,
  selector: string,
  property = "color",
  minimum?: number,
) {
  const failures = await page.locator(selector).evaluateAll(
    (elements, { property, minimum }) => {
      type RGB = [number, number, number, number];
      function rgb(value: string): RGB {
        const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
        if (numbers.length < 3)
          throw new Error(`Unsupported computed colour: ${value}`);
        return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
      }
      function over(front: RGB, back: RGB): RGB {
        return [0, 1, 2]
          .map((i) => front[i] * front[3] + back[i] * (1 - front[3]))
          .concat(1) as RGB;
      }
      function luminance(value: RGB) {
        const channels = value.slice(0, 3).map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      }
      return elements.flatMap((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          box.width <= 1 ||
          box.height <= 1 ||
          style.visibility !== "visible" ||
          element.closest(".sr-only") ||
          (property !== "stroke" && element.closest('[aria-hidden="true"]'))
        )
          return [];
        if (
          property === "color" &&
          !element.textContent?.trim() &&
          !(
            element instanceof HTMLInputElement &&
            (element.value || element.placeholder)
          )
        )
          return [];
        let background: RGB = [255, 255, 255, 1];
        let opacity = 1;
        const ancestors: Element[] = [];
        for (
          let node: Element | null = element;
          node;
          node = node.parentElement
        )
          ancestors.push(node);
        for (const node of ancestors.reverse()) {
          const computed = getComputedStyle(node);
          background = over(rgb(computed.backgroundColor), background);
          opacity *= Number(computed.opacity);
        }
        const foreground = rgb(style.getPropertyValue(property));
        foreground[3] *= opacity;
        const visible = over(foreground, background);
        const a = luminance(visible),
          b = luminance(background);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large =
          parseFloat(style.fontSize) >= 24 ||
          (parseFloat(style.fontSize) >= 18.6667 &&
            Number(style.fontWeight) >= 700);
        const required = minimum ?? (large ? 3 : 4.5);
        return ratio < required
          ? [
              {
                element: element.tagName,
                text: element.textContent?.trim().slice(0, 60),
                property,
                ratio,
                required,
                foreground: style.getPropertyValue(property),
                background,
              },
            ]
          : [];
      });
    },
    { property, minimum },
  );
  expect(failures).toEqual([]);
}

const text =
  "h1,h2,h3,p,label,button,select,input,small,strong,.eyebrow,.nav-count,.tag,.chip";
/** A field's edge is the only thing that shows where to type: 3:1 (1.4.11). */
const fields =
  "input:not([type=radio]):not([type=checkbox]):not([type=file]):not([type=hidden]),select,.search";

/** In forced colours, Chromium draws text on a Canvas backplate, whatever
 * the background behind it: text the colour of Canvas would vanish. */
async function readableOnBackplate(page: Page) {
  const failures = await page.locator(text).evaluateAll((elements) => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.color = "Canvas";
    const canvas = getComputedStyle(probe).color;
    probe.remove();
    return elements
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 1 &&
          box.height > 1 &&
          getComputedStyle(element).visibility === "visible" &&
          !element.closest(".sr-only") &&
          element.textContent?.trim() &&
          getComputedStyle(element).forcedColorAdjust !== "none" &&
          getComputedStyle(element).color === canvas
        );
      })
      .map((element) => element.textContent?.trim().slice(0, 60));
  });
  expect(failures).toEqual([]);
}

test("remembers appearance and follows live system changes without vault mutations", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await fakeVault(page, phone ? "ios" : "windows");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await section(page, info, "preferences");
  const { system, light, dark } = appearanceChoices(page);
  await expect(system).toBeChecked();
  // Arrow keys move through the radio buttons, choosing as they go.
  await system.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await section(page, info, "preferences");
  await expect(dark).toBeChecked();
  await system.check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await light.check();
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    await page
      .locator("html")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  );
  const calls = await page.evaluate(
    () => Reflect.get(window, "__appearanceCommands") as string[],
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
  const themes = await page.evaluate(
    () => Reflect.get(window, "__appearanceNativeThemes") as unknown[],
  );
  if (phone) expect(themes).toEqual([]);
  else expect(themes).toContain(null);
});

test("manual high contrast persists with readable controls and yields to OS colors", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await fakeVault(page, phone ? "ios" : "windows", false, "writeFailed");
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  await page.goto("/");
  await section(page, info, "preferences");
  const { system, highContrast } = appearanceChoices(page);
  await system.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(highContrast).toBeChecked();
  await expect(highContrast).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "high-contrast",
  );
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  await contrast(page, text, "color", 7);
  await contrast(page, ".appearance-choice input:focus", "outline-color", 3);
  await radioRingsReadable(page);
  await accessible(page);
  await screenshot(page, info, "manual-high-contrast-preferences");
  await section(page, info, "records");
  await expect(
    page.getByRole("button", { name: "Choose files to import" }),
  ).toBeDisabled();
  await contrast(page, text, "color", 7);
  await contrast(page, fields, "border-top-color", 3);
  await page.reload();
  await section(page, info, "preferences");
  await expect(highContrast).toBeChecked();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "high-contrast",
  );
  // The current native screens contain no links. A normal link fixture checks
  // the palette's link styling without adding product copy or a navigation path.
  await page
    .getByRole("group", { name: "Appearance", exact: true })
    .evaluate((group) => {
      const link = document.createElement("a");
      link.href = "#fake-contrast-target";
      link.textContent = "FAKE test link";
      group.append(link);
    });
  const link = page.getByRole("link", { name: "FAKE test link" });
  await contrast(page, "a", "color", 7);
  await expect(link).toHaveCSS("text-decoration-line", "underline");
  await page.emulateMedia({ forcedColors: "active" });
  const colors = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "Canvas";
    probe.style.color = "CanvasText";
    document.body.append(probe);
    const value = {
      background: getComputedStyle(probe).backgroundColor,
      text: getComputedStyle(probe).color,
    };
    probe.remove();
    return value;
  });
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    colors.background,
  );
  await expect(page.locator("html")).toHaveCSS("color", colors.text);
  await expect(highContrast).toBeChecked();
  await readableOnBackplate(page);
  expect(
    await page
      .locator("button,input,select")
      .evaluateAll((controls) =>
        controls.some(
          (element) => getComputedStyle(element).forcedColorAdjust === "none",
        ),
      ),
  ).toBe(false);
  await page.emulateMedia({ forcedColors: "none" });
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(0, 0, 0)",
  );
  const nativeThemes = await page.evaluate(
    () => Reflect.get(window, "__appearanceNativeThemes") as unknown[],
  );
  if (phone) expect(nativeThemes).toEqual([]);
  else {
    expect(nativeThemes).toContain("dark");
    expect(nativeThemes).not.toContain("high-contrast");
  }
});

test("manual high contrast choice wraps at 320px with enlarged text", async ({
  page,
}, info) => {
  await fakeVault(page, info.project.name === "phone" ? "ios" : "windows");
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await section(page, info, "preferences");
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  const choice = appearanceChoices(page).highContrast;
  await choice.check();
  await choice.scrollIntoViewIfNeeded();
  await expect(choice).toBeChecked();
  const bounds = await choice.locator("..").evaluate((label) => {
    const box = label.getBoundingClientRect();
    const span = label.querySelector("span")!;
    return {
      left: box.left,
      right: box.right,
      height: box.height,
      width: innerWidth,
      textFits: span.scrollWidth <= span.clientWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.textFits).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, info, "manual-high-contrast-320-enlarged");
});

// The browser preview's screens, as the smoke test's axe run walks them, in
// dark mode too: System follows the device, so a dark device gets them dark.
test("the browser preview has no WCAG A/AA violations in dark mode", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  async function openSection(value: string, label: string) {
    if (info.project.name === "phone")
      await page.getByRole("combobox", { name: "Section" }).selectOption(value);
    else
      await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  }
  await page.goto("/");
  await accessible(page);
  await contrast(page, text);
  await screenshot(page, info, "dark-preview-library");
  await openSection("security", "Security & backup");
  await accessible(page);
  await contrast(page, text);
  await openSection("health", "Health data");
  await accessible(page);
  await contrast(page, text);
  await openSection("records", "My records");
  await page
    .getByRole("button", {
      name: "More options for Prescription — ramipril 5mg",
    })
    .click();
  await accessible(page);
  await contrast(page, text);
});

for (const theme of ["light", "dark"] as const) {
  test(`${theme} native screens have readable text, focus and selection`, async ({
    page,
  }, info) => {
    await fakeVault(page, info.project.name === "phone" ? "ios" : "windows");
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    await section(page, info, "preferences");
    const choices = appearanceChoices(page);
    const choice = choices[theme];
    await choices.system.focus();
    await page.keyboard.press("ArrowDown");
    if (theme === "dark") await page.keyboard.press("ArrowDown");
    await expect(choice).toBeChecked();
    await expect(choice).toBeFocused();
    await expect(choice).toHaveCSS("outline-style", "solid");
    await contrast(page, text);
    // The radio's ring is drawn by the browser from color-scheme, not from a
    // CSS border: radioRingsReadable measures it from pixels.
    await contrast(page, ".appearance-choice input:focus", "outline-color", 3);
    await radioRingsReadable(page);
    await accessible(page);
    await screenshot(page, info, `${theme}-preferences-focus`);
    await section(page, info, "records");
    await accessible(page);
    await contrast(page, text);
    await screenshot(page, info, `${theme}-library`);
    await contrast(page, fields, "border-top-color", 3);
    const selected = page.getByRole("button", {
      name: "Select FAKE Example.pdf",
    });
    await selected.click();
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await contrast(page, text);
    await accessible(page);
    await screenshot(page, info, `${theme}-selected-bulk`);
    await selected.click();
    await page.getByRole("button", { name: "Grid view", exact: true }).click();
    await contrast(page, text);
    await accessible(page);
    await screenshot(page, info, `${theme}-grid`);
    await page
      .getByRole("button", { name: "Rename folder FAKE Results" })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Rename folder",
      exact: true,
    });
    await expect(dialog.getByLabel("Folder name")).toBeFocused();
    await contrast(page, text);
    await contrast(page, "input:focus", "outline-color", 3);
    await accessible(page);
    await screenshot(page, info, `${theme}-rename-dialog-focus`);
    await contrast(page, fields, "border-top-color", 3);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await section(page, info, "security");
    await contrast(page, text);
    await accessible(page);
    await screenshot(page, info, `${theme}-security`);
    await contrast(page, fields, "border-top-color", 3);
  });

  test(`${theme} locked screen keeps System live`, async ({ page }, info) => {
    await fakeVault(
      page,
      info.project.name === "phone" ? "ios" : "windows",
      true,
    );
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/");
    await page.getByLabel("Passphrase", { exact: true }).focus();
    await contrast(page, text);
    await contrast(page, "input:focus", "outline-color", 3);
    await accessible(page);
    await screenshot(page, info, `${theme}-locked-focus`);
    await page.emulateMedia({
      colorScheme: theme === "light" ? "dark" : "light",
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      theme === "light" ? "dark" : "light",
    );
  });
}

test("forced colours preserve focus, selection and icons over a remembered dark choice", async ({
  page,
}, info) => {
  await fakeVault(
    page,
    info.project.name === "phone" ? "ios" : "windows",
    false,
    "writeFailed",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await section(page, info, "preferences");
  const { dark: choice } = appearanceChoices(page);
  await choice.check();
  await page.emulateMedia({ forcedColors: "active" });
  await expect(choice).toBeChecked();
  // A key press, so that focus is shown as it is to a keyboard user; it ends on Dark.
  await choice.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await expect(choice).toBeChecked();
  await expect(choice).toHaveCSS("outline-style", "solid");
  await contrast(page, ".appearance-choice input:focus", "outline-color", 3);
  await radioRingsReadable(page);
  await readableOnBackplate(page);
  await screenshot(page, info, "forced-preferences-focus");
  await section(page, info, "records");
  await expect(
    page.getByText("Changes are paused.", { exact: true }),
  ).toBeVisible();
  const selected = page.getByRole("button", {
    name: "Select FAKE Example.pdf",
  });
  await selected.click();
  await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(selected).toHaveCSS("outline-style", "solid");
  await expect(selected).toHaveCSS("opacity", "1");
  await expect(selected).toHaveCSS("box-shadow", "none");
  // A phone shows no sidebar, so no brand mark.
  if (info.project.name !== "phone")
    await expect(page.locator(".brand-mark .icon")).toBeVisible();
  await contrast(page, ".icon", "stroke", 3);
  await accessible(page);
  await readableOnBackplate(page);
  await screenshot(page, info, "forced-warning-selected");
  await page.emulateMedia({ forcedColors: "none" });
  await section(page, info, "preferences");
  await expect(choice).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("forced colours keep the locked screen's field, focus and button visible", async ({
  page,
}, info) => {
  await fakeVault(
    page,
    info.project.name === "phone" ? "ios" : "windows",
    true,
  );
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
  await page.goto("/");
  const passphrase = page.getByLabel("Passphrase", { exact: true });
  await passphrase.focus();
  await expect(passphrase).toHaveCSS("outline-style", "solid");
  await contrast(page, "input:focus", "outline-color", 3);
  await contrast(page, "input", "border-top-color", 3);
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await accessible(page);
  await readableOnBackplate(page);
  await screenshot(page, info, "forced-locked-focus");
});

test("forced colours keep the library's controls and a dialog's field and buttons visible", async ({
  page,
}, info) => {
  await fakeVault(page, info.project.name === "phone" ? "ios" : "windows");
  await page.emulateMedia({ colorScheme: "dark", forcedColors: "active" });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
  await contrast(page, ".button.primary", "color");
  await contrast(page, ".icon", "stroke", 3);
  await accessible(page);
  await readableOnBackplate(page);
  await screenshot(page, info, "forced-library");
  await page
    .getByRole("button", { name: "Rename folder FAKE Results" })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Rename folder",
    exact: true,
  });
  const name = dialog.getByLabel("Folder name");
  await expect(name).toBeFocused();
  await expect(name).toHaveCSS("outline-style", "solid");
  await contrast(page, "input:focus", "outline-color", 3);
  await contrast(page, ".dialog-actions .button", "color");
  await accessible(page);
  await readableOnBackplate(page);
  await screenshot(page, info, "forced-rename-dialog-focus");
});

test("short-window and phone Preferences remain reachable by keyboard", async ({
  page,
}, info) => {
  await fakeVault(page, info.project.name === "phone" ? "android" : "windows");
  if (info.project.name !== "phone")
    await page.setViewportSize({ width: 320, height: 190 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await section(page, info, "preferences");
  const { system, light } = appearanceChoices(page);
  await system.focus();
  await page.keyboard.press("ArrowDown");
  await expect(light).toBeChecked();
  await expect(light).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await screenshot(page, info, "short-window-preferences");
});

test("paper preview content stays unchanged when the app theme changes", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.getByRole("button", { name: "Grid view", exact: true }).click();
  const thumbnail = page.locator(".paper-preview").first();
  await expect(thumbnail.locator("i").first()).toHaveCSS(
    "background-color",
    "rgb(15, 107, 98)",
  );
  const thumbnailBox = await thumbnail.boundingBox();
  expect(thumbnailBox).not.toBeNull();
  const thumbnailClip = {
    x: thumbnailBox!.x + 8,
    y: thumbnailBox!.y + 8,
    width: thumbnailBox!.width - 16,
    height: thumbnailBox!.height - 16,
  };
  const originalThumbnail = await page.screenshot({ clip: thumbnailClip });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    (await page.screenshot({ clip: thumbnailClip })).equals(originalThumbnail),
  ).toBe(true);
  await page.emulateMedia({ forcedColors: "active" });
  expect(
    (await page.screenshot({ clip: thumbnailClip })).equals(originalThumbnail),
  ).toBe(true);
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  await page.getByRole("button", { name: "List view", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Bloodwork — cholesterol and liver panel",
      exact: true,
    })
    .click();
  const paper = page.locator(".preview-paper");
  await expect(paper.locator("i").nth(1)).toHaveCSS(
    "background-color",
    "rgb(226, 235, 233)",
  );
  const box = await paper.boundingBox();
  expect(box).not.toBeNull();
  const clip = {
    x: box!.x + 10,
    y: box!.y + 10,
    width: box!.width - 20,
    height: box!.height - 20,
  };
  const light = await page.screenshot({ clip });
  const originalColours = await paper.evaluate((element) => ({
    paper: getComputedStyle(element).backgroundColor,
    lines: [...element.children].map(
      (line) => getComputedStyle(line).backgroundColor,
    ),
  }));
  // Forced colours can rasterise rounded ends differently on a phone. Compare
  // their exact colours and solid centres, while retaining full Light/Dark parity.
  const solidClip = {
    x: box!.x + 50,
    y: box!.y + 10,
    width: 20,
    height: box!.height - 20,
  };
  const solidLight = await page.screenshot({ clip: solidClip });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await page.screenshot({ clip });
  expect(dark.equals(light)).toBe(true);
  await page.emulateMedia({ forcedColors: "active" });
  await expect(paper).toHaveCSS("forced-color-adjust", "none");
  expect(
    await paper.evaluate((element) => ({
      paper: getComputedStyle(element).backgroundColor,
      lines: [...element.children].map(
        (line) => getComputedStyle(line).backgroundColor,
      ),
    })),
  ).toEqual(originalColours);
  expect((await page.screenshot({ clip: solidClip })).equals(solidLight)).toBe(
    true,
  );
  await page.emulateMedia({ forcedColors: "none" });
  await expect(paper).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await screenshot(page, info, "dark-fixed-paper-preview");
});

test("print-only recovery paper remains black on white in all app and contrast modes", async ({
  page,
}, info) => {
  await page.goto("/");
  // This masked print-style fixture matches the unchanged recovery portal's classes.
  // Existing RecoveryKeySetup component tests cover the actual portal/print lifecycle.
  await page.evaluate(() => {
    document.body.classList.add("printing-recovery-kit");
    const kit = document.createElement("div");
    kit.className = "recovery-kit-print";
    kit.innerHTML =
      '<h1>myCarlos recovery kit</h1><p class="recovery-kit-key">[masked]</p><p>FAKE print layout — no key displayed</p>';
    document.body.appendChild(kit);
  });
  await page.emulateMedia({
    media: "print",
    colorScheme: "dark",
    forcedColors: "active",
  });
  const kit = page.locator(".recovery-kit-print");
  await expect(kit).toBeVisible();
  await expect(kit).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(kit).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#root")).not.toBeVisible();
  await screenshot(page, info, "masked-print-paper");
  await page.emulateMedia({ colorScheme: "light", forcedColors: "none" });
  await expect(kit).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(kit).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

// Ben's review (#60): nothing stays light in dark mode. Every main panel, on
// every section, has a dark background; accents (the primary button, chips)
// are not panels and may be light.
test("dark mode has no light panels on any section", async ({ page }, info) => {
  await fakeVault(page, info.project.name === "phone" ? "ios" : "windows");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const light: string[] = [];
  for (const where of ["preferences", "security", "records"] as const) {
    await section(page, info, where);
    light.push(
      ...(await page.evaluate((where) => {
        const luminance = (colour: string) => {
          const [r, g, b, a = 1] = colour.match(/[\d.]+/g)!.map(Number);
          if (a === 0) return null;
          const [R, G, B] = [r, g, b].map((v) => {
            const c = v / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * R + 0.7152 * G + 0.0722 * B;
        };
        return Array.from(
          document.querySelectorAll<HTMLElement>(
            ".app-window, .titlebar, .sidebar, .app-body, main, .library-main, .setting-row, .filelist, .file-row, .file-head, [role=dialog], .mobile-section-picker",
          ),
        )
          .filter((panel) => panel.checkVisibility())
          .filter((panel) => {
            const value = luminance(getComputedStyle(panel).backgroundColor);
            return value !== null && value > 0.4;
          })
          .map(
            (panel) =>
              `${where}: ${panel.tagName.toLowerCase()}.${String(panel.className)} ${getComputedStyle(panel).backgroundColor}`,
          );
      }, where)),
    );
  }
  expect(light).toEqual([]);
});
