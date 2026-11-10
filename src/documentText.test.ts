import { describe, expect, it } from "vitest";
import {
  joinPages,
  toJoined,
  toPageSpan,
  type DocumentText,
} from "./documentText";

const pages = [
  { index: 0, text: "First page\nline two" },
  { index: 2, text: "Third page" },
];
const text: DocumentText = {
  pageCount: 3,
  pages,
  ...joinPages(pages),
  emptyPages: [],
  cutPages: [],
  failedPages: [1],
  truncated: false,
  ticket: "FAKE-ticket",
};

describe("a document's text (#72 part B)", () => {
  it("joins pages with a blank line and records where each starts", () => {
    expect(text.joined).toBe("First page\nline two\n\nThird page");
    expect(text.pageStarts).toEqual([0, 21]);
  });

  it("maps a range of the joined text to its page, and back", () => {
    expect(toPageSpan(text, 6, 10)).toEqual({ page: 0, start: 6, end: 10 });
    expect(toPageSpan(text, 21, 26)).toEqual({ page: 2, start: 0, end: 5 });
    expect(toJoined(text, { page: 2, start: 0, end: 5 })).toEqual([21, 26]);
    expect(toJoined(text, { page: 0, start: 6, end: 10 })).toEqual([6, 10]);
  });

  it("refuses a range that crosses pages, sits in the gap or names a page not read", () => {
    expect(toPageSpan(text, 15, 25)).toBeNull();
    expect(toPageSpan(text, 19, 21)).toBeNull();
    expect(toPageSpan(text, -1, 2)).toBeNull();
    expect(toPageSpan(text, 0, 99)).toBeNull();
    expect(toJoined(text, { page: 1, start: 0, end: 1 })).toBeNull();
    expect(toJoined(text, { page: 2, start: 0, end: 11 })).toBeNull();
  });
});
