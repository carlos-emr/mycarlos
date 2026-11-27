import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "./support/a11y";
import { messagePattern, translate } from "./support/fluent";
import { fakeCalls, fakeVaultWith } from "./support/vaultFake";

// The New marker: the strip "{N} new from your clinic" above the list and a New tag on a row.
// What counts as new is decided and kept natively (Rust tests); here the page's part: the strip,
// the tags, Show them, opening a document, Mark all as seen, focus and accessibility. FAKE data.

// The words as the page shows them (Fluent puts isolation marks around the number).
const fromClinic = (count: number, clinics = 1) =>
  messagePattern(
    "en",
    clinics > 1
      ? "interface.clinicNew.fromClinics"
      : "interface.clinicNew.fromClinic",
    { count },
  );

const strip = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: /new from your clinics?$/ });

test("the strip counts the new documents, tags their rows, and shows nothing about clinics by name", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", newClinicDocuments: 2 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 2, name: fromClinic(2) }),
  ).toBeVisible();
  const region = strip(page);
  await expect(region).not.toContainText("FAKE");
  await expect(
    page.getByRole("button", { name: /^FAKE Clinic note 1\.pdf ?, New$/ }),
  ).toBeVisible();
  await expect(page.locator(".new-tag")).toHaveCount(2);
  // The documents that are not new have no tag.
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toBeVisible();
});

test("it says clinics when the new documents come from more than one", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "unlocked",
    newClinicDocuments: 2,
    newFromTwoClinics: true,
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 2, name: fromClinic(2, 2) }),
  ).toBeVisible();
});

test("Show them lists only the new documents; opening one clears only that one; Show all documents comes back", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", newClinicDocuments: 3 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Show them.*3.*new from your clinic/ })
    .click();
  // The focus is where the patient was: the strip's heading.
  await expect(
    page.getByRole("heading", { level: 2, name: fromClinic(3) }),
  ).toBeFocused();
  await expect(page.getByText("Showing only the new documents.")).toBeVisible();
  await expect(page.locator(".record-open")).toHaveCount(3);
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toHaveCount(0);
  // Opening one document clears that one and only that one.
  await page
    .getByRole("button", { name: /^FAKE Clinic note 2\.pdf ?, New$/ })
    .click();
  await expect(
    page.getByRole("heading", { level: 2, name: fromClinic(2) }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_mark_seen")).toHaveLength(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show all documents" }).click();
  await expect(page.getByText("Showing only the new documents.")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "FAKE Letter.pdf", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".new-tag")).toHaveCount(2);
});

test("Mark all as seen clears everything, the strip leaves and the focus goes to the list's heading", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", newClinicDocuments: 2 });
  await page.goto("/");
  await page
    .getByRole("button", { name: /Mark all as seen.*2.*new from your clinic/ })
    .click();
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator(".new-tag")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  expect(await fakeCalls(page, "vault_mark_all_seen")).toHaveLength(1);
});

test("nothing is cleared by looking: the list, a search and a scroll leave every document new", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", newClinicDocuments: 2 });
  await page.goto("/");
  await page.mouse.wheel(0, 400);
  await page.getByRole("searchbox").fill("FAKE");
  await expect(
    page.getByRole("heading", { level: 2, name: fromClinic(2) }),
  ).toBeVisible();
  expect(await fakeCalls(page, "vault_mark_seen")).toHaveLength(0);
  expect(await fakeCalls(page, "vault_mark_all_seen")).toHaveLength(0);
});

for (const width of [1100, 320]) {
  test(`the strip and the tags pass axe at ${width}px and at 200% text, and nothing runs off the page`, async ({
    page,
  }, info) => {
    test.skip(
      info.project.name === "phone" && width > 500,
      "a wide window is measured on the desktop project",
    );
    await page.setViewportSize({ width, height: 800 });
    await fakeVaultWith(page, {
      start: "unlocked",
      newClinicDocuments: 2,
      newFromTwoClinics: true,
    });
    await page.goto("/");
    await expect(strip(page)).toBeVisible();
    await expectNoAxeViolations(page, `the New strip at ${width}px`);
    await page.locator("html").evaluate((element) => {
      element.style.fontSize = "200%";
    });
    await expect(strip(page)).toBeVisible();
    await expectNoAxeViolations(page, `the New strip at ${width}px, 200% text`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Both buttons stay reachable and as tall as a finger needs.
    for (const name of [/Show them/, /Mark all as seen/]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
    }
  });
}

test("the strip is in the language chosen, with its plural form", async ({
  page,
}) => {
  await fakeVaultWith(page, { start: "unlocked", newClinicDocuments: 5 });
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "languages", { get: () => ["pl-PL"] }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: messagePattern("pl", "interface.clinicNew.fromClinic", {
        count: 5,
      }),
    }),
  ).toBeVisible();
});
