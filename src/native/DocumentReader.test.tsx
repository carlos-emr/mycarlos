import { StrictMode } from "react";
import { humanText } from "../test/humanText";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { userEvent as realKeys } from "vitest/browser";
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

async function click(control: Element) {
  // Flush the promise callbacks too, including immediate synthetic page draws.
  await act(async () => {
    fireEvent.click(control);
  });
}

function renderReader(
  viewPage = vi.fn(async (index: number, _width: number, _password?: string) =>
    page(index),
  ),
  shownRecord: VaultRecord = record,
) {
  const onClose = vi.fn();
  const cancelView = vi.fn();
  const view = render(
    <DocumentReader
      record={shownRecord}
      viewPage={viewPage}
      cancelView={cancelView}
      onClose={onClose}
    />,
  );
  return { viewPage, onClose, cancelView, unmount: view.unmount };
}

describe("the document reader", () => {
  it.each([undefined, "", "2024-02-29"])(
    "keeps the clinic service date %s distinct from the date added",
    async (serviceDate) => {
      renderReader(undefined, { ...record, clinicServiceDate: serviceDate });
      if (serviceDate === undefined) {
        expect(screen.queryByText(/^Service date:/)).not.toBeInTheDocument();
      } else {
        expect(
          screen.getByText(
            humanText(
              `Service date: ${serviceDate === "" ? "Date not recorded" : serviceDate}`,
            ),
          ),
        ).toBeVisible();
      }
      await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    },
  );
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
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: humanText("Next page") }),
    );
    await screen.findByRole("img", { name: humanText(/^Page 2 of 2/) });
    expect(
      screen.getByRole("button", { name: humanText("Next page") }),
    ).toBeDisabled();
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

  it("accepts rapid zoom input while sharpening and requests only the settled size", async () => {
    let finish!: (value: ViewedPage) => void;
    const viewPage = vi
      .fn()
      .mockResolvedValueOnce(page(0))
      .mockImplementation(
        () =>
          new Promise<ViewedPage>((resolve) => {
            finish = resolve;
          }),
      );
    const { unmount } = renderReader(viewPage);
    const picture = await screen.findByRole("img", {
      name: humanText(/^Page 1 of 2/),
    });
    const fittedWidth = parseFloat(picture.style.width);
    vi.useFakeTimers();
    try {
      const larger = screen.getByRole("button", { name: humanText("Larger") });
      larger.focus();
      for (let i = 0; i < 3; i++) await click(larger);
      expect(larger).toBeEnabled();
      expect(larger).toHaveFocus();
      expect(screen.getByText(humanText("195%"))).toBeVisible();
      expect(parseFloat(picture.style.width)).toBe(
        Math.round(fittedWidth * 1.25 ** 3),
      );
      expect(
        screen.getByRole("region", { name: humanText("Page 1") }),
      ).toHaveAttribute("aria-busy", "true");
      expect(viewPage).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(119);
      });
      expect(viewPage).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(viewPage).toHaveBeenCalledTimes(2);
      expect(viewPage).toHaveBeenLastCalledWith(
        0,
        Math.min(
          4096,
          Math.round(
            Math.round(fittedWidth * 1.25 ** 3) * window.devicePixelRatio,
          ),
        ),
        undefined,
      );
      expect(larger).toBeEnabled();
      await act(async () => {
        finish({ ...page(0), text: "FAKE latest sharp page" });
      });
      expect(
        screen.getByRole("region", { name: humanText("Page 1") }),
      ).toHaveAttribute("aria-busy", "false");
      await click(screen.getByText(humanText("Text on this page")));
      expect(
        screen.getByText(humanText("FAKE latest sharp page")),
      ).toBeVisible();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("cancels superseded zooms, ignores their results and does not cache them", async () => {
    let old!: (value: ViewedPage) => void;
    let latest!: (value: ViewedPage) => void;
    const viewPage = vi
      .fn()
      .mockResolvedValueOnce(page(0))
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((resolve) => {
            old = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((resolve) => {
            latest = resolve;
          }),
      )
      .mockImplementation(async () => page(0));
    const { cancelView, unmount } = renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    vi.useFakeTimers();
    try {
      const larger = screen.getByRole("button", { name: humanText("Larger") });
      await click(larger);
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      await click(larger);
      expect(cancelView).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(viewPage).toHaveBeenCalledTimes(3);
      await act(async () => {
        old({ ...page(0), text: "FAKE stale zoom", pageCount: 99 });
      });
      expect(screen.getByRole("status")).toHaveHumanTextContent(
        "Opening page 1…",
      );
      expect(screen.queryByText(humanText("FAKE stale zoom"))).toBeNull();
      await act(async () => {
        latest({ ...page(0), text: "FAKE latest zoom" });
      });
      expect(screen.getByRole("status")).toHaveHumanTextContent("Page 1 of 2");
      await click(screen.getByText(humanText("Text on this page")));
      expect(screen.getByText(humanText("FAKE latest zoom"))).toBeVisible();
      await click(screen.getByRole("button", { name: humanText("Fit width") }));
      expect(screen.getByText(humanText("100%"))).toBeVisible();
      expect(viewPage).toHaveBeenCalledTimes(3);
      // The stale 125% result was discarded, so returning to it must draw again.
      await click(larger);
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(viewPage).toHaveBeenCalledTimes(4);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("returns to a cached size immediately and stops a sharper draw still in flight", async () => {
    let finish!: (value: ViewedPage) => void;
    const viewPage = vi
      .fn()
      .mockResolvedValueOnce(page(0))
      .mockImplementation(
        () =>
          new Promise<ViewedPage>((resolve) => {
            finish = resolve;
          }),
      );
    const { cancelView, unmount } = renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    vi.useFakeTimers();
    try {
      await click(screen.getByRole("button", { name: humanText("Larger") }));
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      await click(screen.getByRole("button", { name: humanText("Fit width") }));
      expect(cancelView).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("status")).toHaveHumanTextContent("Page 1 of 2");
      await act(async () => {
        finish({ ...page(0), text: "FAKE cancelled sharp page" });
      });
      await click(screen.getByText(humanText("Text on this page")));
      expect(screen.getByText(humanText("FAKE text on page 1"))).toBeVisible();
      expect(
        screen.queryByText(humanText("FAKE cancelled sharp page")),
      ).toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("recovers a failed zoom by returning to the fitted page already cached", async () => {
    let rejectZoom!: (failure: unknown) => void;
    const viewPage = vi
      .fn()
      .mockResolvedValueOnce(page(0))
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((_resolve, reject) => {
            rejectZoom = reject;
          }),
      );
    const { unmount } = renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    vi.useFakeTimers();
    try {
      await click(screen.getByRole("button", { name: humanText("Larger") }));
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      await act(async () => {
        rejectZoom(refusal("pdf_view_failed"));
      });
      expect(screen.getByRole("alert")).toHaveHumanTextContent(
        "FAKE pdf_view_failed",
      );
      const fit = screen.getByRole("button", { name: humanText("Fit width") });
      expect(fit).toBeEnabled();
      await click(fit);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("img", { name: humanText(/^Page 1 of 2/) }),
      ).toBeVisible();
      expect(screen.getByRole("status")).toHaveHumanTextContent("Page 1 of 2");
      expect(screen.getByText(humanText("100%"))).toBeVisible();
      expect(viewPage).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("discards queued sharpening when the reader closes", async () => {
    const { viewPage, cancelView, unmount } = renderReader();
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    vi.useFakeTimers();
    try {
      await click(screen.getByRole("button", { name: humanText("Larger") }));
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(viewPage).toHaveBeenCalledTimes(1);
      expect(cancelView).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["pdf_view_failed", "pdf_wrong_password", "pdf_locked"])(
    "ignores a stale %s rejection after the latest zoom succeeds",
    async (code) => {
      let rejectOld!: (failure: unknown) => void;
      const viewPage = vi
        .fn()
        .mockResolvedValueOnce(page(0))
        .mockImplementationOnce(
          () =>
            new Promise<ViewedPage>((_resolve, reject) => {
              rejectOld = reject;
            }),
        )
        .mockResolvedValue({ ...page(0), text: "FAKE latest successful zoom" });
      const { cancelView, unmount } = renderReader(viewPage);
      await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
      vi.useFakeTimers();
      try {
        const larger = screen.getByRole("button", {
          name: humanText("Larger"),
        });
        await click(larger);
        await act(async () => {
          vi.advanceTimersByTime(120);
        });
        await click(larger);
        await act(async () => {
          vi.advanceTimersByTime(120);
        });
        expect(viewPage).toHaveBeenCalledTimes(3);
        expect(cancelView).toHaveBeenCalledTimes(1);
        await act(async () => {
          rejectOld(refusal(code));
        });
        expect(screen.getByRole("status")).toHaveHumanTextContent(
          "Page 1 of 2",
        );
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
          screen.queryByLabelText(humanText("Document password")),
        ).toBeNull();
        expect(larger).toBeEnabled();
        await click(screen.getByText(humanText("Text on this page")));
        expect(
          screen.getByText(humanText("FAKE latest successful zoom")),
        ).toBeVisible();
      } finally {
        unmount();
        vi.useRealTimers();
      }
    },
  );

  it("cancels in-flight sharpening on close and discards its late result", async () => {
    let finish!: (value: ViewedPage) => void;
    const viewPage = vi
      .fn()
      .mockResolvedValueOnce(page(0))
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((resolve) => {
            finish = resolve;
          }),
      );
    const { cancelView, unmount } = renderReader(viewPage);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    vi.useFakeTimers();
    try {
      await click(screen.getByRole("button", { name: humanText("Larger") }));
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(viewPage).toHaveBeenCalledTimes(2);
      unmount();
      expect(cancelView).toHaveBeenCalledTimes(1);
      await act(async () => {
        finish({ ...page(0), text: "FAKE closed session" });
      });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(humanText("FAKE closed session"))).toBeNull();
      expect(viewPage).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("opens and closes under StrictMode while cancellation remains unresolved", async () => {
    const viewPage = vi.fn(async () => page(0));
    const cancellations: Array<() => void> = [];
    const cancelView = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          cancellations.push(resolve);
        }),
    );
    const { unmount } = render(
      <StrictMode>
        <DocumentReader
          record={record}
          viewPage={viewPage}
          cancelView={cancelView}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    expect(viewPage).toHaveBeenCalledTimes(1);
    expect(cancelView).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: humanText("Close") }),
    ).toHaveFocus();
    unmount();
    expect(cancelView).toHaveBeenCalledTimes(2);
    await act(async () => {
      cancellations.forEach((finish) => finish());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clamps a burst at each zoom bound and sharpens only the final width", async () => {
    const { viewPage, unmount } = renderReader();
    const picture = await screen.findByRole("img", {
      name: humanText(/^Page 1 of 2/),
    });
    const fittedWidth = parseFloat(picture.style.width);
    vi.useFakeTimers();
    try {
      const larger = screen.getByRole("button", { name: humanText("Larger") });
      const smaller = screen.getByRole("button", {
        name: humanText("Smaller"),
      });
      for (let i = 0; i < 20; i++) await click(larger);
      expect(screen.getByText(humanText("400%"))).toBeVisible();
      expect(larger).toBeDisabled();
      expect(smaller).toBeEnabled();
      expect(parseFloat(picture.style.width)).toBe(Math.round(fittedWidth * 4));
      expect(viewPage).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(viewPage).toHaveBeenCalledTimes(2);
      expect(viewPage).toHaveBeenLastCalledWith(
        0,
        Math.min(
          4096,
          Math.round(Math.round(fittedWidth * 4) * window.devicePixelRatio),
        ),
        undefined,
      );
      for (let i = 0; i < 20; i++) await click(smaller);
      expect(screen.getByText(humanText("50%"))).toBeVisible();
      expect(smaller).toBeDisabled();
      expect(larger).toBeEnabled();
      expect(parseFloat(picture.style.width)).toBe(
        Math.round(fittedWidth * 0.5),
      );
      expect(viewPage).toHaveBeenCalledTimes(2);
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(viewPage).toHaveBeenCalledTimes(3);
      expect(viewPage).toHaveBeenLastCalledWith(
        0,
        Math.min(
          4096,
          Math.round(Math.round(fittedWidth * 0.5) * window.devicePixelRatio),
        ),
        undefined,
      );
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("starts a new cache and password session when the document changes", async () => {
    let unlockFirst!: (value: ViewedPage) => void;
    const first = vi
      .fn()
      .mockRejectedValueOnce(refusal("pdf_locked"))
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((resolve) => {
            unlockFirst = resolve;
          }),
      );
    const second = vi.fn(async () => ({
      ...page(0),
      text: "FAKE second document",
    }));
    const cancelView = vi.fn();
    const props = { record, viewPage: first, cancelView, onClose: vi.fn() };
    const view = render(<DocumentReader {...props} />);
    const field = await screen.findByLabelText(humanText("Document password"));
    await userEvent.setup().type(field, "FAKE-session-secret");
    await click(screen.getByRole("button", { name: humanText("Open") }));
    await act(async () => {
      unlockFirst(page(0));
    });
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    await act(async () => {
      view.rerender(
        <DocumentReader
          {...props}
          record={{ ...record, id: "record-2", displayName: "FAKE second.pdf" }}
          viewPage={second}
        />,
      );
    });
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(second).toHaveBeenLastCalledWith(0, expect.any(Number), undefined);
    await screen.findByRole("img", { name: humanText(/^Page 1 of 2/) });
    expect(cancelView).toHaveBeenCalledTimes(1);
    await userEvent
      .setup()
      .click(screen.getByText(humanText("Text on this page")));
    expect(screen.getByText(humanText("FAKE second document"))).toBeVisible();
  });

  it("asks for a locked document's own password, and again when it is wrong", async () => {
    const user = userEvent.setup();
    let rejectWrong!: (reason: unknown) => void;
    let unlock!: (value: ViewedPage) => void;
    const viewPage = vi
      .fn()
      .mockRejectedValueOnce(refusal("pdf_locked"))
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((_resolve, reject) => {
            rejectWrong = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ViewedPage>((resolve) => {
            unlock = resolve;
          }),
      )
      .mockImplementation(async (index: number) => page(index));
    renderReader(viewPage);
    const field = await screen.findByLabelText(humanText("Document password"));
    expect(screen.queryByRole("img")).toBeNull();
    await user.type(field, "FAKE-wrong");
    // The browser submits the focused password field when Enter is pressed.
    await act(async () => {
      await realKeys.keyboard("{Enter}");
    });
    await act(async () => {
      rejectWrong(refusal("pdf_wrong_password"));
    });
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "That password did not open the document.",
    );
    await user.type(
      screen.getByLabelText(humanText("Document password")),
      "FAKE-portal-2026",
    );
    await click(screen.getByRole("button", { name: humanText("Open") }));
    await act(async () => {
      unlock(page(0));
    });
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
    // Initial opening has no picture to scale, and page navigation waits for it.
    for (const name of ["Larger", "Smaller", "Next page"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: humanText("Larger") }));
    expect(viewPage).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(page(0));
    });
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
