import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AndroidDocumentReader } from "./AndroidDocumentReader";
import type { VaultRecord } from "../vault";

// Android shows a stored PDF in a native PdfRenderer window (#358). This component owns only the
// pending open and its cancellation. FAKE documents only.

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

describe("Android document reading", () => {
  it("passes a record ID and the reader's words, then returns when the native reader closes", async () => {
    const native = pending();
    const read = vi.fn(() => native.promise);
    const onClose = vi.fn();
    render(
      <AndroidDocumentReader
        record={record}
        read={read}
        cancel={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByRole("dialog", { name: record.displayName }),
    ).toHaveAccessibleDescription("Unverified Manual import");
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const [recordId, labels] = read.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
    ];
    expect(recordId).toBe(record.id);
    // The words the native window shows and speaks, with the page numbers left for it to fill in.
    expect(labels.close).toBe("Close");
    expect(labels.previous).toBe("Previous page");
    expect(labels.next).toBe("Next page");
    expect(labels.zoomIn).toBe("Zoom in");
    expect(labels.zoomOut).toBe("Zoom out");
    expect(labels.page.replace(/[⁨⁩]/g, "")).toBe(
      "Page {page} of {total}, picture of the letter",
    );
    expect(labels.pageStatus.replace(/[⁨⁩]/g, "")).toBe(
      "Page {page} of {total}",
    );
    expect(labels.pageFailed.replace(/[⁨⁩]/g, "")).toBe(
      "Page {page} of {total} cannot be shown.",
    );
    // No document bytes and no picture in this component.
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
      "pdf_view_unavailable",
      "This device does not let myCarlos open documents here. Save a copy to read it in another app.",
    ],
    [
      "pdf_view_failed",
      "myCarlos could not show this document. Save a copy to read it in another app.",
    ],
  ])("shows a recoverable message for %s", async (code, message) => {
    render(
      <AndroidDocumentReader
        record={record}
        read={vi.fn().mockRejectedValue({ code })}
        cancel={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it("closes without a message when the native open was cancelled", async () => {
    const onClose = vi.fn();
    render(
      <AndroidDocumentReader
        record={record}
        read={vi.fn().mockRejectedValue({ code: "cancelled" })}
        cancel={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancels pending native work when closed or unmounted, ignoring a late failure", async () => {
    const native = pending();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const view = render(
      <AndroidDocumentReader
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
      <AndroidDocumentReader
        record={record}
        read={read}
        cancel={cancel}
        onClose={onClose}
      />,
    );
    view.rerender(
      <AndroidDocumentReader
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
