import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VaultRecord } from "../vault";
import { HiddenDocuments } from "./HiddenDocuments";

const record = (
  id: string,
  hidden: VaultRecord["hidden"],
  extra: Partial<VaultRecord> = {},
): VaultRecord => ({
  id,
  profileId: "p1",
  folderIds: [],
  displayName: `FAKE ${id}.pdf`,
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
  hidden,
  ...extra,
});

function show(records: VaultRecord[], onRestore = vi.fn()) {
  render(
    <HiddenDocuments
      records={records}
      folderNameById={new Map([["f1", "FAKE Letters"]])}
      busy={false}
      readOnly={false}
      notice=""
      onRestore={onRestore}
    />,
  );
  return onRestore;
}

describe("HiddenDocuments (#71)", () => {
  it("lists hidden documents, newest first, with where they were and their total size", () => {
    const onRestore = show([
      record("older", { atMs: Date.UTC(2026, 9, 1, 12), reason: "patient" }),
      record(
        "newer",
        { atMs: Date.UTC(2026, 9, 9, 12), reason: "patient" },
        { folderIds: ["f1"] },
      ),
    ]);
    expect(screen.getByText("2 documents · 4 KB")).toBeVisible();
    expect(screen.getByText(/myCarlos never deletes a document/)).toBeVisible();
    const rows = screen.getAllByRole("article");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "FAKE newer.pdf, hidden",
      "FAKE older.pdf, hidden",
    ]);
    expect(within(rows[0]).getByText("FAKE Letters")).toBeVisible();
    expect(within(rows[1]).getByText("My records")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Restore FAKE older.pdf" }),
    );
    expect(onRestore).toHaveBeenCalledWith(
      expect.objectContaining({ id: "older" }),
    );
  });

  it("offers Restore for a damaged document only once its file is back", () => {
    show([
      record("lost", { atMs: 2, reason: "damaged" }, { available: false }),
      record("back", { atMs: 1, reason: "damaged" }),
    ]);
    const [lost, back] = screen.getAllByRole("article");
    expect(within(lost).getByText(/Damaged: file missing/)).toBeVisible();
    expect(within(lost).queryByRole("button")).not.toBeInTheDocument();
    expect(within(back).getByText(/Its file is back/)).toBeVisible();
    expect(
      within(back).getByRole("button", { name: "Restore FAKE back.pdf" }),
    ).toBeEnabled();
  });

  it("says when nothing is hidden", () => {
    show([]);
    expect(screen.getByText("Nothing is hidden")).toBeVisible();
    expect(screen.getByText("0 documents · 0 B")).toBeVisible();
  });
});
