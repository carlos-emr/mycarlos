import { describe, expect, it } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import {
  documentCheckText,
  unlockCheckFailedText,
  unlockCheckNotRunText,
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
      `${CHECKED} Some clinic checks need attention. New documents saved: 1. Documents that could not be verified: 0. FAKE Clinic b: This approval request expired. To ask again for this device, go to Security, under Clinic documents.`,
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

  it("says plainly that a document could not be verified, and to contact the clinic", () => {
    // The portal offers it again at every unlock: no receipt is sent for
    // it. No count of nothing saved, and no retry that cannot help.
    expect(unlockCheckText(found({ refused: 1 }), every)).toBe(
      `${CHECKED} 1 clinic document could not be verified, so it was not added. Contact your clinic.`,
    );
    expect(unlockCheckText(found({ refused: 2 }), every)).toBe(
      `${CHECKED} 2 clinic documents could not be verified, so they were not added. Contact your clinic.`,
    );
    // Beside saved documents, the counts say it.
    expect(unlockCheckText(found({ added: 1, refused: 1 }), every)).toBe(
      `${CHECKED} New documents saved: 1. Documents that could not be verified: 1.`,
    );
  });

  it("names the button only when checking again can help", () => {
    for (const [code, detail] of [
      [
        "portal_rate_limited",
        "The clinic portal asked myCarlos to wait before trying again.",
      ],
      [
        "portal_device_removed",
        "This device was removed from your clinic portal account. To use it again, connect it again with a new linking code from your patient portal.",
      ],
      [
        "approval_reply_invalid",
        "The clinic portal's answer about this request could not be verified, so it was not used. Contact your clinic.",
      ],
    ])
      expect(
        unlockCheckText(found({ issues: [clinic("a", code)] }), every),
      ).toBe(`${NOT_FINISHED} FAKE Clinic a: ${detail}`);
    // One problem that checking again can help is enough.
    expect(
      unlockCheckText(
        found({
          issues: [
            clinic("a", "portal_device_removed"),
            clinic("b", "portal_link_incomplete"),
          ],
        }),
        every,
      ).endsWith(`${OFFLINE} ${RETRY}`),
    ).toBe(true);
    expect(
      unlockCheckFailedText({
        code: "recovery_mode",
        message: "FAKE native recovery text.",
      }),
    ).toBe(`${NOT_FINISHED} FAKE native recovery text.`);
    expect(
      unlockCheckFailedText({
        code: "portal_rate_limited",
        message: "FAKE native text.",
      }),
    ).toBe(
      `${NOT_FINISHED} The clinic portal asked myCarlos to wait before trying again.`,
    );
  });

  it("says confirmations still owed, and to check again, once", () => {
    expect(unlockCheckText(found({ receiptsPending: 2 }), every)).toBe(
      `${NOT_FINISHED} Saved documents awaiting pickup confirmation: 2. Check again to finish confirmation. Your saved copies stay in the vault.`,
    );
    expect(
      unlockCheckText(
        found({
          receiptsPending: 1,
          issues: [clinic("a", "portal_link_incomplete")],
        }),
        every,
      ),
    ).toBe(
      `${NOT_FINISHED} FAKE Clinic a: ${OFFLINE} Saved documents awaiting pickup confirmation: 1. Check again to finish confirmation. Your saved copies stay in the vault.`,
    );
  });

  it("says a check that did not run, and how to check", () => {
    expect(unlockCheckNotRunText()).toBe(
      `myCarlos did not check for new clinic documents after unlocking, because another clinic operation was running. ${RETRY}`,
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
      for (const count of [1, 2, 5, 22])
        expect(unlockCheckText(found({ refused: count }), every)).toBe(
          `${translate(locale, "portal.unlockChecked")} ${translate(locale, "portal.unlockRefused", { count })}`,
        );
      expect(unlockCheckNotRunText()).toBe(
        `${translate(locale, "portal.unlockCheckNotRun")} ${translate(locale, "portal.checkAgain", { button: check })}`,
      );
    }
  });
});
