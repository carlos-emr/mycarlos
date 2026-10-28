import { describe, expect, it } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import {
  documentCheckText,
  unlockCheckFailedText,
  unlockCheckText,
  type DocumentCheck,
} from "./documentCheck";

const found = (extra: Partial<DocumentCheck> = {}): DocumentCheck => ({
  added: 0,
  refused: 0,
  receiptsPending: 0,
  issues: [],
  ...extra,
});
const clinic = (linkId: string, code: string) => ({
  linkId,
  clinicName: `FAKE Clinic ${linkId}`,
  code,
});
const every = () => true;
const CHECKED = "Checked for new clinic documents after unlocking.";
const NOT_FINISHED =
  "myCarlos could not finish checking for new clinic documents after unlocking.";
const RETRY = "To check again, choose Check for new documents.";
const OFFLINE =
  "The portal request could not be completed. Check your connection and device clock, then try again.";

describe("what a check for new clinic documents says (#128)", () => {
  it("says nothing after unlocking when nothing arrived and nothing went wrong", () => {
    expect(unlockCheckText(found(), every)).toBe("");
    expect(unlockCheckText(found({ issues: undefined }), every)).toBe("");
  });

  it("says what arrived as Check for new documents says it", () => {
    expect(documentCheckText(found({ added: 2 }))).toBe(
      "New documents saved: 2. Documents that could not be verified: 0.",
    );
    expect(unlockCheckText(found({ added: 2 }), every)).toBe(
      `${CHECKED} New documents saved: 2. Documents that could not be verified: 0.`,
    );
  });

  it("tells a check that could not finish apart from an empty one, and names the retry", () => {
    expect(
      unlockCheckText(
        found({ issues: [clinic("a", "portal_link_incomplete")] }),
        every,
      ),
    ).toBe(`${NOT_FINISHED} FAKE Clinic a: ${OFFLINE} ${RETRY}`);
    expect(
      unlockCheckFailedText({ code: "storage", message: "FAKE fault." }),
    ).toBe(`${NOT_FINISHED} FAKE fault. ${RETRY}`);
  });

  it("keeps what arrived beside another clinic's problem", () => {
    expect(
      unlockCheckText(
        found({ added: 1, issues: [clinic("b", "approval_expired")] }),
        every,
      ),
    ).toBe(
      `${CHECKED} Some clinic checks need attention. New documents saved: 1. Documents that could not be verified: 0. FAKE Clinic b: This approval request expired. To ask again for this device, go to Security, under Clinic documents. ${RETRY}`,
    );
  });

  it("speaks only for the links the check was for", () => {
    const counted = (id: string) => id === "a";
    const elsewhere = [clinic("b", "portal_link_incomplete")];
    expect(unlockCheckText(found({ issues: elsewhere }), counted)).toBe("");
    expect(
      unlockCheckText(found({ added: 1, issues: elsewhere }), counted),
    ).toBe(
      `${CHECKED} New documents saved: 1. Documents that could not be verified: 0.`,
    );
  });

  it("offers no retry that cannot help: an unverifiable document, or read-only recovery", () => {
    expect(unlockCheckText(found({ refused: 1 }), every)).toBe(
      `${CHECKED} New documents saved: 0. Documents that could not be verified: 1.`,
    );
    expect(
      unlockCheckFailedText({
        code: "recovery_mode",
        message: "FAKE native recovery text.",
      }),
    ).toBe(`${NOT_FINISHED} FAKE native recovery text.`);
  });

  it("says confirmations still owed, with the retry that finishes them", () => {
    expect(unlockCheckText(found({ receiptsPending: 2 }), every)).toBe(
      `${NOT_FINISHED} Saved documents awaiting pickup confirmation: 2. Check again to finish confirmation. Your saved copies stay in the vault. ${RETRY}`,
    );
  });

  it("says it in every supported language, naming the button as it reads there", () => {
    for (const locale of LOCALES) {
      setLocaleOverride(locale);
      const check = translate(locale, "portal.check");
      expect(
        unlockCheckText(
          found({ issues: [clinic("a", "portal_link_incomplete")] }),
          every,
        ),
      ).toBe(
        [
          translate(locale, "portal.unlockCheckIncomplete"),
          translate(locale, "portal.clinicIssue", {
            clinic: "FAKE Clinic a",
            detail: translate(locale, "portal.errorIncomplete"),
          }),
          translate(locale, "portal.checkAgain", { button: check }),
        ].join(" "),
      );
      expect(
        translate(locale, "portal.checkAgain", { button: check }),
      ).toContain(check);
      expect(unlockCheckText(found({ added: 1 }), every)).toBe(
        `${translate(locale, "portal.unlockChecked")} ${translate(locale, "portal.result", { added: 1, refused: 0 })}`,
      );
    }
  });
});
