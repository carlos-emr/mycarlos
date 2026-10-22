import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Where a patient can start again (#71): only on the unlock screen, not in
// Security, because on a phone a vault set aside can be removed only with
// every other vault. The native side is faked; Rust tests cover what the
// commands do, and this covers what the screens offer.
async function fakeNative(page: Page, status: "unlocked" | "locked") {
  await page.addInitScript((status) => {
    const snapshot = {
      profiles: [
        { id: "profile", displayName: "FAKE Patient", createdAtMs: 1 },
      ],
      folders: [],
      records: [],
      recovery: null,
      recoveryKeySetAtMs: 1,
    };
    const resets: string[] = [];
    Reflect.set(window, "__FAKE_RESETS__", resets);
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (
        command: string,
        args?: { request?: { confirmation?: string } },
      ) => {
        if (command === "vault_status") return status;
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "android" };
        if (command === "vault_touch" || command === "vault_set_auto_lock")
          return;
        if (command === "vault_reset") {
          resets.push(args?.request?.confirmation ?? "");
          // The patient chose "Keep this vault" in the native dialog.
          return false;
        }
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  }, status);
}

/** The sidebar on a computer; on a phone, the section picker (a list
 * today, tabs once #75 is in). */
async function openSecurity(page: Page) {
  const picker = page.getByRole("combobox", { name: "Section" });
  const button = page.getByRole("button", { name: /^Security/ });
  // Wait for the library first: before it renders, neither is there.
  await expect(picker.or(button).first()).toBeVisible();
  if (await picker.isVisible())
    await picker.selectOption({ label: "Security" });
  else await button.first().click();
}

const scan = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

test("Security offers no way to set the vault aside", async ({
  page,
}, testInfo) => {
  await fakeNative(page, "unlocked");
  await page.goto("/");
  await openSecurity(page);
  await expect(
    page.getByRole("heading", { name: "Change passphrase" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /set vault aside/i }),
  ).toHaveCount(0);
  await expect(page.getByText("Show reset controls")).toHaveCount(0);
  await expect(page.getByLabel(/RESET MYCARLOS VAULT/)).toHaveCount(0);
  expect((await scan(page)).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("security.png"),
    fullPage: true,
  });
});

test("the unlock screen still lets a patient who forgot the passphrase start again", async ({
  page,
}, testInfo) => {
  await fakeNative(page, "locked");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Unlock your vault" }),
  ).toBeVisible();
  await page.getByText("Forgot your passphrase?").click();
  const setAside = page.getByRole("button", { name: "Set vault aside" });
  await expect(setAside).toBeDisabled();
  await page
    .getByLabel("Type RESET MYCARLOS VAULT")
    .fill("RESET MYCARLOS VAULT");
  await expect(setAside).toBeEnabled();
  expect((await scan(page)).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("unlock-start-again.png"),
    fullPage: true,
  });
  await setAside.click();
  await expect(
    page.getByText("Nothing changed: the vault was not set aside."),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "__FAKE_RESETS__")),
  ).toEqual(["RESET MYCARLOS VAULT"]);
});
