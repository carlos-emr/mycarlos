import { expect, test, type Page } from "@playwright/test";
import {
  expectAnnounced,
  expectOnlyFakedCommands,
  fakeVault,
  recordAnnouncements,
  screenReaderSmoke,
} from "./support/a11y";

// The main flows as a screen reader meets them (Ben, 28 Oct): the browser's
// accessibility tree for each screen (toMatchAriaSnapshot, which also allows
// for nodes a template leaves out), the state a reader announces, and what
// live regions read out. The templates check meaning (roles, order, names'
// key words), not every word. Templates take no regex flags, and a name
// built from text may carry invisible bidi marks around a placeholder (the
// ".?" in the patterns). screenReaderSmoke adds axe, a name for every
// control, visible words leading each name (WCAG 2.5.3) and heading order.
//
// Clinic code and the history view are not on this branch yet; they get the
// same checks when they are.

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "the vault screens' phone layout is checked by large-text-accessibility.spec.ts",
  );
});

async function unlocked(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "My records" })).toBeVisible();
}

async function openSection(page: Page, name: string) {
  const button = page
    .getByRole("navigation", { name: "Record library" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });
  await button.click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  // The open section is the current one for a screen reader, not just shown.
  await expect(button).toHaveAttribute("aria-current", "page");
}

test("the library: the sidebar says what it counts, controls lead with their visible words", async ({
  page,
}) => {
  await fakeVault(page, "unlocked");
  await unlocked(page);
  const nav = page.getByRole("navigation", { name: "Record library" });
  await expect(nav).toMatchAriaSnapshot(`
    - navigation "Record library":
      - button /^My records .?1.? document$/
      - button /^FAKE Letters .?0.? documents$/
      - button /^FAKE Results .?1.? document$/
      - button "Shared with me"
      - button "Security"
      - button "Preferences"
      - button /^Hidden .?0.? documents$/
  `);
  await expect(
    nav.getByRole("button", { name: /^My records/ }),
  ).toHaveAttribute("aria-current", "page");

  // "New" is named by what it shows; what it does is its description.
  const newButton = page.getByRole("button", { name: "New", exact: true });
  await expect(newButton).toHaveAccessibleDescription(/import/i);

  // A folder is named first by its name, then says it opens; the count is
  // its description. The same in the list and in the grid.
  for (const view of ["List view", "Grid view"]) {
    await page.getByRole("button", { name: view }).click();
    const folder = page.getByRole("button", {
      name: /^.?FAKE Results.?, open folder$/,
    });
    await expect(folder).toBeVisible();
    await expect(folder).toHaveAccessibleDescription(/\b1\b.*item/);
  }
  await screenReaderSmoke(page, "library");
  await expectOnlyFakedCommands(page);
});

test("Security: clinic documents, profiles and the open section are named and read out", async ({
  page,
}) => {
  await fakeVault(page, "unlocked", { portal: "none" });
  await recordAnnouncements(page);
  await unlocked(page);
  await openSection(page, "Security");

  const clinic = page.getByRole("region", { name: "Clinic documents" });
  await expect(clinic).toMatchAriaSnapshot(`
    - region "Clinic documents":
      - heading "Clinic documents" [level=2]
      - textbox "Portal HTTPS address"
      - textbox "Linking code"
      - textbox "Name for this device"
      - combobox "Whose records"
      - button "Link to clinic"
  `);

  // An empty profile form is not an error: no alert on arrival, but each field
  // says what it still needs, and the next step is read out as it changes.
  const main = page.getByRole("main");
  await expect(main.getByRole("alert")).toHaveCount(0);
  const fullName = main.getByRole("textbox", {
    name: "Full name, as on clinic documents",
  });
  await expect(fullName).toHaveAccessibleDescription(/full name/i);
  await fullName.fill("FAKE Avery Example");
  await expectAnnounced(page, "Enter a date of birth");

  // Linking: the clinic's card names its device code, the fingerprint to
  // compare, and what to press next.
  await clinic
    .getByRole("textbox", { name: "Portal HTTPS address" })
    .fill("https://portal.fake-clinic.example/patient");
  await clinic.getByRole("textbox", { name: "Linking code" }).fill("FAKE-CODE");
  await clinic.getByRole("button", { name: "Link to clinic" }).click();
  await expect(clinic).toMatchAriaSnapshot(`
    - region "Clinic documents":
      - heading "FAKE Family Clinic" [level=3]
      - paragraph: /[Aa]pproval/
      - textbox "Device code"
      - button "Copy device code"
      - textbox "Full device fingerprint"
      - button "Request clinic approval"
      - button "Check for new documents"
  `);
  await screenReaderSmoke(page, "Security with a linked clinic");
  await expectOnlyFakedCommands(page);
});

test("Security: a clinic waiting to approve this device says so", async ({
  page,
}) => {
  await fakeVault(page, "unlocked", { portal: "awaiting" });
  await unlocked(page);
  await openSection(page, "Security");
  const clinic = page.getByRole("region", { name: "Clinic documents" });
  await expect(clinic).toMatchAriaSnapshot(`
    - region "Clinic documents":
      - heading "FAKE Family Clinic" [level=3]
      - paragraph: /Approval request/
      - button "Check for new documents"
  `);
  await expect(
    clinic.getByRole("button", { name: "Check for new documents" }),
  ).toBeEnabled();
  await screenReaderSmoke(page, "Security, approval awaited");
  await expectOnlyFakedCommands(page);
});

test("Hidden: each document says it is hidden, Restore says what, and restoring is read out", async ({
  page,
}) => {
  await fakeVault(page, "unlocked", { hiddenDocument: true });
  await recordAnnouncements(page);
  await unlocked(page);
  await openSection(page, "Hidden");
  const main = page.getByRole("main");
  await expect(main).toMatchAriaSnapshot(`
    - main:
      - heading "Hidden" [level=1]
      - article /FAKE Old Referral\\.pdf.?, hidden/:
        - button /^Restore .?FAKE Old Referral\\.pdf.?$/
  `);
  await screenReaderSmoke(page, "Hidden");
  await main
    .getByRole("button", { name: /^Restore .?FAKE Old Referral\.pdf/ })
    .click();
  await expectAnnounced(page, "restored");
  await expectOnlyFakedCommands(page);
});
