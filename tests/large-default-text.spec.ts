import { expect, test, type Page } from "@playwright/test";

// #84: at twice the default text size (32px, as a browser's text setting or a
// phone's largest text gives), the vault's first screens still fit their
// window: the window hides what overflows it, so a card wider than the window
// cut off every box and the Create button on a phone.
async function openAt200(page: Page, status: "absent" | "locked") {
  await page.addInitScript((status) => {
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "vault_status") return status;
        if (command === "runtime_info") return { platform: "android" };
        if (command === "vault_restore_pick") return "FAKE-backup-pick";
        // A backup of another vault: restoring it asks the patient to agree.
        if (command === "vault_restore_inspect")
          return {
            replaces: "otherVault",
            differsFromThisDevice: false,
            documentCount: 3,
          };
        throw new Error(`Unexpected IPC command: ${command}`);
      },
    });
  }, status);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
  await page.goto("/");
  await expect(page.locator(".native-auth-window h1")).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).fontSize,
    ),
  ).toBe("32px");
}

/** Visible buttons, boxes and summaries that the window's sides cut off. */
function cutOffAtTheSides(page: Page) {
  return page.evaluate(() => {
    const window_ = document
      .querySelector(".native-auth-window")!
      .getBoundingClientRect();
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        ".native-auth-window button, .native-auth-window input, .native-auth-window summary",
      ),
    )
      .filter((control) => control.checkVisibility())
      .filter((control) => {
        const box = control.getBoundingClientRect();
        return box.left < window_.left - 1 || box.right > window_.right + 1;
      })
      .map(
        (control) =>
          `${control.tagName.toLowerCase()} "${(control.getAttribute("aria-label") ?? control.textContent ?? "").trim()}"`,
      );
  });
}

const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test("first setup fits its window at 200% default text", async ({
  page,
}, info) => {
  await openAt200(page, "absent");
  expect(await cutOffAtTheSides(page), "cut off at the window's side").toEqual(
    [],
  );
  expect(await scrollsSideways(page), "scrolls sideways").toBe(false);
  // The Create button can be reached and pressed.
  const create = page.getByRole("button", { name: "Create vault" });
  await create.scrollIntoViewIfNeeded();
  await expect(create).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("setup-200.png"),
    fullPage: true,
  });
});

test("unlocking and restoring fit their window at 200% default text, with full-size choices", async ({
  page,
}) => {
  await openAt200(page, "locked");
  expect(await cutOffAtTheSides(page), "unlock: cut off").toEqual([]);
  await page.getByText("Restore from a backup").click();
  await page.getByRole("button", { name: "Choose backup file…" }).click();
  await expect(page.getByRole("radio").first()).toBeVisible();
  await page.getByLabel("Backup passphrase").fill("FAKE backup passphrase");
  await page.getByRole("button", { name: "Check backup" }).click();
  // The agreement's tick box sits beside a long sentence.
  await expect(page.getByRole("checkbox")).toBeVisible();
  expect(await cutOffAtTheSides(page), "restore: cut off").toEqual([]);
  expect(await scrollsSideways(page), "scrolls sideways").toBe(false);
  // A tick box or radio button beside its words keeps its size: only text
  // boxes may shrink with the card.
  const squeezed = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>(
        ".vault-card input[type=radio], .vault-card input[type=checkbox]",
      ),
    )
      .filter((input) => input.checkVisibility())
      .map((input) => Math.round(input.getBoundingClientRect().width))
      .filter((width) => width < 12),
  );
  expect(squeezed, "tick boxes or radio buttons squeezed").toEqual([]);
});
