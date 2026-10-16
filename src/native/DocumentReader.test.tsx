import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentReader } from "./DocumentReader";
import type { VaultRecord, ViewedPage } from "../vault";

// A real 1 x 1 PNG, so the picture loads.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const record: VaultRecord = {
  id: "record-1",
  profileId: "profile-1",
  folderIds: [],
  displayName: "FAKE_Bloodwork.pdf",
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
};
const page = (index: number): ViewedPage => ({
  pageCount: 2,
  width: 800,
  height: 1035,
  image: PNG,
  text: `FAKE text on page ${index + 1}`,
});
const refusal = (code: string) =>
  Object.assign(new Error(code), { code, message: `FAKE ${code}` });

function renderReader(
  viewPage = vi.fn(async (index: number, _width: number, _password?: string) =>
    page(index),
  ),
) {
  const onClose = vi.fn();
  render(
    <DocumentReader record={record} viewPage={viewPage} onClose={onClose} />,
  );
  return { viewPage, onClose };
}

describe("the document reader", () => {
  it("shows the first page, its text and where the document came from", async () => {
    const { viewPage } = renderReader();
    const reader = screen.getByRole("dialog", { name: "FAKE_Bloodwork.pdf" });
    expect(reader).toHaveAccessibleDescription("Manual import — unverified");
    const picture = await screen.findByRole("img", {
      name: "Page 1 of 2. The page's text follows.",
    });
    expect(picture).toHaveAttribute("src", PNG);
    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    expect(viewPage).toHaveBeenCalledTimes(1);
    const [index, width, password] = viewPage.mock.calls[0];
    expect(index).toBe(0);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(4096);
    expect(password).toBeUndefined();
    await userEvent.setup().click(screen.getByText("Text on this page"));
    expect(screen.getByText("FAKE text on page 1")).toBeVisible();
  });

  it("goes from page to page, keeping pages it has drawn", async () => {
    const user = userEvent.setup();
    const { viewPage } = renderReader();
    await screen.findByRole("img", { name: /^Page 1 of 2/ });
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("img", { name: /^Page 2 of 2/ });
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    await screen.findByRole("img", { name: /^Page 1 of 2/ });
    expect(viewPage).toHaveBeenCalledTimes(2);
  });

  it("draws a larger page when zoomed in, and fits it again", async () => {
    const user = userEvent.setup();
    const { viewPage } = renderReader();
    await screen.findByRole("img", { name: /^Page 1 of 2/ });
    const fitted = viewPage.mock.calls[0][1];
    expect(screen.getByRole("button", { name: "Fit width" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Larger" }));
    expect(screen.getByText("125%")).toBeVisible();
    await vi.waitFor(() => expect(viewPage).toHaveBeenCalledTimes(2));
    expect(viewPage.mock.calls[1][1]).toBeGreaterThan(fitted);
    await user.click(screen.getByRole("button", { name: "Fit width" }));
    expect(screen.getByText("100%")).toBeVisible();
    // Back to the width already drawn.
    expect(viewPage).toHaveBeenCalledTimes(2);
  });

  it("asks for a locked document's own password, and again when it is wrong", async () => {
    const user = userEvent.setup();
    const viewPage = vi
      .fn()
      .mockRejectedValueOnce(refusal("pdf_locked"))
      .mockRejectedValueOnce(refusal("pdf_wrong_password"))
      .mockImplementation(async (index: number) => page(index));
    renderReader(viewPage);
    const field = await screen.findByLabelText("Document password");
    expect(screen.queryByRole("img")).toBeNull();
    await user.type(field, "FAKE-wrong{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That password did not open the document.",
    );
    await user.type(
      screen.getByLabelText("Document password"),
      "FAKE-portal-2026{Enter}",
    );
    await screen.findByRole("img", { name: /^Page 1 of 2/ });
    expect(viewPage).toHaveBeenLastCalledWith(
      0,
      expect.any(Number),
      "FAKE-portal-2026",
    );
    // Later pages use the same password, without asking.
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("img", { name: /^Page 2 of 2/ });
    expect(viewPage).toHaveBeenLastCalledWith(
      1,
      expect.any(Number),
      "FAKE-portal-2026",
    );
  });

  it("says why a page could not be shown, and closes", async () => {
    const user = userEvent.setup();
    const { onClose } = renderReader(
      vi.fn().mockRejectedValue(refusal("pdf_view_failed")),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "FAKE pdf_view_failed",
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }),
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
