import { humanText, visibleText } from "../test/humanText";
import { virtual } from "@guidepup/virtual-screen-reader";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import type {
  AuditHistoryEntry,
  AuditHistoryView,
  VaultBridge,
  VaultRecord,
} from "../vault";
import { AuditHistory } from "./AuditHistory";
import { HiddenDocuments } from "./HiddenDocuments";
import { LibrarySidebar } from "./LibrarySidebar";
import { PersonDetailsFields } from "./PersonDetails";
import type { VaultDragDrop } from "./useVaultDragDrop";
import { UnlockVault } from "./VaultAuth";

// What a screen reader says, moving through each screen as a user would
// (a simulated reader; Ben's Narrator pass before merge still applies). The
// checks are on meaning: roles, order, state, and the key words of each
// announcement, not every word, so a wording tweak does not break them.

afterEach(async () => {
  await virtual.stop();
});

/** Everything the reader says moving through `container` once, in order. */
async function readThrough(container: HTMLElement) {
  await virtual.start({ container });
  const first = await virtual.lastSpokenPhrase();
  let wrapped = false;
  for (let step = 0; step < 400 && !wrapped; step++) {
    await virtual.next();
    // The reader wraps round to the start: then it has read everything once.
    wrapped = (await virtual.lastSpokenPhrase()) === first;
  }
  expect(wrapped, "the reader went round the whole screen").toBe(true);
  return (await virtual.spokenPhraseLog()).map(visibleText);
}

/** A pattern for one whole phrase, built from catalogue text (not from
 * memory), with any regex characters in that text taken literally. */
const phrase = (...parts: string[]) =>
  new RegExp(
    `^${parts.map((part) => visibleText(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("")}$`,
  );
const en = (
  key: Parameters<typeof translate>[1],
  args?: Parameters<typeof translate>[2],
) => translate("en", key, args);

/** Each pattern is heard, in this order (other phrases may come between). */
function expectHeardInOrder(phrases: string[], patterns: RegExp[]) {
  let from = 0;
  for (const pattern of patterns) {
    const at = phrases.findIndex(
      (phrase, index) => index >= from && pattern.test(phrase),
    );
    expect(at, `heard ${pattern} after phrase ${from}`).toBeGreaterThanOrEqual(
      0,
    );
    from = at + 1;
  }
}

describe("unlocking, as a screen reader reads it", () => {
  it("reads the page heading, then the passphrase with its length, then Unlock, and reads a refusal out", async () => {
    setLocaleOverride("en");
    const props = {
      busy: false,
      autoLockMinutes: 5,
      onUnlock: vi.fn(),
      onRecover: vi.fn(),
      restoreBridge: {
        pickRestoreSource: vi.fn().mockResolvedValue(null),
        inspectRestore: vi.fn(),
        restore: vi.fn(),
      },
      onRestored: vi.fn(),
      onReset: vi.fn(),
    };
    const { container, rerender } = render(
      <UnlockVault {...props} notice="" />,
    );
    expectHeardInOrder(await readThrough(container), [
      phrase("heading, ", en("unlock.title"), ", level 1"),
      phrase(
        en("passphrase.label"),
        ", ",
        en("secret.count.password", { count: 0 }),
      ),
      phrase("button, ", en("unlock.submit")),
      phrase("heading, ", en("unlock.noKey.heading"), ", level 2"),
    ]);

    rerender(
      <UnlockVault {...props} notice="FAKE: that passphrase did not match." />,
    );
    await vi.waitFor(async () =>
      expect((await virtual.spokenPhraseLog()).map(visibleText)).toContainEqual(
        expect.stringMatching(/^polite: .*passphrase did not match/),
      ),
    );
  });
});

describe("the record library's sidebar, as a screen reader reads it", () => {
  const drag = {
    startDrag: vi.fn(),
    dragOver: vi.fn(),
    dropInto: vi.fn(),
    dragEnd: vi.fn(),
    dragClass: (base: string) => base,
    dropClass: (base: string) => base,
  } as unknown as VaultDragDrop;
  const record = (id: string, folderIds: string[]): VaultRecord => ({
    id,
    profileId: "p1",
    folderIds,
    displayName: `FAKE ${id}.pdf`,
    sourceLabel: "Manual import — unverified",
    mediaType: "application/pdf",
    plaintextSize: 1,
    importedAtMs: 1,
    available: true,
  });

  for (const locale of ["en", "fr", "zh-TW"] as const) {
    it(`says what each count counts, after the visible name, and that Security is open while Hidden is (${locale})`, async () => {
      setLocaleOverride(locale);
      const { container } = render(
        <LibrarySidebar
          profileName="FAKE Avery"
          people={[{ id: "p1", displayName: "FAKE Avery", createdAtMs: 1 }]}
          profileId="p1"
          section="hidden"
          sharedNew={0}
          onOpenShared={vi.fn()}
          vaultTotals={{ documents: 3, folders: 1 }}
          currentFolderId={null}
          folders={[
            {
              id: "f1",
              profileId: "p1",
              parentId: null,
              name: "FAKE Results",
              createdAtMs: 1,
            },
          ]}
          records={[record("a", []), record("b", ["f1"]), record("c", ["f1"])]}
          disabled={false}
          drag={drag}
          onOpenPerson={vi.fn()}
          onOpenFolder={vi.fn()}
          onOpenSecurity={vi.fn()}
          onOpenPreferences={vi.fn()}
        />,
      );
      const tr = (key: Parameters<typeof translate>[1], count: number) =>
        visibleText(translate(locale, key, { count }));
      const heard = await readThrough(container);
      const button = (name: string) =>
        heard.find((phrase) => phrase.startsWith(`button, ${name}`));
      // The visible name first, then what the number counts.
      expect(button(translate(locale, "sidebar.myRecords"))).toContain(
        tr("sidebar.documents", 1),
      );
      expect(button("FAKE Results")).toContain(tr("sidebar.documents", 2));
      // Hidden is part of Security: Security is the current section.
      expect(button(translate(locale, "security.title"))).toMatch(
        /, current page$/,
      );
      expect(button(translate(locale, "sidebar.preferences"))).not.toMatch(
        /current/,
      );
    });
  }
});

