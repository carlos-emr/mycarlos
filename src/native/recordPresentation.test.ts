import { humanValue } from "../test/humanText";
import { getLocale } from "../i18n";
import { describe, expect, it } from "vitest";
import {
  fileExtension,
  formatBytes,
  formatFileSize,
  nameIsShared,
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
    // A photo from the camera, or another JPEG, before any word in its name.
    ["Photo, 17 Oct 2026, 3.05 PM.jpg", "Photo"],
    ["Lab results.JPEG", "Photo"],
    ["scan.jpeg ", "Photo"],
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
    expect(formatBytes(1023)).toBe(
      `${new Intl.NumberFormat(getLocale()).format(1023)} B`,
    );
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

describe("nameIsShared", () => {
  // The same names the vault refuses (vault.rs,
  // no_person_takes_the_shared_folders_name_in_any_language).
  it("refuses Shared with me as any language shows it (#61)", () => {
    for (const name of [
      " shared WITH me ",
      " PARTAGÉS avec moi ",
      "Partage\u0301s avec moi",
      "compartido CONMIGO",
      "UDOSTĘPNIONE MI",
      "compartilhados comigo",
    ])
      expect(nameIsShared(name), name).toBe(true);
  });
  it("refuses it however its spaces and letters are typed, as the vault does", () => {
    // The same cases as ui_text.rs, so both sides agree.
    for (const name of [
      "Shared  with me",
      "Shared\u00a0with me",
      "Shared\u3000with\u2003me",
      "\ufeffShared with me\u0085",
      "\uff33\uff48\uff41\uff52\uff45\uff44 with me",
      "\t PARTAGÉS\u202favec moi \n",
    ])
      expect(nameIsShared(name), JSON.stringify(name)).toBe(true);
    for (const name of [
      "Sharedwith me",
      "Shared with me 2",
      "Shared \u200bwith me",
    ])
      expect(nameIsShared(name), JSON.stringify(name)).toBe(false);
  });
  it("lets a name that only holds it, or differs by a letter, be a person's", () => {
    for (const name of ["Partagés avec moi 2", "Compartido", "Udostępnione mu"])
      expect(nameIsShared(name), name).toBe(false);
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

describe("formatFileSize", () => {
  it("counts as the platform's file app does, with the exact bytes", () => {
    // Android Files, macOS Finder and Linux file managers count in 1000s.
    expect(humanValue(formatFileSize(600_000, false))).toBe(
      humanValue(`600 kB, ${(600000).toLocaleString()} bytes`),
    );
    expect(humanValue(formatFileSize(2_500_000, false))).toBe(
      humanValue(`2.5 MB, ${(2500000).toLocaleString()} bytes`),
    );
    // Windows Explorer counts in 1024s.
    expect(humanValue(formatFileSize(600_000, true))).toBe(
      humanValue(`586 KB, ${(600000).toLocaleString()} bytes`),
    );
    // An empty or tiny file shows only its bytes.
    expect(humanValue(formatFileSize(0, false))).toBe(humanValue("0 bytes"));
    expect(humanValue(formatFileSize(999, true))).toBe(humanValue("999 bytes"));
  });
});
