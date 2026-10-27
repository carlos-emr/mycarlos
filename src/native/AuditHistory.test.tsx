import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatDate, setLocaleOverride, translate } from "../i18n";
import type { AuditHistoryEntry, VaultBridge } from "../vault";
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
function bridge(history = vi.fn().mockResolvedValue([])) {
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
    const request = pending<AuditHistoryEntry[]>();
    const shown = props(bridge(vi.fn().mockReturnValue(request.promise)));
    render(<AuditHistory {...shown} />);
    expect(
      screen.getByRole("heading", { name: "Audit history" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking and reading the complete history…",
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    await act(async () => request.resolve([]));
    expect(screen.getByText("There are no history events.")).toBeVisible();
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
      <AuditHistory {...props(bridge(vi.fn().mockResolvedValue(rows)))} />,
    );
    await screen.findByText(malicious);
    const articles = screen.getAllByRole("article");
    expect(within(articles[0]).getByRole("heading")).toHaveTextContent(
      "Document moved",
    );
    expect(within(articles[1]).getByRole("heading")).toHaveTextContent(
      "Vault created",
    );
    for (const text of [
      "FAKE previous.pdf",
      "My records",
      "FAKE Folder, 2 more folders",
      "Imported from a chosen file",
      "FAKE /exports/copy.pdf",
      "FAKE 0.1.0",
    ])
      expect(within(articles[0]).getByText(text)).toBeVisible();
    expect(
      within(articles[0]).getByText(/^Locked by you at/),
    ).toHaveTextContent(
      formatDate(1768478400000, { dateStyle: "medium", timeStyle: "short" }),
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(rows).toEqual(original);
    expect(screen.getByRole("status")).toHaveTextContent("2 events");
  });

  it.each(["fr", "pl", "pt-BR", "es"] as const)(
    "updates labels, counts and dates in %s without fetching again",
    async (locale) => {
      const shown = props(bridge(vi.fn().mockResolvedValue([entry()])));
      render(<AuditHistory {...shown} />);
      await screen.findByText("FAKE Avery");
      await act(async () => setLocaleOverride(locale));
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        translate(locale, "interface.history.title"),
      );
      expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
        translate(locale, "interface.history.event.created"),
      );
      expect(screen.getByRole("status")).toHaveTextContent(
        translate(locale, "interface.history.events", { count: 1 }),
      );
      expect(
        screen.getByText(
          formatDate(entry().atMs, { dateStyle: "medium", timeStyle: "short" }),
        ),
      ).toBeVisible();
      expect(shown.bridge.history).toHaveBeenCalledOnce();
    },
  );

  it("shows only the localized verification failure and no partial history", async () => {
    const shown = props(bridge(vi.fn().mockRejectedValue(unverified)));
    render(<AuditHistory {...shown} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The history could not be read and verified. No events are shown.",
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("/private/vault");
    await act(async () => setLocaleOverride("fr"));
    expect(alert).toHaveTextContent(
      translate("fr", "interface.history.error.unverified"),
    );
    expect(shown.onLock).not.toHaveBeenCalled();
  });

  it("locks the current session when native reports it already locked", async () => {
    const shown = props(bridge(vi.fn().mockRejectedValue({ code: "locked" })));
    render(<AuditHistory {...shown} />);
    await vi.waitFor(() => expect(shown.onLock).toHaveBeenCalledOnce());
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it.each(["success", "locked", "unverified"])(
    "ignores late %s after unmount",
    async (outcome) => {
      const request = pending<AuditHistoryEntry[]>();
      const shown = props(bridge(vi.fn().mockReturnValue(request.promise)));
      const view = render(<AuditHistory {...shown} />);
      view.unmount();
      await act(async () => {
        if (outcome === "success") request.resolve([entry()]);
        else
          request.reject(
            outcome === "locked" ? { code: "locked" } : unverified,
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
      const old = pending<AuditHistoryEntry[]>();
      const next = pending<AuditHistoryEntry[]>();
      const shown = props(bridge(vi.fn().mockReturnValue(old.promise)));
      const view = render(<AuditHistory {...shown} />);
      await act(async () => {
        if (oldResult === "rows") old.resolve([entry()]);
        else old.reject(unverified);
      });
      const nextProps = props(bridge(vi.fn().mockReturnValue(next.promise)));
      view.rerender(<AuditHistory {...nextProps} />);
      expect(screen.queryByText("FAKE Avery")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent("Checking");
      await act(async () => next.resolve([entry({ name: "FAKE Blake" })]));
      expect(screen.getByText("FAKE Blake")).toBeVisible();
      expect(nextProps.onLock).not.toHaveBeenCalled();
    },
  );

  it("ignores a previous bridge's late locked rejection after switching sessions", async () => {
    const old = pending<AuditHistoryEntry[]>();
    const shown = props(bridge(vi.fn().mockReturnValue(old.promise)));
    const view = render(<AuditHistory {...shown} />);
    const current = props(
      bridge(vi.fn().mockResolvedValue([entry({ name: "FAKE Blake" })])),
    );
    view.rerender(<AuditHistory {...current} />);
    await screen.findByText("FAKE Blake");
    await act(async () => old.reject({ code: "locked" }));
    expect(current.onLock).not.toHaveBeenCalled();
    expect(shown.onLock).not.toHaveBeenCalled();
    expect(screen.getByText("FAKE Blake")).toBeVisible();
  });
});
