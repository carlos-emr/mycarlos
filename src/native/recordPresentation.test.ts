import { describe, expect, it } from "vitest";
import {
  fileExtension,
  formatBytes,
  nameTooLong,
  recordKind,
  searchKey,
} from "./recordPresentation";

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

describe("searchKey", () => {
  it("does not depend on the device's locale", () => {
    // What a Turkish default locale would make of it.
    expect("Imaging".toLocaleLowerCase("tr")).toBe("ımaging");
    expect(searchKey("Imaging")).toBe(searchKey("imaging"));
  });

  it("matches an accent typed either way", () => {
    expect(searchKey("Café")).toBe(searchKey("Café"));
  });
});

describe("fileExtension", () => {
  // The same cases as `file_extension_matches_the_rename_dialog` in vault.rs.
  it.each([
    ["Results.pdf", ".pdf"],
    ["Results.PDF", ".PDF"],
    ["Results.Pdf", ".Pdf"],
    ["a.pdf", ".pdf"],
    ["Report.pdf.pdf", ".pdf"],
    ["Report\u2028A.pdf", ".pdf"],
    ["字.pdf", ".pdf"],
    [".pdf", ""],
    ["pdf", ""],
    ["Resultspdf", ""],
    ["Results.pdf~", ""],
    ["Results.pdf\nA", ""],
    ["archive.tar.gz", ""],
    ["notes.c", ""],
    ["Scan 3.5 notes", ""],
    ["Visit 10.30am", ""],
    ["Mr.Jones", ""],
    ["字字", ""],
    ["photo.jpg", ""],
    ["Results.txt", ""],
    [".notes.pdf", ".pdf"],
    ["..pdf", ".pdf"],
    ["Results.pdf ", ""],
    // Nearly ".pdf" is not ".pdf".
    ["Results.pdx", ""],
    ["Results.pd", ""],
    ["Results.pxf", ""],
    ["Results.xdf", ""],
    ["Results.df", ""],
    ["Results.pf", ""],
    ["Results.pdff", ""],
  ])("gives %j the extension %j", (name, extension) => {
    expect(fileExtension(name)).toBe(extension);
  });
});
