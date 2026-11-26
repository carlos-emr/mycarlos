import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClinicNewStrip } from "./ClinicNewStrip";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { computeAccessibleName } from "dom-accessibility-api";
import { humanText, visibleText } from "../test/humanText";

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

const title = (locale: (typeof LOCALES)[number], count: number, clinics = 1) =>
  visibleText(
    translate(
      locale,
      clinics > 1
        ? "interface.clinicNew.fromClinics"
        : "interface.clinicNew.fromClinic",
      { count },
    ),
  );

describe("the New strip", () => {
  it("shows nothing when there is nothing new", () => {
    for (const count of [0, -1]) {
      const { container, unmount } = render(<ClinicNewStrip count={count} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("is a region named by its heading, with the count in words and no name of a clinic or a document", () => {
    setLocaleOverride("en");
    render(<ClinicNewStrip count={3} />);
    const region = screen.getByRole("region", {
      name: humanText("3 new from your clinic"),
    });
    const heading = within(region).getByRole("heading", { level: 2 });
    expect(heading).toHaveHumanTextContent("3 new from your clinic");
    // It does not announce itself: the library says a rise in the count, once, politely.
    expect(
      region.querySelector("[aria-live], [role=status], [role=alert]"),
    ).toBeNull();
    // Neither buttons nor words name a clinic or a document.
    expect(region.textContent).not.toMatch(/\.pdf|FAKE/i);
  });

  it.each(LOCALES)(
    "says the count in %s with that language's plural rules",
    (locale) => {
      setLocaleOverride(locale);
      for (const count of [1, 2, 5, 22]) {
        const { unmount } = render(<ClinicNewStrip count={count} />);
        expect(
          screen.getByRole("heading", { level: 2 }),
        ).toHaveHumanTextContent(title(locale, count));
        unmount();
      }
      // With documents from more than one clinic it says clinics.
      const { unmount } = render(<ClinicNewStrip count={4} clinics={2} />);
      expect(screen.getByRole("heading", { level: 2 })).toHaveHumanTextContent(
        title(locale, 4, 2),
      );
      if (locale !== "zh-CN" && locale !== "zh-TW")
        expect(title(locale, 4, 2)).not.toBe(title(locale, 4, 1));
      unmount();
    },
  );

  it("uses the three Polish forms the language needs", () => {
    setLocaleOverride("pl");
    const forms = [1, 2, 5].map((count) => title("pl", count));
    expect(new Set(forms).size).toBe(3);
  });

  it.each(LOCALES)(
    "names its buttons with the visible words first and the count after, in %s",
    (locale) => {
      setLocaleOverride(locale);
      render(<ClinicNewStrip count={3} />);
      const show = translate(locale, "interface.clinicNew.showThem");
      const mark = translate(locale, "interface.clinicNew.markAll");
      for (const visible of [show, mark]) {
        const button = screen.getByRole("button", {
          name: (name) => visibleText(name).startsWith(visibleText(visible)),
        });
        // WCAG 2.5.3: what is shown leads the name, and the name carries the count.
        expect(visibleText(button.textContent ?? "")).toBe(
          visibleText(visible),
        );
        expect(visibleText(computeAccessibleName(button))).toContain(
          title(locale, 3),
        );
      }
    },
  );

  it("opens the new documents, marks them all as seen, and goes back to the whole list", async () => {
    setLocaleOverride("en");
    const user = userEvent.setup();
    const onShow = vi.fn();
    const onShowAll = vi.fn();
    const onMarkAllSeen = vi.fn();
    const { rerender } = render(
      <ClinicNewStrip
        count={3}
        onShow={onShow}
        onShowAll={onShowAll}
        onMarkAllSeen={onMarkAllSeen}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText("Show them, 3 new from your clinic"),
      }),
    );
    expect(onShow).toHaveBeenCalledOnce();
    // The focus goes to the strip's heading, where the patient was.
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveFocus(),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText("Mark all as seen, 3 new from your clinic"),
      }),
    );
    expect(onMarkAllSeen).toHaveBeenCalledOnce();
    // While only the new ones are shown, the first button says how to leave that.
    rerender(
      <ClinicNewStrip
        count={3}
        showing
        onShow={onShow}
        onShowAll={onShowAll}
        onMarkAllSeen={onMarkAllSeen}
      />,
    );
    expect(screen.getByText("Showing only the new documents.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Show them/ })).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Show all documents" }),
    );
    expect(onShowAll).toHaveBeenCalledOnce();
    expect(onShow).toHaveBeenCalledOnce();
  });

  it("passes axe in each language, also with only the new ones shown", async () => {
    for (const locale of LOCALES) {
      setLocaleOverride(locale);
      for (const showing of [false, true]) {
        const { unmount } = render(
          <main>
            <ClinicNewStrip count={3} clinics={2} showing={showing} />
          </main>,
        );
        expect(await axe.run(document.body, AXE)).toHaveProperty(
          "violations",
          [],
        );
        unmount();
      }
    }
  });
});