describe("a person's details, as a screen reader reads them", () => {
  function Person() {
    const [details, setDetails] = useState({});
    const [unknown, setUnknown] = useState(false);
    return (
      <PersonDetailsFields
        details={details}
        onChange={setDetails}
        birthDateUnknown={unknown}
        onBirthDateUnknownChange={setUnknown}
      />
    );
  }

  it("says what is missing with each field, without an alert, and reads the next step politely", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const { container } = render(<Person />);
    const heard = await readThrough(container);
    // An empty form is not an error: nothing is read out as an alert...
    expect(heard.filter((phrase) => /^alert\b/.test(phrase))).toEqual([]);
    // ...but the name field says what it still needs.
    expect(heard).toContainEqual(
      expect.stringMatching(/^textbox, Full name.*full name.*required$/),
    );

    await user.type(
      screen.getByRole("textbox", { name: humanText(/Full name/) }),
      "FAKE Avery",
    );
    await vi.waitFor(async () =>
      expect((await virtual.spokenPhraseLog()).map(visibleText)).toContainEqual(
        expect.stringMatching(/^polite: .*date of birth/i),
      ),
    );
  });
});

describe("Hidden, as a screen reader reads it", () => {
  it("names each hidden document as hidden and its button by what it does", async () => {
    setLocaleOverride("en");
    const { container } = render(
      <HiddenDocuments
        records={[
          {
            id: "h",
            profileId: "p1",
            folderIds: [],
            displayName: "FAKE Old Referral.pdf",
            sourceLabel: "Manual import — unverified",
            mediaType: "application/pdf",
            plaintextSize: 512,
            importedAtMs: 1,
            available: true,
            hidden: { atMs: 2, reason: "patient" },
          },
        ]}
        folderNameById={new Map()}
        busy={false}
        readOnly={false}
        notice=""
        onRestore={vi.fn()}
      />,
    );
    expectHeardInOrder(await readThrough(container), [
      phrase("heading, ", en("interface.HiddenDocuments.hidden"), ", level 1"),
      phrase(
        "article, ",
        en("interface.hidden.record", { name: "FAKE Old Referral.pdf" }),
      ),
      phrase(
        "button, ",
        en("interface.hidden.restore", { name: "FAKE Old Referral.pdf" }),
      ),
    ]);
  });
});

describe("the history, as a screen reader reads it", () => {
  const event = (
    seq: number,
    kind: AuditHistoryEntry["event"],
  ): AuditHistoryEntry => ({
    seq,
    atMs: Date.UTC(2026, 9, 1, 12) + seq * 60_000,
    app: "FAKE 0.1.0",
    event: kind,
    name: kind === "imported" ? "FAKE Bloodwork.pdf" : null,
    oldName: null,
    from: null,
    fromTotal: null,
    to: null,
    toTotal: null,
    how: null,
    place: null,
    previousSession: null,
  });
  const view = (complete: boolean): AuditHistoryView => ({
    entries: [event(1, "created"), event(2, "imported")],
    laterEntries: [],
    complete,
    checkedUntilMs: complete ? null : Date.UTC(2026, 9, 1, 12, 2),
    checkedFromMs: null,
  });

  it("reads out what was found once it is checked, newest event first, each headed by what happened", async () => {
    setLocaleOverride("en");
    let finish!: (verified: AuditHistoryView) => void;
    const history = vi.fn(
      () => new Promise<AuditHistoryView>((done) => (finish = done)),
    );
    const { container } = render(
      <AuditHistory
        bridge={{ history } as unknown as VaultBridge}
        onBack={vi.fn()}
        onLock={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await virtual.start({ container });
    await act(async () => finish(view(true)));
    // The status line was there while checking, so its result is read out.
    await vi.waitFor(async () =>
      expect((await virtual.spokenPhraseLog()).map(visibleText)).toContainEqual(
        expect.stringMatching(
          phrase("polite: ", en("interface.history.events", { count: 2 })),
        ),
      ),
    );
    await virtual.stop();
    expectHeardInOrder(await readThrough(container), [
      phrase("heading, ", en("interface.history.title"), ", level 1"),
      phrase("heading, ", en("interface.history.event.imported"), ", level 2"),
      phrase("heading, ", en("interface.history.event.created"), ", level 2"),
    ]);
  });

  it("says when part of the history is damaged, as an alert", async () => {
    setLocaleOverride("en");
    const { container } = render(
      <AuditHistory
        bridge={
          {
            history: vi.fn().mockResolvedValue(view(false)),
          } as unknown as VaultBridge
        }
        onBack={vi.fn()}
        onLock={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByRole("alert");
    // An alert is read out as it appears (a simulated reader does not log
    // that); here it is also heard as an alert, before the events.
    expectHeardInOrder(await readThrough(container), [
      /^alert$/,
      phrase(
        en("interface.history.damaged", {
          date: new Date(Date.UTC(2026, 9, 1, 12, 2)).toLocaleString(),
        }),
      ),
      phrase("heading, ", en("interface.history.event.imported"), ", level 2"),
    ]);
  });
});
