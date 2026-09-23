import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RenameDialog } from "./RenameDialog";

describe("RenameDialog", () => {
  it("limits a folder name by characters, as the vault does, not UTF-16 units", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "folder", id: "folder-1", name: "Letters" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Folder name");
    // 120 characters is the vault's limit; each of these takes two UTF-16 units.
    const astral = "\u{1F4C1}".repeat(120);
    fireEvent.change(input, { target: { value: astral } });
    expect(input).toHaveValue(astral);
    // The input itself must not cut such a name short while it is typed.
    expect((input as HTMLInputElement).maxLength).toBeGreaterThanOrEqual(
      astral.length,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();

    fireEvent.change(input, { target: { value: "a".repeat(121) } });
    expect(screen.getByRole("alert")).toHaveTextContent("too long");
    const save = screen.getByRole("button", { name: "Save name" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("names the characters a document name cannot contain before saving", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    const save = screen.getByRole("button", { name: "Save name" });
    for (const name of ["Visit: notes", "Results?", "a/b", "a\\b"]) {
      fireEvent.change(input, { target: { value: name } });
      expect(screen.getByRole("alert")).toHaveTextContent("cannot contain");
      expect(save).toBeDisabled();
    }
    fireEvent.submit(save.closest("form")!);
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Visit notes" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toBeEnabled();

    // With an extension kept, a name part ending in a dot is still a valid name.
    fireEvent.change(input, { target: { value: "Visit notes." } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(save).toBeEnabled();
  });

  it("edits only the name before the extension, which stays as it was", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    expect(input).toHaveValue("Results");
    // Shown beside the field but not announced: the help text names it.
    const shown = screen.getByText(".pdf", { exact: true });
    expect(shown).toBeVisible();
    expect(shown).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveAccessibleDescription(
      "This changes the name in myCarlos and the suggested export name. The .pdf extension stays the same.",
    );

    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Only the extension is not a name; say so rather than just disabling Save.
    for (const value of [".pdf", " .PDF "]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Enter a name before .pdf.",
      );
      expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "  Lab results  " } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Lab results.pdf");
  });

  it("saves the name unchanged when nothing was edited", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results .pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Results .pdf");
  });

  it("saves removing a stray space before the extension as an edit", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results .pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    fireEvent.change(input, { target: { value: "Results" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Results.pdf");
  });

  it("does not double an extension typed out of habit", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    fireEvent.change(input, { target: { value: "Lab report.PDF" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Lab report.pdf");
  });

  it("shows and names an uppercase extension as the name spells it", () => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Scan.PDF" }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(".PDF", { exact: true })).toBeVisible();
    expect(screen.getByLabelText("File name")).toHaveAccessibleDescription(
      "This changes the name in myCarlos and the suggested export name. The .PDF extension stays the same.",
    );
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: ".PDF" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a name before .PDF.",
    );
  });

  it("measures the byte limit on the name it saves, not the typed extension", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    // Typed with ".pdf" it is 244 bytes; saved, the copy is dropped: 240.
    const exact = `${"字".repeat(78)}ab`;
    fireEvent.change(input, { target: { value: `${exact}.pdf` } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith(`${exact}.pdf`);
  });

  it.each([
    ["Results.pdf", "Lab report .pdf", "Lab report.pdf"],
    ["Results.pdf", "Report.pdf notes", "Report.pdf notes.pdf"],
    ["Scan.PDF", "New.pdf", "New.PDF"],
    // Only a stem that itself ended in ".pdf" keeps a typed copy.
    ["Report.pdf .pdf", "Lab.pdf", "Lab.pdf"],
    ["Report.pdf .pdf", "Report.pdf", "Report.pdf"],
    // U+0085 at an edge is trimmed, as the vault trims it, not refused.
    ["Results.pdf", "\u0085Lab", "Lab.pdf"],
    ["Visit notes", "Lab\u0085", "Lab"],
    ["Visit notes", "\u0085Lab", "Lab"],
    // "pdf" without the dot is part of a name, and a pasted trailing tab is
    // trimmed, as the vault trims it.
    ["Scan 3.5 notes", "Scan notespdf", "Scan notespdf"],
    ["Results.pdf", "Lab report\t", "Lab report.pdf"],
    ["Results.pdf", "Lab\u0085.pdf", "Lab.pdf"],
    // A soft hyphen is not a control character; the vault accepts it.
    ["Results.pdf", "Lab\u00adreport", "Lab\u00adreport.pdf"],
  ])("renames %j from %j to %j", (original, typed, saved) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: original }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith(saved);
  });

  it("locks no extension on a folder, even one named like a PDF", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "folder", id: "folder-1", name: "Scans.pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Folder name");
    expect(input).toHaveValue("Scans.pdf");
    expect(screen.queryByText(".pdf", { exact: true })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Old scans.pdf" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Old scans.pdf");
  });

  it("keeps a doubled extension that was already part of the name", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Report.pdf.pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    expect(input).toHaveValue("Report.pdf");
    fireEvent.change(input, { target: { value: "Final Report.pdf" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Final Report.pdf.pdf");
  });

  it("treats a stored name ending in .pdf and a Unicode space as a PDF", () => {
    // Earlier builds could store this; the vault judges the trimmed name.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "X.pdf\u00a0" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    expect(input).toHaveValue("X");
    expect(screen.getByText(".pdf", { exact: true })).toBeVisible();
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("X.pdf\u00a0");
  });

  it("locks no extension other than .pdf", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "photo.jpg" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    expect(input).toHaveValue("photo.jpg");
    expect(screen.queryByText(".jpg", { exact: true })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "photo" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("photo");
  });

  it.each([
    // Pasted control characters, which the vault trims or refuses.
    ["Visit 11am", "Scan.pdf\u0085"],
    ["Results.pdf", "\u0085"],
    ["Results.pdf", "Lab\u0007report"],
    ["Results.pdf", "Lab\u007freport"],
    ["Results.pdf", "Lab\u0080report"],
    // Zero-width and direction marks, which the vault strips and so refuses.
    ["Results.pdf", "Lab\u200breport"],
    ["Results.pdf", "Lab\u202ereport"],
    ["Results.pdf", "Lab\u2066report"],
    ["Results.pdf", "Lab\u061creport"],
    ["Results.pdf", "Lab\ufeffreport"],
  ])("explains why %j cannot be renamed to %j", (original, typed) => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: original }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: typed },
    });
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it.each([
    0x0000, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b,
    0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  ])("refuses U+%s inside a name, as the vault does", (codePoint) => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: `Lab${String.fromCodePoint(codePoint)}report` },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "invisible control characters",
    );
  });

  it("opens a name without an extension exactly as it is stored", () => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Notes " }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("File name")).toHaveValue("Notes ");
  });

  it("names invisible characters in its message", () => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "Lab\u200breport" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "invisible control characters",
    );
  });

  it.each(["<", ">", '"', "|", "*", ":", "?", "/", "\\"])(
    "refuses %j in a document name with a reason",
    (character) => {
      render(
        <RenameDialog
          target={{ kind: "document", id: "record-1", name: "Results.pdf" }}
          readOnly={false}
          onSave={vi.fn().mockResolvedValue(undefined)}
          onClose={vi.fn()}
        />,
      );
      fireEvent.change(screen.getByLabelText("File name"), {
        target: { value: `a${character}b` },
      });
      expect(screen.getByRole("alert")).toHaveTextContent("cannot contain");
    },
  );

  it("does not ask for a name before an extension a document does not have", () => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Scan notes" }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "\u0085" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("saves an unedited name whose stem is .pdf and a space", () => {
    // ".pdf .pdf" is a valid stored name; left alone it must stay savable.
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: ".pdf .pdf" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith(".pdf .pdf");
  });

  it("refuses an unedited legacy name that is only .pdf and a space", () => {
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: ".pdf " }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This document's name has no .pdf extension, so it cannot end in .pdf.",
    );
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("checks an unedited legacy name for a trailing dot, as before", () => {
    // Earlier builds could store "X." followed by a no-break space.
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "X.\u00a0" }}
        readOnly={false}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("end with a dot");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("edits the whole name when it has no extension", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RenameDialog
        target={{ kind: "document", id: "record-1", name: "Scan 3.5 notes" }}
        readOnly={false}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("File name");
    expect(input).toHaveValue("Scan 3.5 notes");
    expect(input).toHaveAccessibleDescription(
      "This changes the name in myCarlos and the suggested export name.",
    );
    // With no extension to keep, the name itself must not end with a dot.
    fireEvent.change(input, { target: { value: "Notes." } });
    expect(screen.getByRole("alert")).toHaveTextContent("cannot contain");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    // A name without ".pdf" cannot gain it, just as a PDF cannot lose it,
    // even as a whole name or with a trailing space the vault trims.
    for (const value of ["Scan notes.PDF", "Scan notes.pdf ", ".pdf"]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This document's name has no .pdf extension, so it cannot end in .pdf.",
      );
      expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    }
    fireEvent.change(input, { target: { value: "Scan notes" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Scan notes");
  });
});
