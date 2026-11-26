import { afterEach, describe, expect, it } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import { visibleText } from "../test/humanText";
import { documentCheckText } from "./documentCheck";

// What Check for new documents says: what arrived, what arrived for a hidden person (by clinic and
// never naming the person), what went wrong, and what is still to be confirmed. FAKE data only.

afterEach(() => setLocaleOverride(null));

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));
const said = (result: Parameters<typeof documentCheckText>[0]) => {
  setLocaleOverride("en");
  return visibleText(documentCheckText(result));
};

describe("what a check for new documents says", () => {
  it("says what was added and refused, and nothing else when nothing else happened", () => {
    expect(said({ added: 2, refused: 1, issues: [], receiptsPending: 0 })).toBe(
      en("portal.result", { added: 2, refused: 1 }),
    );
  });

  it("says documents that arrived for a hidden person per clinic, with a count, and never names the person", () => {
    const text = said({
      added: 3,
      refused: 0,
      issues: [],
      receiptsPending: 0,
      // Two for one clinic, one for another, one from a link that has no clinic name yet.
      forHidden: ["FAKE Clinic One", "FAKE Clinic Two", "FAKE Clinic One", ""],
    });
    expect(text).toContain(
      en("portal.arrivedForHidden", { clinic: "FAKE Clinic One", count: 2 }),
    );
    expect(text).toContain(
      en("portal.arrivedForHidden", { clinic: "FAKE Clinic Two", count: 1 }),
    );
    // A link with no clinic name is said without one, never as an empty name.
    expect(text).toContain(en("portal.arrivedForHiddenNoClinic", { count: 1 }));
    expect(text).not.toMatch(/FAKE Casey|hidden person/i);
  });

  it("says a partial result with each clinic's problem, and the confirmations still owed, in that order", () => {
    const text = said({
      added: 1,
      refused: 0,
      issues: [
        { linkId: "l1", clinicName: "FAKE Clinic One", code: "portal_busy" },
        {
          linkId: "l2",
          clinicName: "FAKE Clinic Two",
          code: "portal_rate_limited",
        },
      ],
      receiptsPending: 2,
    } as never);
    const partial = text.indexOf(
      en("portal.partialResult", { added: 1, refused: 0 }),
    );
    const first = text.indexOf("FAKE Clinic One");
    const second = text.indexOf("FAKE Clinic Two");
    const pending = text.indexOf(
      en("portal.confirmationsPending", { count: 2 }),
    );
    expect(partial).toBe(0);
    expect(first).toBeGreaterThan(partial);
    expect(second).toBeGreaterThan(first);
    expect(pending).toBeGreaterThan(second);
    // With problems it is the "needs attention" result that leads, not the plain one.
    expect(
      text.startsWith(en("portal.partialResult", { added: 1, refused: 0 })),
    ).toBe(true);
  });
});
