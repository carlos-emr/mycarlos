import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { visibleText } from "../test/humanText";
import { setLocaleOverride } from "../i18n";
import {
  ReadingAidEntry,
  ReadingAidView,
  type ReadingAid,
} from "./ReadingAidView";

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

// Public values of carlos-portal's reading-aid-pair-contract.json (FAKE data).
const aid: ReadingAid = {
  language: "en",
  notice: {
    version: "carlos-5537-en-1",
    heading: "AI-generated reading aid — open the original document",
    body: "FAKE notice body: this reading aid was produced by software and checked by a clinician.\n\nIt is not your medical record. Open the original document for what your clinic recorded.",
  },
  overview:
    "FAKE chest X-ray report: the report describes the chest images and a plan.",
  points: [
    {
      text: "FAKE: no acute change is described compared with the earlier images.",
      evidence: ["FAKE no acute change compared with the prior study."],
    },
    {
      text: "FAKE: a repeat image is planned in three months.",
      evidence: ["FAKE repeat imaging in 3 months."],
    },
  ],
};
const REVIEWED_AT = Date.UTC(2026, 9, 19, 11, 58);

describe("a clinic reading aid is shown only under its notice", () => {
  it("puts the notice first, with the link to the original, before any summary text", () => {
    render(
      <ReadingAidView
        aid={aid}
        reviewedAtMs={REVIEWED_AT}
        onOpenOriginal={vi.fn()}
      />,
    );
    const notice = screen.getByRole("note");
    expect(visibleText(notice.textContent ?? "")).toContain(
      "AI-generated reading aid — open the original document",
    );
    expect(notice.querySelectorAll("p")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "Open the original document" }),
    ).toBeVisible();
    const overview = screen.getByText(aid.overview);
    const firstPoint = screen.getByText(aid.points[0].text);
    // Document order: notice, then overview, then points.
    expect(
      notice.compareDocumentPosition(overview) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      overview.compareDocumentPosition(firstPoint) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens the original from the notice and shows each point with its excerpt", () => {
    const open = vi.fn();
    render(
      <ReadingAidView
        aid={aid}
        reviewedAtMs={REVIEWED_AT}
        onOpenOriginal={open}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open the original document" }),
    );
    expect(open).toHaveBeenCalledTimes(1);
    for (const point of aid.points) {
      expect(screen.getByText(point.text)).toBeVisible();
      expect(
        screen.getByText(point.evidence[0], { exact: false }),
      ).toBeVisible();
    }
    expect(screen.getAllByText("From the document:")).toHaveLength(2);
    expect(screen.getByText(/Checked by a clinician on /)).toBeVisible();
  });

  it("treats everything in the aid as plain text", () => {
    const hostile: ReadingAid = {
      ...aid,
      overview: "<img src=x onerror=alert(1)> overview",
      points: [{ text: "<b>bold?</b>", evidence: ["<script>1</script>"] }],
    };
    const { container } = render(
      <ReadingAidView
        aid={hostile}
        reviewedAtMs={REVIEWED_AT}
        onOpenOriginal={vi.fn()}
      />,
    );
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(screen.getByText("<b>bold?</b>")).toBeVisible();
  });

  it("never shows the summary without its notice: a blank notice points to the original", () => {
    for (const notice of [
      { ...aid.notice, heading: "  " },
      { ...aid.notice, body: "" },
    ]) {
      const open = vi.fn();
      const { container, unmount } = render(
        <ReadingAidView
          aid={{ ...aid, notice }}
          reviewedAtMs={REVIEWED_AT}
          onOpenOriginal={open}
        />,
      );
      expect(screen.queryByText(aid.overview)).toBeNull();
      expect(screen.queryByText(aid.points[0].text)).toBeNull();
      expect(container.querySelector("[role=note]")).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "cannot be shown safely",
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Open the original document" }),
      );
      expect(open).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it("marks the aid's own language and offers an entry from the document's details", () => {
    const { container } = render(
      <ReadingAidView
        aid={{ ...aid, language: "fr" }}
        reviewedAtMs={REVIEWED_AT}
        onOpenOriginal={vi.fn()}
      />,
    );
    expect(container.querySelector("section")?.getAttribute("lang")).toBe("fr");
    cleanup();
    const open = vi.fn();
    render(<ReadingAidEntry onOpen={open} />);
    expect(
      screen.getByText(/Your clinic also sent a reading aid/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Read the reading aid" }),
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("speaks the interface in each language while the aid text stays as sent", () => {
    for (const locale of [
      "fr",
      "es",
      "pl",
      "pt-BR",
      "zh-CN",
      "zh-TW",
    ] as const) {
      setLocaleOverride(locale);
      const { unmount } = render(
        <ReadingAidView
          aid={aid}
          reviewedAtMs={REVIEWED_AT}
          onOpenOriginal={vi.fn()}
        />,
      );
      expect(screen.queryByText("Reading aid from your clinic")).toBeNull();
      expect(screen.queryByText("Open the original document")).toBeNull();
      expect(screen.getByText(aid.overview)).toBeVisible();
      unmount();
    }
  });
});
