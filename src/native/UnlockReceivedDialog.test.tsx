import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UnlockReceivedDialog } from "./UnlockReceivedDialog";

function renderDialog(
  overrides: Partial<Parameters<typeof UnlockReceivedDialog>[0]> = {},
) {
  const props = {
    name: "FAKE_Locked.pdf",
    wrongTries: 0,
    busy: false,
    onUnlock: vi.fn(),
    onNotNow: vi.fn(),
    ...overrides,
  };
  return { ...props, ...render(<UnlockReceivedDialog {...props} />) };
}

describe("the password prompt for a locked shared file", () => {
  it("says what is asked for and that only the unlocked copy is kept", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", {
      name: "Unlock FAKE_Locked.pdf",
    });
    expect(dialog).toHaveAccessibleDescription(
      /document password from your patient portal\. myCarlos keeps only the unlocked copy, never the password\./,
    );
    expect(screen.getByLabelText("Document password")).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Unlock and add" }),
    ).toBeDisabled();
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
    const { rerender, onUnlock, onNotNow } = renderDialog({ wrongTries: 1 });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That password did not open the document.");
    expect(screen.getByLabelText("Document password")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    rerender(
      <UnlockReceivedDialog
        name="FAKE_Locked.pdf"
        wrongTries={2}
        busy={false}
        onUnlock={onUnlock}
        onNotNow={onNotNow}
      />,
    );
    // A new element, so that a screen reader reads it out again.
    expect(screen.getByRole("alert")).not.toBe(alert);
  });

  it("leaves the file for later with Not now or Escape, but not while unlocking", async () => {
    const user = userEvent.setup();
    const { onNotNow, rerender, onUnlock } = renderDialog();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(onNotNow).toHaveBeenCalledTimes(2);
    rerender(
      <UnlockReceivedDialog
        name="FAKE_Locked.pdf"
        wrongTries={0}
        busy={true}
        onUnlock={onUnlock}
        onNotNow={onNotNow}
      />,
    );
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlocking…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onNotNow).toHaveBeenCalledTimes(2);
  });
});
