import { describe, expect, it } from "vitest";
import { formatBytes, nameTooLong, recordKind } from "./recordPresentation";

describe("recordKind", () => {
  it.each([
    ["FAKE_Avery_Patient_Bloodwork.pdf", "Test result"],
    ["Lab results 2026.pdf", "Test result"],
    ["covid-tests.pdf", "Test result"],
    ["FAKE_Morgan_Patient_Imaging_Report.pdf", "Imaging"],
    ["Chest X-Ray.pdf", "Imaging"],
    ["scanned knee.pdf", "Imaging"],
    ["FAKE_Morgan_Patient_Prescription.pdf", "Prescription"],
    ["Medications list.pdf", "Prescription"],
    // Upper case must lower to the ASCII stems whatever the device locale is.
    ["IMAGING REPORT.PDF", "Imaging"],
  ])("recognises %s as %s", (name, label) => {
    expect(recordKind(name).label).toBe(label);
  });

  it.each([
    "Latest_Referral_Letter.pdf",
    "Collaboration agreement.pdf",
    "Prescan checklist.pdf",
    "Label instructions.pdf",
  ])("does not read a kind into a fragment of another word in %s", (name) => {
    expect(recordKind(name).label).toBe("Document");
  });
});

describe("formatBytes", () => {
  it("chooses the unit after rounding", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1_048_100)).toBe("1.0 MB");
  });
});

describe("nameTooLong", () => {
  it("counts characters of the trimmed name, as the vault does", () => {
    expect(nameTooLong("\u{1F4C1}".repeat(120))).toBe(false);
    expect(nameTooLong(`  ${"a".repeat(120)}  `)).toBe(false);
    expect(nameTooLong("a".repeat(121))).toBe(true);
  });
});
