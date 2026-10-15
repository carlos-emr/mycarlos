import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReceivedFiles } from "./ReceivedFiles";
import type { ReceivedFile } from "../vault";

const LABEL = "Manual import — unverified";
const files: ReceivedFile[] = [
  { id: "shared-1", name: "FAKE_Bloodwork.pdf", sourceLabel: LABEL },
  { id: "shared-2", name: "FAKE_Notes.pdf", sourceLabel: LABEL },
  { id: "shared-3", name: "FAKE_Xray.pdf", sourceLabel: LABEL },
];

function renderPanel(
  overrides: Partial<Parameters<typeof ReceivedFiles>[0]> = {},
) {
  const props = {
    files,
    destination: "Jamie's records, folder FAKE Labs",
    notPdfId: null,
    disabled: false,
    onAdd: vi.fn(),
    onDecline: vi.fn(),
    ...overrides,
  };
  const view = render(<ReceivedFiles {...props} />);
  return { ...props, ...view };
}

describe("shared files waiting", () => {
  it("shows nothing when nothing is waiting", () => {
    const { container } = renderPanel({ files: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each file with the label it will carry, and where it will go", () => {
    renderPanel();
    const panel = screen.getByRole("region", { name: "Shared with myCarlos" });
    expect(within(panel).getAllByText(LABEL)).toHaveLength(3);
    expect(
      within(panel).getByText(
        "Adds to Jamie's records, folder FAKE Labs. To add them elsewhere, open that person or folder first.",
      ),
    ).toBeVisible();
    for (const box of within(panel).getAllByRole("checkbox"))
      expect(box).toBeChecked();
  });

  it("adds only the files left ticked", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPanel();
    await user.click(screen.getByRole("checkbox", { name: "FAKE_Notes.pdf" }));
    await user.click(screen.getByRole("button", { name: "Add 2 files" }));
    expect(onAdd).toHaveBeenCalledWith(["shared-1", "shared-3"]);
  });

  it("declines only after the patient confirms", async () => {
    const user = userEvent.setup();
    const { onDecline } = renderPanel();
    await user.click(screen.getByRole("button", { name: "Decline 3 files" }));
    const dialog = screen.getByRole("alertdialog", {
      name: "Decline 3 files?",
    });
    // Each file is named, so the patient sees which ones are forgotten.
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["FAKE_Bloodwork.pdf", "FAKE_Notes.pdf", "FAKE_Xray.pdf"]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDecline).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Decline 3 files" }));
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledWith([
      "shared-1",
      "shared-2",
      "shared-3",
    ]);
  });

  it("marks a file refused as not a PDF and leaves it unticked", async () => {
    const user = userEvent.setup();
    const { onAdd } = renderPanel({ notPdfId: "shared-2" });
    expect(screen.getByText("Not a PDF document")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "FAKE_Notes.pdf" }),
    ).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Add 2 files" }));
    expect(onAdd).toHaveBeenCalledWith(["shared-1", "shared-3"]);
  });

  it("declines the refused file from its own button, naming it", async () => {
    const user = userEvent.setup();
    const { onDecline } = renderPanel({ notPdfId: "shared-2" });
    // The ticked files are the good ones: the bulk button names them.
    await user.click(screen.getByRole("button", { name: "Decline 2 files" }));
    expect(
      within(screen.getByRole("alertdialog", { name: "Decline 2 files?" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["FAKE_Bloodwork.pdf", "FAKE_Xray.pdf"]);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDecline).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Decline FAKE_Notes.pdf" }),
    );
    const dialog = screen.getByRole("alertdialog", {
      name: "Decline FAKE_Notes.pdf?",
    });
    expect(within(dialog).queryByRole("list")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Decline" }));
    expect(onDecline).toHaveBeenCalledWith(["shared-2"]);
  });

  it("does nothing while another operation runs", () => {
    renderPanel({ disabled: true });
    expect(screen.getByRole("button", { name: "Add 3 files" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Decline 3 files" }),
    ).toBeDisabled();
  });
});
