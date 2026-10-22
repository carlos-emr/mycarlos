import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnlockPdfDialog } from "./UnlockPdfDialog";

function renderDialog(
  overrides: Partial<Parameters<typeof UnlockPdfDialog>[0]> = {},
) {
  const props = {
    name: "FAKE_Locked.pdf",
    wrongTries: 0,
    busy: false,
    onUnlock: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { ...props, ...render(<UnlockPdfDialog {...props} />) };
}

describe("the password prompt for a locked PDF", () => {
  it("says what is asked for, and that the locked original is kept", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", {
      name: "Unlock FAKE_Locked.pdf",
    });
    expect(dialog).toHaveAccessibleDescription(
      /document password from your patient portal\. myCarlos adds a copy that opens without it and keeps the locked original\. It never keeps the password\./,
    );
    expect(screen.getByLabelText("Document password")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeDisabled();
  });

  it("sends the password once and empties the field", async () => {
    const user = userEvent.setup();
    const { onUnlock } = renderDialog();
    const field = screen.getByLabelText("Document password");
    await user.type(field, "FAKE-portal-2026{Enter}");
    expect(onUnlock).toHaveBeenCalledExactlyOnceWith("FAKE-portal-2026");
    expect(field).toHaveValue("");
  });

  it("says again, each time, that a password did not open it", () => {
    const { rerender, onUnlock, onCancel } = renderDialog({ wrongTries: 1 });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That password did not open the document.");
    expect(screen.getByLabelText("Document password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    rerender(
      <UnlockPdfDialog
        name="FAKE_Locked.pdf"
        wrongTries={2}
        busy={false}
        onUnlock={onUnlock}
        onCancel={onCancel}
      />,
    );
    // A new element, so that a screen reader reads it out again.
    expect(screen.getByRole("alert")).not.toBe(alert);
  });

  it("closes with Cancel or Escape, but not while unlocking", async () => {
    const user = userEvent.setup();
    const { onCancel, rerender, onUnlock } = renderDialog();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    rerender(
      <UnlockPdfDialog
        name="FAKE_Locked.pdf"
        wrongTries={0}
        busy={true}
        onUnlock={onUnlock}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlocking…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
