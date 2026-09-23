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
    expect(input).toHaveAccessibleDescription(/\.pdf/);
    expect(input).toHaveAccessibleDescription(/stays the same/);

    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
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
    // With no extension to keep, the name itself must not end with a dot.
    fireEvent.change(input, { target: { value: "Notes." } });
    expect(screen.getByRole("alert")).toHaveTextContent("cannot contain");
    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "Scan notes" } });
    fireEvent.submit(input.closest("form")!);
    expect(onSave).toHaveBeenCalledWith("Scan notes");
  });
});
