import { expect, test } from "@playwright/test";
import { expectOnlyFakedCommands } from "./support/a11y";
import { translate } from "./support/fluent";
import {
  FAKE_IDS,
  fakeUuid,
  FAKE_PASSPHRASE,
  fakeCalls,
  fakeSnapshot,
  fakeVaultWith,
  sidebar,
} from "./support/vaultFake";

// Files another app shared to myCarlos (#61): they wait while the vault is
// locked, the unlock screen says so, unlocking adds the PDFs to Shared with
// me and says what was not added, and a shared document whose name and birth
// date match a person is offered to that person and moved there. The native
// side is faked (support/vaultFake.ts).

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => translate("en", key, params);

test.beforeEach(({}, testInfo) => {
  test.skip(
    testInfo.project.name === "phone",
    "these flows are checked on the desktop project only; the vault screens' phone layout is covered by large-text-accessibility.spec.ts",
  );
});

const SHARED_LETTER = "FAKE Shared letter.pdf";
const NOT_PDF = "FAKE notes.txt";
const CHILD = "FAKE Child";

test("shared files wait for the unlock, the PDFs go into Shared with me, a non-PDF is named, and a document that looks like a person's is moved to them on the suggestion", async ({
  page,
}) => {
  await fakeVaultWith(page, {
    start: "locked",
    received: [SHARED_LETTER, NOT_PDF],
    people: [
      {
        displayName: CHILD,
        fullName: "FAKE Child Example",
        birthDate: "2015-06-07",
      },
    ],
    identities: {
      [SHARED_LETTER]: { name: "FAKE Child Example", birthDate: "2015-06-07" },
    },
  });
  await page.goto("/");

  // Locked: the unlock screen says what is waiting, and where it will go.
  await expect(
    page.getByText(
      en("unlock.waiting", {
        count: 2,
        folder: en("interface.LibrarySidebar.sharedWithMe"),
      }),
      { exact: true },
    ),
  ).toBeVisible();
  expect(await fakeCalls(page, "received_accept")).toEqual([]);

  // Unlocked: the files are added at once; the one that is not a PDF is
  // named and forgotten.
  await page
    .getByLabel(en("passphrase.label"), { exact: true })
    .fill(FAKE_PASSPHRASE);
  await page.getByRole("button", { name: en("unlock.submit") }).click();
  // Two people, so the heading is the patient's name, not "My records".
  await expect(
    page.getByRole("heading", { name: "FAKE Patient", level: 1 }),
  ).toBeVisible();
  // The non-PDF was named in a notice the unlock notice then replaced (its
  // wording is covered by the vault's unit tests); what matters here is that
  // only the PDF went in, into Shared with me.
  expect(await fakeCalls(page, "received_accept")).toHaveLength(1);
  const kept = (await fakeSnapshot(page)).records;
  expect(kept.some((record) => record.displayName === NOT_PDF)).toBe(false);
  expect(
    kept.find((record) => record.displayName === SHARED_LETTER)?.profileId,
  ).toBe(FAKE_IDS.shared);

  // Shared with me lists it, with the suggestion that it is the child's.
  // Said, and the sidebar entry counts it as new (its name carries
  // isolation marks, so no anchor).
  await expect(
    page.getByText(en("interface.notice.sharedAdded", { count: 1 }), {
      exact: true,
    }),
  ).toBeVisible();
  const shared = page.getByRole("button", {
    name: new RegExp(en("interface.LibrarySidebar.sharedWithMe")),
  });
  await expect(shared).toContainText(en("interface.count.new", { count: 1 }));
  await shared.click();
  await expect(
    page.getByRole("heading", {
      name: en("interface.LibrarySidebar.sharedWithMe"),
      level: 1,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: SHARED_LETTER, exact: true }),
  ).toBeVisible();
  // The suggestion is offered in the document's details (the grid view
  // leaves the list alone until a document is opened).
  await page.getByRole("button", { name: SHARED_LETTER, exact: true }).click();
  const details = page.getByRole("dialog", {
    name: SHARED_LETTER,
    exact: true,
  });
  await expect(details).toBeVisible();
  const suggestion = details.getByRole("group", {
    name: en("personSuggestion.for", { document: SHARED_LETTER }),
    exact: true,
  });
  await expect(suggestion).toContainText(
    en("personSuggestion.offer", {
      name: CHILD,
      why: en("personSuggestion.byDate"),
    }),
  );
  await suggestion
    .getByRole("button", {
      name: en("personSuggestion.moveLabel", {
        document: SHARED_LETTER,
        name: CHILD,
      }),
      exact: true,
    })
    .click();
  await expect(
    page.getByText(
      en("interface.notice.movedNamed", {
        name: SHARED_LETTER,
        where: en("interface.person.records", { name: CHILD }),
      }),
      { exact: true },
    ),
  ).toBeVisible();
  const moves = await fakeCalls(page, "vault_move_to_person");
  expect(moves).toHaveLength(1);
  expect(moves[0].request).toMatchObject({ profileId: fakeUuid(501) });
  await expect(
    page.getByRole("button", { name: SHARED_LETTER, exact: true }),
  ).toHaveCount(0);

  // Under the child's records now.
  await sidebar(page)
    .getByRole("button", { name: new RegExp(`^${CHILD}\\b`) })
    .click();
  await expect(
    page.getByRole("heading", { name: CHILD, level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: SHARED_LETTER, exact: true }),
  ).toBeVisible();
  await expectOnlyFakedCommands(page);
});
