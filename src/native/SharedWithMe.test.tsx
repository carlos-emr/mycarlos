import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReceivedFile } from "../vault";
import { SharedWithMe } from "./SharedWithMe";

const LABEL = "Manual import — unverified";
const files: ReceivedFile[] = [
  { id: "shared-1", name: "FAKE_Bloodwork.pdf", sourceLabel: LABEL },
  { id: "shared-2", name: "FAKE_Xray.pdf", sourceLabel: LABEL },
];
const profiles = [
  { id: "p1", displayName: "FAKE Jamie", createdAtMs: 1 },
  { id: "p2", displayName: "FAKE Sam", createdAtMs: 2 },
];
const folders = [
  {
    id: "f1",
    profileId: "p1",
    parentId: null,
    name: "FAKE Labs",
    createdAtMs: 1,
  },
  {
    id: "f2",
    profileId: "p2",
    parentId: null,
    name: "FAKE Imaging",
    createdAtMs: 2,
  },
];

function renderPage(
  overrides: Partial<Parameters<typeof SharedWithMe>[0]> = {},
) {
  const props = {
    files,
    profiles,
    folders,
    defaultProfileId: "p1",
    computer: false,
    notPdfId: null,
    notice: "",
    disabled: false,
    onAdd: vi.fn(),
    onDecline: vi.fn(),
    ...overrides,
  };
  const view = render(<SharedWithMe {...props} />);
  return { ...props, ...view };
}

const row = (name: string) =>
  screen.getByText(name).closest("li") as HTMLElement;

describe("Shared with me (#61)", () => {
  it("says nothing is waiting, and how a file gets here, on a phone and a computer", () => {
    const { rerender } = renderPage({ files: [] });
    expect(
      screen.getByRole("heading", { name: "Shared with me" }),
    ).toBeVisible();
    expect(screen.getByText("Nothing is waiting.")).toBeVisible();
    expect(
      screen.getByText(/choose Share in the app that has it/),
    ).toBeVisible();
    rerender(
      <SharedWithMe
        files={[]}
        profiles={profiles}
        folders={folders}
        defaultProfileId="p1"
        computer
        notPdfId={null}
        notice=""
        disabled={false}
        onAdd={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(screen.getByText(/open it with myCarlos/)).toBeVisible();
  });

  it("lists each file with where it came from and the label it will carry", () => {
    renderPage();
    expect(screen.getByText("2 files are waiting.")).toBeVisible();
    for (const name of ["FAKE_Bloodwork.pdf", "FAKE_Xray.pdf"])
      expect(row(name)).toHaveTextContent(
        `Shared from another app · will be marked "${LABEL}"`,
      );
  });

  it("adds a file to the person and folder chosen", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(
      screen.getByRole("button", { name: "Add FAKE_Bloodwork.pdf…" }),
    );
    const form = screen.getByRole("form", { name: "Add FAKE_Bloodwork.pdf" });
    const person = within(form).getByRole("combobox", {
      name: "Whose records",
    });
    // It starts at the person whose records are open, with focus there.
    expect(person).toHaveValue("p1");
    expect(person).toHaveFocus();
    const folder = within(form).getByRole("combobox", { name: "Folder" });
    expect(
      within(folder)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No folder (My records)", "FAKE Labs"]);
    // Another person: their folders, from no folder again.
    await user.selectOptions(person, "p2");
    expect(folder).toHaveValue("");
    expect(
      within(folder)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["No folder (My records)", "FAKE Imaging"]);
    await user.selectOptions(folder, "f2");
    await user.click(within(form).getByRole("button", { name: "Add" }));
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith("shared-1", "p2", "f2");
  });

  it("puts the choice away on Cancel, adding nothing", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(
      screen.getByRole("button", { name: "Add FAKE_Xray.pdf…" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it("declines a file only once the patient confirms", async () => {
    const user = userEvent.setup();
    const props = renderPage();
    await user.click(
      screen.getByRole("button", { name: "Decline FAKE_Xray.pdf" }),
    );
    expect(props.onDecline).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog", {
      name: "Decline FAKE_Xray.pdf?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Decline" }));
    expect(props.onDecline).toHaveBeenCalledExactlyOnceWith("shared-2");
  });

  it("offers only Decline for a file refused as not a PDF", () => {
    renderPage({ notPdfId: "shared-2" });
    expect(row("FAKE_Xray.pdf")).toHaveTextContent("Not a PDF document");
    expect(
      screen.queryByRole("button", { name: "Add FAKE_Xray.pdf…" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Decline FAKE_Xray.pdf" }),
    ).toBeVisible();
  });

  it("gives every button and choice a target of at least 44px", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      screen.getByRole("button", { name: "Add FAKE_Bloodwork.pdf…" }),
    );
    for (const control of [
      ...screen.getAllByRole("button"),
      ...screen.getAllByRole("combobox"),
    ])
      expect(
        control.getBoundingClientRect().height,
        control.textContent ?? "",
      ).toBeGreaterThanOrEqual(44);
  });

  it("moves focus to the heading when an added or declined file leaves", () => {
    const { rerender } = renderPage();
    screen.getByRole("button", { name: "Decline FAKE_Xray.pdf" }).focus();
    rerender(
      <SharedWithMe
        files={[files[0]]}
        profiles={profiles}
        folders={folders}
        defaultProfileId="p1"
        computer={false}
        notPdfId={null}
        notice=""
        disabled={false}
        onAdd={vi.fn()}
        onDecline={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Shared with me" }),
    ).toHaveFocus();
  });
});
