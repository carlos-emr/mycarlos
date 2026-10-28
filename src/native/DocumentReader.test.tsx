import { humanText, visibleText } from "../test/humanText";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { cacheDrawnPage, DocumentReader } from "./DocumentReader";
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
  const cancelView = vi.fn();
  const view = render(
    <DocumentReader
      record={record}
      viewPage={viewPage}
      cancelView={cancelView}
      onClose={onClose}
    />,
  );
  return { viewPage, onClose, cancelView, unmount: view.unmount };
}

describe("the document reader", () => {
  it("shows reader-only line boundaries without changing legacy text", async () => {
    const raw =
      "FAKE Imaging ReportPatient: FAKE Morgan PatientFinding: HbA1c 1.5 mg 120/80";
    const readable =
      "FAKE Imaging Report\nPatient: FAKE Morgan Patient\nFinding: HbA1c 1.5 mg 120/80";
    const supplied = { ...page(0), text: raw, readableText: readable };
    renderReader(vi.fn(async () => supplied));
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    await userEvent
      .setup()
      .click(screen.getByText(humanText("Text on this page")));
    const text = document.querySelector(".native-reader-text div")!;
    expect(text.textContent).toBe(readable);
    expect(getComputedStyle(text).whiteSpace).toBe("pre-wrap");
    expect(supplied.text).toBe(raw);
  });

  it("counts both text representations in its page cache budget", () => {
    const cache = new Map<string, ViewedPage>();
    cacheDrawnPage(cache, "large-text", {
      ...page(0),
      image: "a".repeat(24 * 1024 * 1024),
      text: "b".repeat(12 * 1024 * 1024),
      readableText: "c".repeat(12 * 1024 * 1024 + 1),
    });
    expect(cache.has("large-text")).toBe(false);
  });

  it("shows the first page, its text and where the document came from", async () => {
    const { viewPage } = renderReader();
    const reader = screen.getByRole("dialog", {
      name: humanText("FAKE_Bloodwork.pdf"),
    });
    expect(reader).toHaveHumanAccessibleDescription(
      "Manual import — unverified",
    );
    const picture = await screen.findByRole("img", {
      name: humanText("Page 1 of 2. The page's text follows."),
    });
    expect(picture).toHaveAttribute("src", PNG);
    // Fitted to the reader, the page does not scroll sideways.
    const area = picture.parentElement!;
    expect(area.scrollWidth).toBeLessThanOrEqual(area.clientWidth);
    const style = getComputedStyle(area);
    const available = Math.floor(
      area.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight),
    );
    expect(available).toBeGreaterThan(200);
    expect(
      Math.abs(picture.getBoundingClientRect().width - available),
    ).toBeLessThanOrEqual(1);
    // One visible count beside the buttons; the completion is still announced.
    const counts = screen.getAllByText(humanText("Page 1 of 2"));
    expect(
      counts.filter((count) => {
        const bounds = count.getBoundingClientRect();
        return bounds.width > 1 && bounds.height > 1;
      }),
    ).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveHumanTextContent("Page 1 of 2");
    expect(viewPage).toHaveBeenCalledTimes(1);
    const [index, width, password] = viewPage.mock.calls[0];
    expect(index).toBe(0);
    expect(width).toBe(
      Math.min(4096, Math.round(available * window.devicePixelRatio)),
    );
    expect(password).toBeUndefined();
    await userEvent
      .setup()
      .click(screen.getByText(humanText("Text on this page")));
    expect(screen.getByText(humanText("FAKE text on page 1"))).toBeVisible();
  });

  it("goes from page to page, keeping pages it has drawn", async () => {
    const user = userEvent.setup();
    const { viewPage } = renderReader();
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    expect(
      screen.getByRole("button", { name: humanText("Previous page") }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getByRole("button", { name: humanText("Next page") }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
    expect(
      screen.getByRole("button", { name: humanText("Next page") }),
    ).toHaveAttribute("aria-disabled", "true");
    // A button that cannot be used does nothing.
    await user.click(
      screen.getByRole("button", { name: humanText("Next page") }),
    );
    expect(viewPage).toHaveBeenCalledTimes(2);
    await user.click(
      screen.getByRole("button", { name: humanText("Previous page") }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    expect(viewPage).toHaveBeenCalledTimes(2);
  });

  it("draws a larger page when zoomed in, and fits it again", async () => {
    const user = userEvent.setup();
    const { viewPage } = renderReader();
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    const fitted = viewPage.mock.calls[0][1];
    expect(
      screen.getByRole("button", { name: humanText("Fit width") }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: humanText("Larger") }));
    expect(screen.getByText(humanText("125%"))).toBeVisible();
    await vi.waitFor(() => expect(viewPage).toHaveBeenCalledTimes(2));
    expect(viewPage.mock.calls[1][1]).toBeGreaterThan(fitted);
    const fit = screen.getByRole("button", { name: humanText("Fit width") });
    await vi.waitFor(() => expect(fit).toBeEnabled());
    await user.click(fit);
    expect(screen.getByText(humanText("100%"))).toBeVisible();
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
    const field = await screen.findByLabelText(humanText("Document password"));
    expect(screen.queryByRole("img")).toBeNull();
    await user.type(field, "FAKE-wrong{Enter}");
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "That password did not open the document.",
    );
    await user.type(
      screen.getByLabelText(humanText("Document password")),
      "FAKE-portal-2026{Enter}",
    );
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    expect(viewPage).toHaveBeenLastCalledWith(
      0,
      expect.any(Number),
      "FAKE-portal-2026",
    );
    // Later pages use the same password, without asking.
    await user.click(
      screen.getByRole("button", { name: humanText("Next page") }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
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
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveHumanTextContent("FAKE pdf_view_failed");
    expect(failure).toBeVisible();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: humanText("Close"),
      }),
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("draws one page at a time, and stops it when the reader closes", async () => {
    const user = userEvent.setup();
    let finish: (value: ViewedPage) => void = () => undefined;
    const viewPage = vi.fn(
      (_index: number, _width: number, _password?: string) =>
        new Promise<ViewedPage>((resolve) => {
          finish = resolve;
        }),
    );
    const { cancelView, unmount } = renderReader(viewPage);
    expect(await screen.findByText(humanText("Opening page 1…"))).toBeVisible();
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "Opening page 1…",
    );
    expect(
      screen.getByRole("status").getBoundingClientRect().height,
    ).toBeGreaterThan(1);
    // Sizes cannot be asked for while one is being drawn; the page buttons
    // wait for the page count.
    for (const name of ["Larger", "Smaller"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
    await user.click(screen.getByRole("button", { name: humanText("Larger") }));
    expect(viewPage).toHaveBeenCalledTimes(1);
    finish(page(0));
    // Once shown, the page is said, for screen readers.
    await vi.waitFor(() =>
      expect(screen.getByRole("status")).toHaveHumanTextContent("Page 1 of 2"),
    );
    expect(cancelView).not.toHaveBeenCalled();
    unmount();
    expect(cancelView).toHaveBeenCalledTimes(1);
  });

  it("keeps only the last few pages drawn", async () => {
    const user = userEvent.setup();
    const viewPage = vi.fn(
      async (index: number, _width: number, _password?: string) => ({
        ...page(index),
        pageCount: 10,
      }),
    );
    renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 10/) });
    for (let next = 2; next <= 8; next++) {
      await user.click(
        screen.getByRole("button", { name: humanText("Next page") }),
      );
      await screen.findByRole("img", {
        name: humanText(new RegExp(`^Page ${next} of`)),
      });
    }
    for (let back = 7; back >= 1; back--) {
      await user.click(
        screen.getByRole("button", { name: humanText("Previous page") }),
      );
      await screen.findByRole("img", {
        name: humanText(new RegExp(`^Page ${back} of`)),
      });
    }
    // Pages 3 to 8 were kept; 1 and 2 had to be drawn again.
    expect(viewPage).toHaveBeenCalledTimes(10);
  });

  it("does not retain an oversized page in the page cache", () => {
    const cache = new Map<string, ViewedPage>();
    cacheDrawnPage(cache, "small", page(1));
    cacheDrawnPage(cache, "oversized", {
      ...page(0),
      image: "a".repeat(48 * 1024 * 1024 + 1),
    });
    const retainedCharacters = [...cache.values()].reduce(
      (sum, kept) => sum + kept.image.length,
      0,
    );
    expect(retainedCharacters).toBeLessThanOrEqual(48 * 1024 * 1024);
    expect(cache.has("oversized")).toBe(false);
  });

  it("lets the keyboard reach a zoomed page, to move it with the arrow keys", async () => {
    renderReader();
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    const area = screen.getByRole("region", { name: humanText("Page 1") });
    expect(area).toHaveAttribute("tabindex", "0");
    area.focus();
    expect(area).toHaveFocus();
  });

  it("does not leave the last page's picture under a page that failed", async () => {
    const user = userEvent.setup();
    const viewPage = vi
      .fn()
      .mockImplementationOnce(async () => page(0))
      .mockRejectedValueOnce(refusal("pdf_view_failed"));
    renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    await user.click(
      screen.getByRole("button", { name: humanText("Next page") }),
    );
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveHumanTextContent("FAKE pdf_view_failed");
    expect(failure).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(humanText("Text on this page"))).toBeNull();
  });
});

/** A FAKE document of `count` pages. */
const pagesOf = (count: number) =>
  vi.fn(async (index: number, _width: number, _password?: string) => ({
    ...page(index),
    pageCount: count,
  }));
const pageButton = (name: string) =>
  screen.getByRole("button", { name: humanText(name) });
const bar = () => document.querySelector<HTMLElement>(".native-reader-pages")!;
/** Each element's row on screen, as the height of its middle. */
const rowsOf = (elements: Element[]) =>
  elements.map((element) => {
    const { top, bottom } = element.getBoundingClientRect();
    return Math.round((top + bottom) / 2);
  });

// D144 (Ben, 28 Oct): the page buttons in a bar at the reader's foot, in
// words, with First and Last; the zoom alone at the top left.
describe("the reader's page bar", () => {
  it("is at the foot, in words and in reading order, with the zoom alone at the top left", async () => {
    renderReader(pagesOf(5));
    const picture = await screen.findByRole("img", {
      name: humanText(/^Page 1 of 5/),
    });
    const reader = screen.getByRole("dialog");
    expect(reader.lastElementChild).toBe(bar());
    expect(
      Array.from(bar().children, (child) =>
        visibleText(child.textContent ?? ""),
      ),
    ).toEqual([
      "First page",
      "Previous page",
      "Page 1 of 5",
      "Next page",
      "Last page",
    ]);
    // Below the page, in one row on a wide reader.
    expect(bar().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      picture.parentElement!.getBoundingClientRect().bottom - 1,
    );
    expect(new Set(rowsOf(Array.from(bar().children))).size).toBe(1);
    // The top row holds the zoom only, from the reader's left.
    const controls = document.querySelector(".native-reader-controls")!;
    expect(within(controls as HTMLElement).queryAllByRole("button")).toEqual(
      within(controls as HTMLElement).getAllByRole("button", {
        name: /Smaller|Larger|Fit width/,
      }),
    );
    const zoom = controls.querySelector(".native-reader-zoom")!;
    expect(
      zoom.getBoundingClientRect().left - reader.getBoundingClientRect().left,
    ).toBeLessThanOrEqual(24);
    // Each button names its key, for screen readers.
    expect(
      ["First page", "Previous page", "Next page", "Last page"].map((name) =>
        pageButton(name).getAttribute("aria-keyshortcuts"),
      ),
    ).toEqual(["Home", "PageUp", "PageDown", "End"]);
  });

  it("goes to the first and the last page", async () => {
    const user = userEvent.setup();
    const viewPage = pagesOf(5);
    renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    expect(pageButton("First page")).toHaveAttribute("aria-disabled", "true");
    await user.click(pageButton("Last page"));
    await screen.findByRole("img", { name: humanText(/^Page 5 of 5/) });
    expect(viewPage).toHaveBeenLastCalledWith(4, expect.any(Number), undefined);
    for (const name of ["Next page", "Last page"])
      expect(pageButton(name)).toHaveAttribute("aria-disabled", "true");
    expect(pageButton("Previous page")).toHaveAttribute(
      "aria-disabled",
      "false",
    );
    await user.click(pageButton("First page"));
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    // Page 1 was kept from before.
    expect(viewPage).toHaveBeenCalledTimes(2);
  });

  it("keeps the focus on a page button once it cannot be used", async () => {
    const user = userEvent.setup();
    renderReader(pagesOf(5));
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    pageButton("Last page").focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: humanText(/^Page 5 of 5/) });
    expect(pageButton("Last page")).toHaveFocus();
    expect(pageButton("Last page")).toHaveAttribute("aria-disabled", "true");
  });

  it("does not turn a page while one is being drawn", async () => {
    const user = userEvent.setup();
    let finish: (value: ViewedPage) => void = () => undefined;
    const viewPage = vi.fn(
      (index: number, _width: number, _password?: string) =>
        index === 0
          ? Promise.resolve({ ...page(0), pageCount: 5 })
          : new Promise<ViewedPage>((resolve) => {
              finish = resolve;
            }),
    );
    renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    await user.click(pageButton("Next page"));
    await screen.findByText(humanText("Opening page 2…"));
    for (const name of [
      "First page",
      "Previous page",
      "Next page",
      "Last page",
    ])
      expect(pageButton(name)).toHaveAttribute("aria-disabled", "true");
    await user.click(pageButton("Last page"));
    await user.keyboard("{End}");
    finish({ ...page(1), pageCount: 5 });
    await screen.findByRole("img", { name: humanText(/^Page 2 of 5/) });
    expect(viewPage).toHaveBeenCalledTimes(2);
  });

  it("turns pages with Home, End, Page Up and Page Down", async () => {
    const user = userEvent.setup();
    renderReader(pagesOf(5));
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    screen.getByRole("region", { name: humanText("Page 1") }).focus();
    await user.keyboard("{End}");
    await screen.findByRole("img", { name: humanText(/^Page 5 of 5/) });
    await user.keyboard("{PageUp}");
    await screen.findByRole("img", { name: humanText(/^Page 4 of 5/) });
    await user.keyboard("{Home}");
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    // From a button too, and the key does not also scroll.
    const close = within(screen.getByRole("dialog")).getByRole("button", {
      name: humanText("Close"),
    });
    close.focus();
    expect(fireEvent.keyDown(close, { key: "PageDown" })).toBe(false);
    await screen.findByRole("img", { name: humanText(/^Page 2 of 5/) });
    // With Ctrl, Alt, Shift or Cmd the key is the system's.
    for (const modifier of ["ctrlKey", "altKey", "shiftKey", "metaKey"])
      expect(fireEvent.keyDown(close, { key: "End", [modifier]: true })).toBe(
        true,
      );
    expect(
      screen.getByRole("img", { name: humanText(/^Page 2 of 5/) }),
    ).toBeInTheDocument();
  });

  it("leaves Home, End, Page Up and Page Down to the password box", async () => {
    const user = userEvent.setup();
    const viewPage = vi
      .fn()
      .mockImplementationOnce(async () => ({ ...page(0), pageCount: 3 }))
      .mockRejectedValueOnce(refusal("pdf_locked"))
      .mockImplementation(async (index: number) => ({
        ...page(index),
        pageCount: 3,
      }));
    renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 3/) });
    await user.click(pageButton("Next page"));
    const field = await screen.findByLabelText(humanText("Document password"));
    await user.type(field, "FAKE-pw");
    for (const key of ["Home", "End", "PageUp", "PageDown"])
      expect(fireEvent.keyDown(field, { key })).toBe(true);
    await user.keyboard("{Home}X");
    expect(field).toHaveValue("XFAKE-pw");
    expect(viewPage).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("region", { name: humanText("Page 2") }),
    ).toBeInTheDocument();
  });

  it("shows a one-page document's count only", async () => {
    const viewPage = pagesOf(1);
    renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 1/) });
    expect(visibleText(bar().textContent ?? "")).toBe("Page 1 of 1");
    expect(within(bar()).queryAllByRole("button")).toEqual([]);
    // Its keys scroll the page, as they would anywhere.
    const area = screen.getByRole("region", { name: humanText("Page 1") });
    for (const key of ["Home", "End", "PageUp", "PageDown"])
      expect(fireEvent.keyDown(area, { key })).toBe(true);
    expect(viewPage).toHaveBeenCalledTimes(1);
  });

  it("puts the buttons two by two on a narrow reader, with the count between", async () => {
    renderReader(pagesOf(5));
    await screen.findByRole("img", { name: humanText(/^Page 1 of 5/) });
    // A phone's width: the reader is measured, not the window.
    screen.getByRole("dialog").style.width = "360px";
    const [first, previous, where, next, last] = Array.from(bar().children);
    await vi.waitFor(() =>
      expect(getComputedStyle(bar()).display).toBe("grid"),
    );
    const [firstRow, previousRow, whereRow, nextRow, lastRow] = rowsOf([
      first,
      previous,
      where,
      next,
      last,
    ]);
    expect(previousRow).toBe(firstRow);
    expect(lastRow).toBe(nextRow);
    expect(whereRow).toBeGreaterThan(firstRow);
    expect(nextRow).toBeGreaterThan(whereRow);
    const left = (element: Element) => element.getBoundingClientRect().left;
    expect(left(first)).toBe(left(next));
    expect(left(previous)).toBe(left(last));
    expect(left(previous)).toBeGreaterThan(left(first));
    // Nothing runs off the reader's edge.
    expect(bar().scrollWidth).toBeLessThanOrEqual(bar().clientWidth);
  });
});
