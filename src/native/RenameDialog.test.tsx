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
});
