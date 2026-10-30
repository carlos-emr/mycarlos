import { expect, test, type Page } from "@playwright/test";

// #72 part B: the AI helper's preview, walked with the keyboard at 200%
// text. Everything native is a stub: the text comes from the stub, and the
// save hands the stub the preview's text, which must hold none of the
// identifying details. FAKE data only.

interface SaveCall {
  command: string;
  args: unknown;
}

async function fakeVault(page: Page) {
  await page.addInitScript(() => {
    const snapshot = {
      profiles: [
        {
          id: "p1",
          displayName: "FAKE Avery",
          createdAtMs: 1,
          fullName: "Avery Example",
          birthDate: "1961-04-17",
        },
      ],
      folders: [],
      records: [
        {
          id: "r1",
          profileId: "p1",
          folderIds: [],
          displayName: "FAKE Clinic letter.pdf",
          sourceLabel: "Manual import — unverified",
          mediaType: "application/pdf",
          plaintextSize: 96256,
          importedAtMs: 1760000000000,
          available: true,
        },
      ],
      recovery: null,
      recoveryKeySetAtMs: 1,
      sharedProfileId: "shared",
      portalLinkingEnabled: false,
      portalLinks: [],
    };
    const pages = [
      {
        index: 0,
        text: "Patient: Avery Example\nDOB: 1961-04-17\nSeen 2026-10-08 by Dr. Ward for chest pain.\nRamipril 5 mg daily.",
      },
    ];
    const calls: SaveCall[] = [];
    Reflect.set(window, "__FAKE_CALLS__", calls);
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string, args?: unknown) => {
        calls.push({ command, args });
        if (command === "vault_status") return "unlocked";
        if (command === "vault_snapshot") return structuredClone(snapshot);
        if (command === "runtime_info") return { platform: "linux" };
        if (command === "vault_document_text")
          return {
            pageCount: 1,
            pages,
            joined: pages[0].text,
            pageStarts: [0],
            emptyPages: [],
            cutPages: [],
            failedPages: [],
            truncated: false,
            ticket: "FAKE-ticket",
          };
        if (command === "vault_record_known_details")
          return {
            names: [],
            birthDates: [],
            doctorNames: [],
            clinicNames: [],
          };
        if (command === "vault_export_text_pick") return "FAKE-pick";
        if (command === "vault_export_text_picked")
          return { saved: true, hits: [] };
        return undefined;
      },
    });
  });
}

test("prepares a document's text for an AI with the keyboard, at 200% text", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "computers only, like the reader");
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: { width: 1000, height: 800 },
  });
  try {
    const page = await context.newPage();
    await fakeVault(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: 32 } });
    await page.goto("/");
    const record = page.getByRole("button", {
      name: "FAKE Clinic letter.pdf",
      exact: true,
    });
    await expect(record).toBeVisible();
    await record.focus();
    await page.keyboard.press("Enter");
    const action = page.getByRole("button", {
      name: "Prepare text for an AI…",
    });
    await expect(action).toBeVisible();
    await action.focus();
    await page.keyboard.press("Enter");

    // The notice comes first, once per session: its button has the focus.
    const notice = page.getByRole("dialog", { name: "About the AI helper" });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Removing details is never perfect");
    await expect(
      notice.getByRole("button", { name: "Continue" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(notice).toBeHidden();

    const preview = page.getByRole("dialog", {
      name: "Text with identifying details removed",
    });
    await expect(preview).toBeVisible();
    const region = preview.getByRole("region", {
      name: "The text that will be saved",
    });
    await expect(region).toContainText("Patient: [NAME 1]");
    await expect(region).not.toContainText("Avery");
    await expect(region).not.toContainText("1961");
    // The marks name themselves for a screen reader.
    // Fluent isolates the kind with invisible marks, so the match is loose.
    await expect(region.locator("mark").first()).toContainText(
      /\(removed: .?name.?\)/,
    );
    // Nothing reaches the window's edge at 200% text.
    const overflow = await preview.evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      return box.right > window.innerWidth + 1 || box.left < -1;
    });
    expect(overflow).toBe(false);

    // Close takes the first focus; Tab reaches every control, ending at Save.
    await expect(preview.getByRole("button", { name: "Close" })).toBeFocused();
    const save = preview.getByRole("button", { name: "Save the text…" });
    for (let presses = 0; presses < 12; presses += 1) {
      if (await save.evaluate((button) => button === document.activeElement))
        break;
      await page.keyboard.press("Tab");
    }
    await expect(save).toBeFocused();
    await page.keyboard.press("Enter");
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Anyone who opens it can read it.");
    await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      confirm.getByRole("button", { name: "Save the text…" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(preview.getByRole("status")).toContainText(
      "The text was saved.",
    );

    const saved = await page.evaluate(() => {
      const calls = Reflect.get(window, "__FAKE_CALLS__") as SaveCall[];
      const picked = calls.find(
        (call) => call.command === "vault_export_text_picked",
      );
      const pick = calls.find(
        (call) => call.command === "vault_export_text_pick",
      );
      return {
        picked: picked?.args,
        pick: pick?.args,
        order: calls.map((c) => c.command),
      };
    });
    const request = (
      saved.picked as {
        request: { text: string; ticket: string; pickId: string };
      }
    ).request;
    expect(request.ticket).toBe("FAKE-ticket");
    expect(request.pickId).toBe("FAKE-pick");
    expect(request.text).not.toMatch(/Avery|Example|1961/);
    expect(request.text).toContain("Ramipril 5 mg daily.");
    // The read came before the pick, and the pick before the write.
    const order = saved.order;
    expect(order.indexOf("vault_document_text")).toBeLessThan(
      order.indexOf("vault_export_text_pick"),
    );
    expect(order.indexOf("vault_export_text_pick")).toBeLessThan(
      order.indexOf("vault_export_text_picked"),
    );
    // Escape closes the preview and stops any read.
    await page.keyboard.press("Escape");
    await expect(preview).toBeHidden();
    const cancelled = await page.evaluate(() =>
      (Reflect.get(window, "__FAKE_CALLS__") as SaveCall[]).some(
        (call) => call.command === "vault_document_text_cancel",
      ),
    );
    expect(cancelled).toBe(true);
  } finally {
    await context.close();
  }
});
