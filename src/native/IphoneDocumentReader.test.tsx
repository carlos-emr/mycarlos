import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IphoneDocumentReader } from "./IphoneDocumentReader";
import type { VaultRecord } from "../vault";

const record: VaultRecord = {
  id: "fake-record-1",
  profileId: "fake-person-1",
  folderIds: [],
  displayName: "FAKE Letter.pdf",
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 1024,
  importedAtMs: 1,
  available: true,
};

function pending() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("iPhone document reading", () => {
  it("passes only a record ID and Close label, then returns when the native reader closes", async () => {
    const native = pending();
    const read = vi.fn(() => native.promise);
    const onClose = vi.fn();
    render(
      <IphoneDocumentReader
        record={record}
        read={read}
        cancel={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: record.displayName }),
    ).toHaveAccessibleDescription(record.sourceLabel);
    await waitFor(() => expect(read).toHaveBeenCalledWith(record.id, "Close"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Opening document…");
    await act(async () => native.resolve());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "pdf_mobile_too_large",
      "This PDF is larger than 20 MB. Save a copy to read it in another app.",
    ],
    [
      "pdf_view_failed",
      "myCarlos could not show this document. Save a copy to read it in another app.",
    ],
  ])("shows a recoverable message for %s", async (code, message) => {
    render(
      <IphoneDocumentReader
        record={record}
        read={vi.fn().mockRejectedValue({ code })}
        cancel={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("cancels pending native work when closed or unmounted, ignoring a late failure", async () => {
    const native = pending();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const view = render(
      <IphoneDocumentReader
        record={record}
        read={() => native.promise}
        cancel={cancel}
        onClose={onClose}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => native.reject({ code: "pdf_view_failed" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels the old record and ignores its completion when another record replaces it", async () => {
    const first = pending();
    const second = pending();
    const read = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const cancel = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const view = render(
      <IphoneDocumentReader
        record={record}
        read={read}
        cancel={cancel}
        onClose={onClose}
      />,
    );
    view.rerender(
      <IphoneDocumentReader
        record={{ ...record, id: "fake-record-2" }}
        read={read}
        cancel={cancel}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => first.resolve());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => second.resolve());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
