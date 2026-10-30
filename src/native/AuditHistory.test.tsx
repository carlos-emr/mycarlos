import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import { setDeviceLocale } from "../test/deviceLocale";
import { humanText, visibleText } from "../test/humanText";
import type {
  AuditHistoryEntry,
  AuditHistoryView,
  VaultBridge,
} from "../vault";
import { ANNOUNCE_DELAY_MS } from "./announce";
import { AuditHistory } from "./AuditHistory";

const entry = (
  overrides: Partial<AuditHistoryEntry> = {},
): AuditHistoryEntry => ({
  seq: 0,
  atMs: Date.UTC(2026, 0, 15, 12),
  app: "FAKE 0.1.0",
  event: "created",
  name: "FAKE Avery",
  oldName: null,
  from: null,
  fromTotal: null,
  to: null,
  toTotal: null,
  how: null,
  place: null,
  previousSession: null,
  ...overrides,
});
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** A date as the computer writes it (D130): the language myCarlos uses does not change it. */
const shownDate = (ms: number) => new Date(ms).toLocaleString();
/** The whole text, not a part of it ("1 event", never "11 events"). */
const whole = (text: string) =>
  new RegExp(`^${visibleText(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
/** Waits that include the status line's announce delay get more room. */
const HELD = { timeout: 2000 };
const ONE_EVENT = whole(
  translate("en", "interface.history.events", { count: 1 }),
);
/** A whole history, as native code returns it when every piece checks out. */
const complete = (entries: AuditHistoryEntry[]): AuditHistoryView => ({
  entries,
  laterEntries: [],
  complete: true,
  checkedUntilMs: null,
  checkedFromMs: null,
});
function bridge(history = vi.fn().mockResolvedValue(complete([]))) {
  return { history } as unknown as VaultBridge;
}
function props(native = bridge()) {
  return {
    bridge: native,
    onBack: vi.fn(),
    onLock: vi.fn().mockResolvedValue(undefined),
  };
}
const unverified = {
  code: "history_unverified",
  message: "FAKE internal /private/vault/objects/secret",
  messageKey: "interface.history.error.unverified",
};

describe("AuditHistory verified native results", () => {
  it("focuses its heading, shows loading, then the empty result", async () => {
    const request = pending<AuditHistoryView>();
    const shown = props(bridge(vi.fn().mockReturnValue(request.promise)));
    render(<AuditHistory {...shown} />);
    expect(
      screen.getByRole("heading", { name: "Audit history" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "Checking and reading the complete history…",
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await act(async () => request.resolve(complete([])));
    // The status line says what was found, after the announce delay.
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveHumanTextContent(
          whole("There are no history events."),
        ),
      HELD,
    );
    expect(screen.getByText("There are no history events.")).toBeVisible();
    // The page's only message keeps a plain paragraph's look.
    expect(screen.getByRole("status")).not.toHaveClass("status-line");
    expect(shown.bridge.history).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Back to Security/i }));
    expect(shown.onBack).toHaveBeenCalledOnce();
  });

  it("shows newest first, with historical names and paths escaped as text", async () => {
    const malicious = '<img src=x onerror="window.FAKE_history_xss=true">';
    const rows = [
      entry(),
      entry({
        seq: 1,
        event: "moved",
        name: malicious,
        oldName: "FAKE previous.pdf",
        from: [],
        fromTotal: 0,
        to: ["FAKE Folder"],
        toTotal: 3,
        how: "picked",
        place: "FAKE /exports/copy.pdf",
        previousSession: "lockedAt:1768478400000:manual",
      }),
    ];
    const original = structuredClone(rows);
    const view = render(
      <AuditHistory
        {...props(bridge(vi.fn().mockResolvedValue(complete(rows))))}
      />,
    );
    await screen.findByText(malicious);
    const articles = screen.getAllByRole("article");
    expect(within(articles[0]).getByRole("heading")).toHaveHumanTextContent(
      "Document moved",
    );
    expect(within(articles[1]).getByRole("heading")).toHaveHumanTextContent(
      "Vault created",
    );
    for (const text of [
      "FAKE previous.pdf",
      "Top level (location not recorded)",
      "FAKE Folder, 2 more folders",
      "Imported from a chosen file",
      "FAKE /exports/copy.pdf",
      "FAKE 0.1.0",
    ])
      expect(within(articles[0]).getByText(humanText(text))).toBeVisible();
    expect(
      within(articles[0]).getByText(/^Locked by you at/),
    ).toHaveHumanTextContent(shownDate(1768478400000));
    expect(view.container.querySelector("img")).toBeNull();
    expect(rows).toEqual(original);
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveHumanTextContent(
          whole("2 events"),
        ),
      HELD,
    );
  });

  it.each(["fr", "pl", "pt-BR", "es"] as const)(
    "updates labels, counts and dates in %s without fetching again",
    async (locale) => {
      const shown = props(
        bridge(vi.fn().mockResolvedValue(complete([entry()]))),
      );
      render(<AuditHistory {...shown} />);
      await screen.findByText("FAKE Avery");
      await act(async () => setLocaleOverride(locale));
      expect(screen.getByRole("heading", { level: 1 })).toHaveHumanTextContent(
        translate(locale, "interface.history.title"),
      );
      expect(screen.getByRole("heading", { level: 2 })).toHaveHumanTextContent(
        translate(locale, "interface.history.event.created"),
      );
      await waitFor(
        () =>
          expect(screen.getByRole("status")).toHaveHumanTextContent(
            whole(translate(locale, "interface.history.events", { count: 1 })),
          ),
        HELD,
      );
      expect(screen.getByText(shownDate(entry().atMs))).toBeVisible();
      expect(shown.bridge.history).toHaveBeenCalledOnce();
    },
  );

  it("holds what was found until a screen reader has taken in the status line", async () => {
    vi.useFakeTimers();
    try {
      render(
        <AuditHistory
          {...props(bridge(vi.fn().mockResolvedValue(complete([entry()]))))}
        />,
      );
      // The result arrives at once: the list shows, the status still checks.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("FAKE Avery")).toBeVisible();
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        "Checking and reading the complete history…",
      );
      await act(async () => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
      expect(screen.getByRole("status")).toHaveHumanTextContent(ONE_EVENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads out a result that arrives after that at once", async () => {
    vi.useFakeTimers();
    try {
      const request = pending<AuditHistoryView>();
      render(
        <AuditHistory
          {...props(bridge(vi.fn().mockReturnValue(request.promise)))}
        />,
      );
      await act(async () => vi.advanceTimersByTime(ANNOUNCE_DELAY_MS));
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        "Checking and reading the complete history…",
      );
      await act(async () => request.resolve(complete([entry()])));
      expect(screen.getByRole("status")).toHaveHumanTextContent(ONE_EVENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows only the localized verification failure and no partial history", async () => {
    const shown = props(bridge(vi.fn().mockRejectedValue(unverified)));
    render(<AuditHistory {...shown} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveHumanTextContent(
      "The history could not be read and verified. No events are shown.",
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("status").getBoundingClientRect().height).toBe(0);
    expect(document.body).not.toHaveHumanTextContent("/private/vault");
    await act(async () => setLocaleOverride("fr"));
    expect(alert).toHaveHumanTextContent(
      translate("fr", "interface.history.error.unverified"),
    );
    expect(shown.onLock).not.toHaveBeenCalled();
  });

  it.each(["locked", "cancelled"])(
    "confirms the current native session after %s without claiming it already locked",
    async (code) => {
      const shown = props(bridge(vi.fn().mockRejectedValue({ code })));
      render(<AuditHistory {...shown} />);
      await vi.waitFor(() => expect(shown.onLock).toHaveBeenCalledOnce());
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    },
  );

  it.each(["success", "locked", "cancelled", "unverified"])(
    "ignores late %s after unmount",
    async (outcome) => {
      const request = pending<AuditHistoryView>();
      const shown = props(bridge(vi.fn().mockReturnValue(request.promise)));
      const view = render(<AuditHistory {...shown} />);
      view.unmount();
      await act(async () => {
        if (outcome === "success") request.resolve(complete([entry()]));
        else
          request.reject(
            outcome === "unverified" ? unverified : { code: outcome },
          );
      });
      expect(shown.onLock).not.toHaveBeenCalled();
      expect(screen.queryByText("FAKE Avery")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each(["rows", "error"])(
    "clears old %s when the bridge changes and ignores the old request",
    async (oldResult) => {
      const old = pending<AuditHistoryView>();
      const next = pending<AuditHistoryView>();
      const shown = props(bridge(vi.fn().mockReturnValue(old.promise)));
      const view = render(<AuditHistory {...shown} />);
      await act(async () => {
        if (oldResult === "rows") old.resolve(complete([entry()]));
        else old.reject(unverified);
      });
      // The first session's count has been read out before the switch.
      if (oldResult === "rows")
        await waitFor(
          () =>
            expect(screen.getByRole("status")).toHaveHumanTextContent(
              ONE_EVENT,
            ),
          HELD,
        );
      const nextProps = props(bridge(vi.fn().mockReturnValue(next.promise)));
      view.rerender(<AuditHistory {...nextProps} />);
      expect(screen.queryByText("FAKE Avery")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveHumanTextContent("Checking");
      await act(async () =>
        next.resolve(complete([entry({ name: "FAKE Blake" })])),
      );
      expect(screen.getByText("FAKE Blake")).toBeVisible();
      // The status line is long in place by now: the new count shows at once.
      if (oldResult === "rows")
        expect(screen.getByRole("status")).toHaveHumanTextContent(ONE_EVENT);
      expect(nextProps.onLock).not.toHaveBeenCalled();
    },
  );

  it.each(["locked", "cancelled"])(
    "ignores a previous bridge's late %s rejection after switching sessions",
    async (code) => {
      const old = pending<AuditHistoryView>();
      const shown = props(bridge(vi.fn().mockReturnValue(old.promise)));
      const view = render(<AuditHistory {...shown} />);
      const current = props(
        bridge(
          vi.fn().mockResolvedValue(complete([entry({ name: "FAKE Blake" })])),
        ),
      );
      view.rerender(<AuditHistory {...current} />);
      await screen.findByText("FAKE Blake");
      await act(async () => old.reject({ code }));
      expect(current.onLock).not.toHaveBeenCalled();
      expect(shown.onLock).not.toHaveBeenCalled();
      expect(screen.getByText("FAKE Blake")).toBeVisible();
    },
  );
});

/** A history native code could check only up to a damaged or missing piece (D129), and after
 * it as far as the pinned end proves (D146). */
const damaged = (
  entries: AuditHistoryEntry[],
  laterEntries: AuditHistoryEntry[] = [],
): AuditHistoryView => ({
  entries,
  laterEntries,
  complete: false,
  checkedUntilMs: entries.at(-1)?.atMs ?? null,
  checkedFromMs: laterEntries[0]?.atMs ?? null,
});
describe("AuditHistory dates keep the computer's format (D130)", () => {
  // Ben's D130: a Canadian computer's date and time, whatever language myCarlos uses.
  const atMs = Date.UTC(2026, 8, 30, 14, 31);
  const canadian = (ms: number) => new Date(ms).toLocaleString("en-CA");
  const french = (ms: number) =>
    new Intl.DateTimeFormat("fr", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms);

  it("shows each event's date as the computer writes it", async () => {
    setDeviceLocale("en-CA");
    render(
      <AuditHistory
        {...props(
          bridge(vi.fn().mockResolvedValue(complete([entry({ atMs })]))),
        )}
      />,
    );
    await screen.findByText("FAKE Avery");
    await act(async () => setLocaleOverride("fr"));
    expect(screen.getByText(canadian(atMs))).toBeVisible();
    expect(screen.queryByText(french(atMs))).not.toBeInTheDocument();
  });

  it("dates the damage notice as the computer writes it", async () => {
    setDeviceLocale("en-CA");
    const later = Date.UTC(2026, 9, 2, 8, 5);
    render(
      <AuditHistory
        {...props(
          bridge(
            vi
              .fn()
              .mockResolvedValue(
                damaged([entry({ atMs })], [entry({ seq: 9, atMs: later })]),
              ),
          ),
        )}
      />,
    );
    const alert = await screen.findByRole("alert");
    await act(async () => setLocaleOverride("fr"));
    expect(alert).toHaveHumanTextContent(
      translate("fr", "interface.history.damagedBetween", {
        from: canadian(atMs),
        to: canadian(later),
      }),
    );
    expect(alert).not.toHaveHumanTextContent(french(atMs));
  });
});

describe("AuditHistory damaged history (D129)", () => {
  it("shows the entries that check out, newest first, under a dated warning", async () => {
    const rows = [
      entry(),
      entry({ seq: 1, event: "unlocked", atMs: Date.UTC(2026, 1, 3, 9) }),
    ];
    render(
      <AuditHistory
        {...props(bridge(vi.fn().mockResolvedValue(damaged(rows))))}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveHumanTextContent(
      `Part of this history is damaged. Events after ${shownDate(rows[1].atMs)} can't be checked and aren't shown.`,
    );
    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(2);
    expect(within(articles[0]).getByRole("heading")).toHaveHumanTextContent(
      "Vault opened",
    );
    expect(
      screen.queryByText("Events here can't be checked and aren't shown."),
    ).not.toBeInTheDocument();
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveHumanTextContent(
          whole("2 events"),
        ),
      HELD,
    );
    // The warning comes first: before the count, and before the list.
    for (const after of [screen.getByRole("status"), screen.getByRole("list")])
      expect(
        alert.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    await act(async () => setLocaleOverride("fr"));
    expect(alert).toHaveHumanTextContent(
      translate("fr", "interface.history.damaged", {
        date: shownDate(rows[1].atMs),
      }),
    );
  });

  it("shows both checked ends around the gap, dated from each side (D146)", async () => {
    const early = [
      entry(),
      entry({ seq: 1, event: "unlocked", atMs: Date.UTC(2026, 1, 3, 9) }),
    ];
    const later = [
      entry({ seq: 7, event: "imported", atMs: Date.UTC(2026, 2, 1, 10) }),
      entry({ seq: 8, event: "renamed", atMs: Date.UTC(2026, 2, 2, 11) }),
    ];
    render(
      <AuditHistory
        {...props(bridge(vi.fn().mockResolvedValue(damaged(early, later))))}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveHumanTextContent(
      `Part of this history is damaged. Events between ${shownDate(early[1].atMs)} and ${shownDate(later[0].atMs)} can't be checked and aren't shown.`,
    );
    // Newest first: the later end, the gap, then the start.
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(
      items.map(
        (item) =>
          within(item).queryByRole("heading")?.textContent ?? item.textContent,
      ),
    ).toEqual([
      "Document renamed",
      "Document added",
      "Events here can't be checked and aren't shown.",
      "Vault opened",
      "Vault created",
    ]);
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveHumanTextContent(
          whole("4 events"),
        ),
      HELD,
    );
    await act(async () => setLocaleOverride("pl"));
    expect(alert).toHaveHumanTextContent(
      translate("pl", "interface.history.damagedBetween", {
        from: shownDate(early[1].atMs),
        to: shownDate(later[0].atMs),
      }),
    );
  });

  it("shows only what the pinned end proves when the start is damaged (D146)", async () => {
    const later = [
      entry({ seq: 5, event: "imported", atMs: Date.UTC(2026, 2, 1, 10) }),
    ];
    render(
      <AuditHistory
        {...props(bridge(vi.fn().mockResolvedValue(damaged([], later))))}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      `Part of this history is damaged. Events before ${shownDate(later[0].atMs)} can't be checked and aren't shown.`,
    );
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(
      screen.queryByText("Events here can't be checked and aren't shown."),
    ).not.toBeInTheDocument();
  });

  it("dates the notice from native fields only, never from the rows (D146)", async () => {
    render(
      <AuditHistory
        {...props(
          bridge(
            vi.fn().mockResolvedValue({
              entries: [entry()],
              laterEntries: [entry({ seq: 5, event: "imported" })],
              complete: false,
              checkedUntilMs: null,
              checkedFromMs: null,
            }),
          ),
        )}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "Part of this history is damaged. Its events can't be checked, so none are shown.",
    );
  });

  it("shows nothing but the warning when no entry checks out", async () => {
    render(
      <AuditHistory
        {...props(bridge(vi.fn().mockResolvedValue(damaged([]))))}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "Part of this history is damaged. Its events can't be checked, so none are shown.",
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    // The status line is empty at once, not "checking" or "no events", and
    // takes no room.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("status").getBoundingClientRect().height).toBe(0);
    expect(
      screen.queryByText("There are no history events."),
    ).not.toBeInTheDocument();
  });

  it.each([[[]], [[entry()]]])(
    "shows no warning for a complete history (%#)",
    async (rows) => {
      render(
        <AuditHistory
          {...props(bridge(vi.fn().mockResolvedValue(complete(rows))))}
        />,
      );
      await screen.findByText(
        rows.length ? "FAKE Avery" : "There are no history events.",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("follows the native result, never the rows, for the warning", async () => {
    // A complete history is trusted as complete even if native also sent a date.
    const view = render(
      <AuditHistory
        {...props(
          bridge(
            vi.fn().mockResolvedValue({
              entries: [entry()],
              laterEntries: [],
              complete: true,
              checkedUntilMs: entry().atMs,
              checkedFromMs: entry().atMs,
            }),
          ),
        )}
      />,
    );
    await screen.findByText("FAKE Avery");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount();
    // An incomplete history warns even when it looks whole to the screen.
    render(
      <AuditHistory
        {...props(bridge(vi.fn().mockResolvedValue(damaged([entry()]))))}
      />,
    );
    await screen.findByText("FAKE Avery");
    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      shownDate(entry().atMs),
    );
  });
});

describe("AuditHistory recorded semantics", () => {
  it.each(["en", "fr", "es", "pl", "pt-BR"] as const)(
    "keeps app/end/unknown-session facts and emitted methods in %s",
    async (locale) => {
      setLocaleOverride(locale);
      const rows = [
        entry({
          event: "unlocked",
          previousSession: "lockedAt:1768478400000:app;notRecorded",
        }),
        entry({ seq: 1, event: "imported", how: "camera" }),
        entry({ seq: 2, event: "imported", how: "shared" }),
        entry({ seq: 3, event: "moved", how: "shared", from: [], to: [] }),
        entry({ seq: 4, event: "backupRestored", how: "replaced" }),
        entry({ seq: 5, event: "moved", from: ["FAKE Folder"], fromTotal: 2 }),
      ];
      render(
        <AuditHistory
          {...props(bridge(vi.fn().mockResolvedValue(complete(rows))))}
        />,
      );
      await screen.findByText(
        translate(locale, "interface.history.how.camera"),
      );
      for (const key of [
        "interface.history.how.importedShared",
        "interface.history.how.movedFromShared",
        "interface.history.how.replaced",
        "interface.history.personRootFolder",
        "interface.history.scopeNote",
      ] as const)
        expect(screen.getByText(translate(locale, key))).toBeVisible();
      const session = screen.getByText((text) =>
        text.includes(
          translate(locale, "interface.history.laterSessionNotRecorded"),
        ),
      );
      expect(session).toHaveHumanTextContent(
        translate(locale, "interface.history.sessionLockedByApp", {
          date: shownDate(1768478400000),
        }),
      );
      expect(
        screen.getByText(
          `FAKE Folder, ${translate(locale, "interface.history.moreFolders", { count: 1 })}`,
        ),
      ).toBeVisible();
      expect(
        screen.queryByText("camera", { exact: true }),
      ).not.toBeInTheDocument();
    },
  );
});
