import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RenameDialog } from "./RenameDialog";

const HELP = "This changes the name in myCarlos and the suggested export name.";
const UNSAFE =
  'Document names cannot contain < > : " | ? * / \\ or invisible control characters, or end with a dot.';
const GAINS =
  "This document's name has no .pdf extension, so it cannot end in .pdf.";
const TOO_LONG = "This name is too long. Shorten it to save.";
const reserved = (word: string) =>
  `"${word}" cannot be used as a document name, because Windows keeps it for its own use. Choose another name.`;
const cp = (codePoint: number) => String.fromCodePoint(codePoint);

// Renders the dialog for a stored name and returns what a test needs.
function open(name: string, kind: "document" | "folder" = "document") {
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(
    <RenameDialog
      target={{ kind, id: "target-1", name }}
      readOnly={false}
      onSave={onSave}
      onClose={vi.fn()}
    />,
  );
  const input = screen.getByLabelText<HTMLInputElement>(
    kind === "folder" ? "Folder name" : "File name",
  );
  return {
    input,
    onSave,
    save: screen.getByRole("button", { name: "Save name" }),
    type: (value: string) => fireEvent.change(input, { target: { value } }),
    submit: () => fireEvent.submit(input.closest("form")!),
  };
}

describe("RenameDialog", () => {
  it.each([
    // stored name, field value, extension shown beside it
    ["Results.pdf", "Results", ".pdf"],
    ["Scan.PDF", "Scan", ".PDF"],
    // An earlier build could store a Unicode space after ".pdf"; the vault
    // judges the trimmed name, so this is a PDF.
    ["X.pdf ", "X", ".pdf"],
    ["Report.pdf.pdf", "Report.pdf", ".pdf"],
    // Only ".pdf" is an extension; anything else is opened whole, as stored.
    ["Scan 3.5 notes", "Scan 3.5 notes", ""],
    ["photo.jpg", "photo.jpg", ""],
    ["Notes ", "Notes ", ""],
  ])("opens %j as %j with %j kept", (stored, value, extension) => {
    const { input } = open(stored);
    expect(input).toHaveValue(value);
    if (extension) {
      // Shown beside the field but not announced: the help text names it.
      const shown = screen.getByText(extension, { exact: true });
      expect(shown).toBeVisible();
      expect(shown).toHaveAttribute("aria-hidden", "true");
      expect(input).toHaveAccessibleDescription(
        `${HELP} The ${extension} extension stays the same.`,
      );
    } else {
      expect(screen.queryByText(/^\.\w+$/)).not.toBeInTheDocument();
      expect(input).toHaveAccessibleDescription(HELP);
    }
  });

  it.each([
    // Left untouched, a name is saved exactly as stored, even one that trimming
    // or dropping a typed extension would otherwise change.
    ["Results .pdf"],
    ["X.pdf "],
    [".pdf .pdf"],
  ])("saves an unedited %j exactly as stored", (stored) => {
    const { onSave, submit } = open(stored);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    submit();
    expect(onSave).toHaveBeenCalledWith(stored);
  });

  const exact = `${"字".repeat(78)}ab`; // 236 bytes; 240 with ".pdf"
  it.each([
    // stored name, typed, saved
    ["Results.pdf", "  Lab results  ", "Lab results.pdf"],
    // A typed copy of the extension is not doubled, and keeps the stored case.
    ["Results.pdf", "Lab report.PDF", "Lab report.pdf"],
    ["Results.pdf", "Lab report .pdf", "Lab report.pdf"],
    ["Scan.PDF", "New.pdf", "New.PDF"],
    ["Results.pdf", `${exact}.pdf`, `${exact}.pdf`],
    // ...unless the stored name already ended with it twice.
    ["Report.pdf.pdf", "Final Report.pdf", "Final Report.pdf.pdf"],
    // Only a stem that itself ended in ".pdf" keeps a typed copy.
    ["Report.pdf .pdf", "Lab.pdf", "Lab.pdf"],
    ["Report.pdf .pdf", "Report.pdf", "Report.pdf"],
    // Removing a stray space is an edit.
    ["Results .pdf", "Results", "Results.pdf"],
    // ".pdf" anywhere but the end is part of the name.
    ["Results.pdf", "Report.pdf notes", "Report.pdf notes.pdf"],
    ["Visit notes", "Lab.pdf notes", "Lab.pdf notes"],
    ["Scan 3.5 notes", "Scan notespdf", "Scan notespdf"],
    // Names without ".pdf" change freely, including other extensions.
    ["Scan 3.5 notes", "Scan notes", "Scan notes"],
    // Only the whole name before the first dot is reserved, and only these.
    ["Results.pdf", "CONSOLE", "CONSOLE.pdf"],
    ["Results.pdf", "My CON", "My CON.pdf"],
    ["Results.pdf", "COM10", "COM10.pdf"],
    ["Results.pdf", `COM${cp(0x2074)}`, `COM${cp(0x2074)}.pdf`],
    ["Results.pdf", "Lab.CON", "Lab.CON.pdf"],
    // Only ordinary spaces before the dot are ignored, as by the vault.
    ["Visit notes", `CON${cp(0xa0)}.txt`, `CON${cp(0xa0)}.txt`],
    ["Visit notes", `NUL${cp(0x3000)}.log`, `NUL${cp(0x3000)}.log`],
    // Case is compared for ASCII letters only, as the vault does: a dotless ı
    // is not an I.
    ["Results.pdf", `con${cp(0x131)}n$`, `con${cp(0x131)}n$.pdf`],
    ["photo.jpg", "photo", "photo"],
    // With ".pdf" kept, a name part ending in a dot is still a valid name.
    ["Results.pdf", "Visit notes.", "Visit notes..pdf"],
    // Typed names are trimmed as the vault trims them (U+0085 included), and
    // only at the ends.
    ["Results.pdf", "\u0085Lab", "Lab.pdf"],
    ["Visit notes", "Lab\u0085", "Lab"],
    ["Visit notes", "\u0085Lab", "Lab"],
    ["Results.pdf", "Lab\u0085.pdf", "Lab.pdf"],
    ["Results.pdf", "Lab report\t", "Lab report.pdf"],
    ["Results.pdf", "Lab   report", "Lab   report.pdf"],
    // Ordinary punctuation and a soft hyphen are allowed.
    [
      "Results.pdf",
      "Lab #1; (A+B) = 50% & 'x' ~ @ ! $ ^ , {0} [9]",
      "Lab #1; (A+B) = 50% & 'x' ~ @ ! $ ^ , {0} [9].pdf",
    ],
    ["Results.pdf", "Lab­report", "Lab­report.pdf"],
    // Characters just outside each refused range, which the vault accepts.
    ...[
      0x061b, 0x061d, 0x200a, 0x2010, 0x2028, 0x2029, 0x202f, 0x2065, 0x206a,
      0xfefe, 0xff00,
    ].map((c) => ["Results.pdf", `Lab${cp(c)}report`, `Lab${cp(c)}report.pdf`]),
  ])("renames %j, typed %j, to %j", (stored, typed, saved) => {
    const { onSave, save, type, submit } = open(stored);
    type(typed);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toBeEnabled();
    submit();
    expect(onSave).toHaveBeenCalledWith(saved);
  });

  it.each([
    // stored name, typed, alert ("" for none: Save is only disabled)
    ["Results.pdf", "   ", ""],
    ["Scan notes", "\u0085", ""],
    // Only the extension is not a name; say so rather than just disabling Save.
    ["Results.pdf", ".pdf", "Enter a name before .pdf."],
    ["Results.pdf", " .PDF ", "Enter a name before .pdf."],
    ["Results.pdf", "\u0085", "Enter a name before .pdf."],
    ["Scan.PDF", ".PDF", "Enter a name before .PDF."],
    // A name without ".pdf" cannot gain it, just as a PDF cannot lose it.
    ["Scan 3.5 notes", "Scan notes.PDF", GAINS],
    ["Scan 3.5 notes", "Scan notes.pdf ", GAINS],
    ["Scan 3.5 notes", ".pdf", GAINS],
    ["Visit 11am", "Scan.pdf\u0085", GAINS],
    // The kept ".pdf" counts toward the byte limit: 237 bytes, 241 with it.
    ["Results.pdf", "字".repeat(79), TOO_LONG],
    // With no extension to keep, the name itself must not end with a dot.
    ["Scan 3.5 notes", "Notes.", UNSAFE],
    // Characters a file name cannot hold on every platform...
    ...["<", ">", '"', "|", "*", ":", "?", "/", "\\"].map((c) => [
      "Results.pdf",
      `a${c}b`,
      UNSAFE,
    ]),
    // ...and invisible ones the vault refuses or strips (and so refuses).
    ...[
      0x0000, 0x0007, 0x007f, 0x0080, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e,
      0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
      0x2069, 0xfeff,
    ].map((c) => ["Results.pdf", `Lab${cp(c)}report`, UNSAFE]),
  ])("refuses %j, typed %j: %j", (stored, typed, alert) => {
    const { onSave, save, type, submit } = open(stored);
    type(typed);
    if (alert) expect(screen.getByRole("alert")).toHaveTextContent(alert);
    else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toBeDisabled();
    submit();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([
    // Names Windows reserves for devices, in any case of ASCII letters, as the
    // part before the first dot, and with spaces before the dot.
    ...[
      ["CON", "CON"],
      ["prn", "prn"],
      ["Aux", "Aux"],
      ["NUL", "NUL"],
      ["conin$", "conin$"],
      ["CONOUT$", "CONOUT$"],
      ["COM0", "COM0"],
      ["com9", "com9"],
      ["LPT1", "LPT1"],
      [`COM${cp(0xb9)}`, `COM${cp(0xb9)}`],
      [`lpt${cp(0xb3)}`, `lpt${cp(0xb3)}`],
      ["CON.backup", "CON"],
    ].map(([typed, word]) => ["Results.pdf", typed, word]),
    ["Visit notes", "AUX .txt", "AUX"],
    ["Visit notes", "AUX   .txt", "AUX"],
    // Trimmed as the vault trims, U+0085 included.
    ["Results.pdf", "\u0085CON", "CON"],
  ])(
    "refuses %j renamed to %j when saved, naming %j",
    (stored, typed, word) => {
      const { input, onSave, save, type, submit } = open(stored);
      type(typed);
      // Not while typing: "Con" is on the way to "Consult notes".
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(save).toBeEnabled();
      submit();
      expect(screen.getByRole("alert")).toHaveTextContent(reserved(word));
      expect(onSave).not.toHaveBeenCalled();
      // Returning to the field says why it was refused.
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(input).toHaveAccessibleDescription(
        expect.stringContaining(reserved(word)),
      );
      // Editing the name clears it.
      type(`${typed}x`);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(input).not.toHaveAttribute("aria-invalid");
      expect(input).toHaveAccessibleDescription(expect.stringContaining(HELP));
    },
  );

  // A stored name with a control character such as U+0085 is refused as
  // unsafe as soon as the dialog opens, so it never reaches this check.
  it("refuses an unedited reserved name from an earlier build when saved", () => {
    const { onSave, submit } = open(" CON.pdf");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    submit();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(reserved("CON"));
    expect(onSave).not.toHaveBeenCalled();
    // Saving again says so again, for screen readers too.
    submit();
    expect(screen.getByRole("alert")).not.toBe(alert);
    expect(screen.getByRole("alert")).toHaveTextContent(reserved("CON"));
  });

  it.each([
    // Unedited names from earlier builds that the vault would refuse.
    [".pdf ", GAINS],
    ["X. ", UNSAFE],
  ])("refuses to save an unedited %j: %j", (stored, alert) => {
    const { onSave, save, submit } = open(stored);
    expect(screen.getByRole("alert")).toHaveTextContent(alert);
    expect(save).toBeDisabled();
    submit();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("limits a folder name by characters, as the vault does, not UTF-16 units", () => {
    const { input, onSave, save, type, submit } = open("Letters", "folder");
    // 120 characters is the vault's limit; each of these takes two UTF-16 units.
    const astral = "\u{1F4C1}".repeat(120);
    type(astral);
    expect(input).toHaveValue(astral);
    // The input itself must not cut such a name short while it is typed.
    expect(input.maxLength).toBeGreaterThanOrEqual(astral.length);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toBeEnabled();

    type("a".repeat(121));
    expect(screen.getByRole("alert")).toHaveTextContent(TOO_LONG);
    expect(save).toBeDisabled();
    submit();
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each([
    // Folder names are never file names: no extension lock, no file-name rules.
    ["Scans.pdf", "Old scans.pdf"],
    ["Labs", "Labs: 2024"],
    ["Labs", "CON"],
  ])("renames folder %j to %j", (stored, typed) => {
    const { input, onSave, type, submit } = open(stored, "folder");
    expect(input).toHaveValue(stored);
    expect(screen.queryByText(".pdf", { exact: true })).not.toBeInTheDocument();
    type(typed);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    submit();
    expect(onSave).toHaveBeenCalledWith(typed);
  });
});
