import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import App from "./App";
import type { PlatformBridge } from "./platform";

function bridge(overrides: Partial<PlatformBridge> = {}): PlatformBridge {
  return {
    getRuntimeInfo: vi.fn().mockResolvedValue({
      platform: "test-os",
      architecture: "test-arch",
      appVersion: "0.1.0",
      message: "Hello from test Rust",
      native: true,
    }),
    selectPdf: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function listedDocumentTitles(): string[] {
  return Array.from(
    document.querySelectorAll(".filelist .record-open"),
    (button) => button.textContent ?? "",
  );
}

describe("myCarlos Tauri evaluation", () => {
  it("shows the mock-aligned record library and native runtime information", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
    expect(screen.getByText("Heart & blood pressure")).toBeVisible();
    expect(
      screen.getByText("Bloodwork — cholesterol and liver panel"),
    ).toBeVisible();
    expect(screen.getByText("Technology evaluation only")).toBeVisible();

    await user.click(screen.getByText("Evaluation details"));
    expect(await screen.findByText("Hello from test Rust")).toBeVisible();
    expect(screen.getByText("test-os")).toBeVisible();
  });

  it("adds selected PDF metadata for this session", async () => {
    const user = userEvent.setup();
    render(
      <App
        bridge={bridge({
          selectPdf: vi.fn().mockResolvedValue({
            name: "fictional-record.pdf",
            sizeBytes: 2048,
          }),
        })}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "New document — choose a sample PDF",
      }),
    );

    expect(await screen.findByText("fictional-record.pdf")).toBeVisible();
    expect(
      screen.getByText("fictional-record.pdf was added for this session only."),
    ).toBeVisible();
    expect(screen.getByText("2 KB · PDF · session only")).toBeVisible();
  });

  it("creates and resets session-only library items", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: "New folder" }));
    expect(screen.getByText("New sample folder 1")).toBeVisible();

    await user.click(screen.getByText("Evaluation details"));
    const reset = screen.getByRole("button", { name: "Reset session" });
    expect(reset).toBeEnabled();
    await user.click(reset);

    expect(screen.queryByText("New sample folder 1")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Evaluation reset. Only the built-in sample records are shown.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("3 folders · 5 documents · sample data"),
    ).toBeVisible();
  });

  it("can reset a Recent list that opening a document reordered", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: "Recent" }));
    const recentBefore = listedDocumentTitles();
    expect(recentBefore[0]).not.toBe("Prescription — ramipril 5mg");
    await user.click(screen.getByRole("button", { name: "My records" }));
    // Opening a document moves it to the top of Recent and changes nothing else.
    await user.click(
      screen.getByRole("button", {
        name: "More options for Prescription — ramipril 5mg",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Close document preview" }),
    );

    await user.click(screen.getByText("Evaluation details"));
    const reset = screen.getByRole("button", { name: "Reset session" });
    expect(reset).toBeEnabled();
    await user.click(reset);

    await user.click(screen.getByRole("button", { name: "Recent" }));
    expect(listedDocumentTitles()).toEqual(recentBefore);
  });

  it("sorts records newest first or by name", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    const sort = screen.getByRole("combobox", { name: "Sort records" });
    expect(sort).toHaveValue("newest");
    expect(listedDocumentTitles()).toEqual([
      "Specialist letter — cardiology",
      "Bloodwork — cholesterol and liver panel",
      "Chest X-ray report",
      "Prescription — ramipril 5mg",
      "Letter from physio (photo)",
    ]);

    await user.selectOptions(sort, "name");
    expect(listedDocumentTitles()).toEqual([
      "Bloodwork — cholesterol and liver panel",
      "Chest X-ray report",
      "Letter from physio (photo)",
      "Prescription — ramipril 5mg",
      "Specialist letter — cardiology",
    ]);
  });

  it("does not offer selection on folders, which have no record actions", () => {
    render(<App bridge={bridge()} />);

    expect(screen.getByText("Heart & blood pressure")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Select Heart & blood pressure" }),
    ).not.toBeInTheDocument();
  });

  it("shows every record when the section picker returns to My records", async ({
    onTestFinished,
  }) => {
    // The section picker replaces the sidebar only on narrow screens.
    await page.viewport(390, 844);
    onTestFinished(() => page.viewport(1100, 760));
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(
      within(screen.getByLabelText("Filter records")).getByRole("button", {
        name: "Imaging",
      }),
    );
    const picker = screen.getByRole("combobox", { name: "Section" });
    await user.selectOptions(picker, "recent");
    await user.selectOptions(picker, "records");

    expect(screen.getByText("Specialist letter — cardiology")).toBeVisible();
    expect(
      within(screen.getByLabelText("Filter records")).getByRole("button", {
        name: "All",
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("searches, filters, and switches record views", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.type(
      screen.getByRole("searchbox", { name: "Search your records" }),
      "cardiology",
    );
    expect(screen.getByText("Specialist letter — cardiology")).toBeVisible();
    expect(screen.queryByText("Chest X-ray report")).not.toBeInTheDocument();

    await user.clear(
      screen.getByRole("searchbox", { name: "Search your records" }),
    );
    await user.click(
      within(screen.getByLabelText("Filter records")).getByRole("button", {
        name: "Imaging",
      }),
    );
    expect(screen.getByText("Chest X-ray report")).toBeVisible();
    expect(
      screen.queryByText("Specialist letter — cardiology"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("demonstrates recent, starred, and prescription views", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: "Recent" }));
    expect(screen.getByRole("heading", { name: "Recent" })).toBeVisible();
    expect(
      screen.getByText("Records you recently opened or added"),
    ).toBeVisible();
    expect(
      screen.queryByText("Heart & blood pressure"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Starred/ }));
    expect(screen.getByRole("heading", { name: "Starred" })).toBeVisible();
    expect(screen.getByText("Chest X-ray report")).toBeVisible();
    expect(
      screen.queryByText("Prescription — ramipril 5mg"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Prescriptions/ }));
    expect(screen.getByRole("heading", { name: "My records" })).toBeVisible();
    expect(screen.getByText("Prescription — ramipril 5mg")).toBeVisible();
    expect(
      screen.queryByText("Bloodwork — cholesterol and liver panel"),
    ).not.toBeInTheDocument();
  });

  it("opens, stars, deletes, and restores a document across library sections", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(
      screen.getByRole("button", {
        name: "More options for Prescription — ramipril 5mg",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Prescription — ramipril 5mg" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Preview placeholder — this evaluation does not read the selected file.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add to Starred" }));
    await user.click(
      screen.getByRole("button", { name: "Close document preview" }),
    );
    await user.click(screen.getByRole("button", { name: /Starred/ }));
    expect(screen.getByText("Prescription — ramipril 5mg")).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "More options for Prescription — ramipril 5mg",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(
      screen.queryByText("Prescription — ramipril 5mg"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Trash/ }));
    expect(screen.getByText("Prescription — ramipril 5mg")).toBeVisible();
    expect(screen.getByText("Gone in 30 days")).toBeVisible();
    await user.click(
      within(
        screen.getByText("Prescription — ramipril 5mg").closest("article")!,
      ).getByRole("button", { name: "Restore" }),
    );
    expect(
      screen.getByText(
        "Prescription — ramipril 5mg was restored to My records.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "My records" }));
    expect(screen.getByText("Prescription — ramipril 5mg")).toBeVisible();
  });

  it("applies bulk star and trash actions to selected documents", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(
      screen.getByRole("button", {
        name: "Select Prescription — ramipril 5mg",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Star" }));
    await user.click(screen.getByRole("button", { name: /Starred/ }));
    expect(screen.getByText("Prescription — ramipril 5mg")).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "Select Prescription — ramipril 5mg",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(
      screen.queryByText("Prescription — ramipril 5mg"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Prescription — ramipril 5mg was moved to Trash."),
    ).toBeVisible();
  });

  it("drops a document from the selection once it is no longer shown", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);
    const title = "Specialist letter — cardiology";

    await user.click(screen.getByRole("button", { name: /Starred/ }));
    await user.click(screen.getByRole("button", { name: `Select ${title}` }));
    expect(screen.getByText("1 selected")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: `More options for ${title}` }),
    );
    await user.click(screen.getByRole("button", { name: "Remove star" }));
    await user.click(
      screen.getByRole("button", { name: "Close document preview" }),
    );
    expect(screen.queryByText(title)).not.toBeInTheDocument();
    // No bulk action can reach a document the list no longer shows.
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Trash" }),
    ).not.toBeInTheDocument();
  });

  it("demonstrates recoverable deletion in trash", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: /Trash/ }));
    expect(screen.getByRole("heading", { name: "Trash" })).toBeVisible();
    expect(screen.getByText("Bloodwork — thyroid")).toBeVisible();
    expect(screen.getByText("Gone in 27 days")).toBeVisible();

    await user.click(screen.getAllByRole("button", { name: "Restore" })[0]);
    expect(screen.queryByText("Bloodwork — thyroid")).not.toBeInTheDocument();
    expect(
      screen.getByText("Bloodwork — thyroid was restored to My records."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Empty trash" }));
    expect(screen.getByText("Trash is empty")).toBeVisible();
  });

  it("restores a deleted folder as a folder, not as a document", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: /Trash/ }));
    const scans = screen.getByText("Scans to sort out").closest("article");
    expect(scans).not.toBeNull();
    await user.click(
      within(scans as HTMLElement).getByRole("button", { name: "Restore" }),
    );

    await user.click(screen.getByRole("button", { name: "My records" }));
    expect(
      screen.getByText("4 folders · 5 documents · sample data"),
    ).toBeVisible();
    expect(screen.getByText("Scans to sort out")).toBeVisible();
    expect(listedDocumentTitles()).not.toContain("Scans to sort out");
  });

  it("demonstrates security and backup controls without creating security material", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: "Security & backup" }));
    expect(
      screen.getByRole("heading", { name: "Security & backup" }),
    ).toBeVisible();
    expect(screen.getByText("Evaluation controls only.")).toBeVisible();

    const cloudBackup = screen.getByRole("button", {
      name: "Preview device backup exclusion",
    });
    expect(cloudBackup).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(/This switch changes only this preview/),
    ).toHaveTextContent(
      /Android app disables system cloud backup and phone-to-phone transfer.*iPhone and iPad.*exclude its data folder.*Computer backups may include the encrypted vault/,
    );
    await user.click(cloudBackup);
    expect(cloudBackup).toHaveAttribute("aria-pressed", "false");

    expect(
      screen.getByRole("combobox", { name: "Automatic lock delay" }),
    ).toHaveValue("5 minutes");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Automatic lock delay" }),
      "1 minute",
    );
    expect(
      screen.getByRole("combobox", { name: "Automatic lock delay" }),
    ).toHaveValue("1 minute");

    await user.click(screen.getByRole("button", { name: "Preview sheet" }));
    expect(
      screen.getByText(/no security material was created or changed/i),
    ).toBeVisible();
  });

  it("demonstrates the mobile health-data concept with synthetic readings", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(screen.getByRole("button", { name: "Health data" }));
    expect(screen.getByRole("heading", { name: "Health data" })).toBeVisible();
    expect(screen.getByText("Concept only — mobile devices.")).toBeVisible();
    expect(screen.getByText("Nothing connected")).toBeVisible();

    await user.click(
      screen.getAllByRole("button", { name: "Connect demo" })[0],
    );
    expect(
      screen.getByRole("heading", { name: "Sample health snapshot" }),
    ).toBeVisible();
    expect(screen.getByText("122/78")).toBeVisible();
    expect(screen.getByText("Demo connected")).toBeVisible();
  });

  it("handles picker cancellation without changing the library", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);

    await user.click(
      screen.getByRole("button", {
        name: "New document — choose a sample PDF",
      }),
    );

    expect(
      await screen.findByText("No file selected. Nothing changed."),
    ).toBeVisible();
    expect(
      screen.getByText("3 folders · 5 documents · sample data"),
    ).toBeVisible();
  });

  it("rejects a non-PDF returned by the platform boundary", async () => {
    const user = userEvent.setup();
    render(
      <App
        bridge={bridge({
          selectPdf: vi.fn().mockResolvedValue({ name: "not-a-record.txt" }),
        })}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "New document — choose a sample PDF",
      }),
    );

    expect(
      await screen.findByText("This evaluation accepts PDF files only."),
    ).toBeVisible();
    expect(screen.queryByText("not-a-record.txt")).not.toBeInTheDocument();
  });

  it("reports platform failures without exposing details", async () => {
    const user = userEvent.setup();
    render(
      <App
        bridge={bridge({
          getRuntimeInfo: vi
            .fn()
            .mockRejectedValue(new Error("sensitive internal detail")),
          selectPdf: vi
            .fn()
            .mockRejectedValue(new Error("/private/example.pdf")),
        })}
      />,
    );

    await user.click(screen.getByText("Evaluation details"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The runtime information command was unavailable.",
    );
    expect(
      screen.queryByText(/sensitive internal detail/),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "New document — choose a sample PDF",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          "The file picker could not be opened. No file was accessed.",
        ),
      ).toBeVisible(),
    );
    expect(screen.queryByText(/private\/example/)).not.toBeInTheDocument();
  });
});

describe("the evaluation preview's remaining controls", () => {
  const FILTERED = ["Test results", "Letters", "Imaging"] as const;

  it.each(FILTERED)(
    "filters the library by %s from the side list, and shows it as chosen",
    async (kind) => {
      const user = userEvent.setup();
      render(<App bridge={bridge()} />);
      // The side list's button, not the filter chip of the same name above the records.
      const chips = screen.getByLabelText("Filter records");
      const side = (name: string) =>
        screen
          .getAllByRole("button", { name: new RegExp(`^${name}`) })
          .find((button) => !chips.contains(button))!;
      const before = listedDocumentTitles();
      await user.click(side(kind));
      expect(side(kind)).toHaveClass("selected");
      // Only what that kind holds is listed, and it is fewer than everything.
      const shown = listedDocumentTitles();
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.length).toBeLessThan(before.length);
      for (const other of FILTERED.filter((name) => name !== kind))
        expect(side(other)).not.toHaveClass("selected");
    },
  );

  it("applies Star and Trash to several selected documents at once, and Clear drops the selection", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);
    const first = "Prescription — ramipril 5mg";
    const second = "Chest X-ray report";
    const select = (title: string) =>
      user.click(screen.getByRole("button", { name: `Select ${title}` }));

    await select(first);
    await select(second);
    expect(screen.getByText("2 selected")).toBeVisible();
    // Selecting the second again takes it out.
    await select(second);
    expect(screen.getByText("1 selected")).toBeVisible();
    await select(second);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();

    await select(first);
    await select(second);
    await user.click(screen.getByRole("button", { name: "Star" }));
    expect(screen.getByText("2 documents added to Starred.")).toBeVisible();
    expect(screen.queryByText("2 selected")).not.toBeInTheDocument();

    await select(first);
    await select(second);
    await user.click(screen.getByRole("button", { name: "Trash" }));
    expect(screen.getByText("2 documents were moved to Trash.")).toBeVisible();
    expect(screen.queryByText(first)).not.toBeInTheDocument();
    expect(screen.queryByText(second)).not.toBeInTheDocument();
  });

  it("shows folders and documents as tiles in the grid, opens one, and closes it with a press outside", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);
    await user.click(screen.getByRole("button", { name: "Grid view" }));
    const grid = screen.getByLabelText(/visible library items/);
    // A folder is a tile with no record actions.
    expect(within(grid).getByText("Heart & blood pressure")).toBeVisible();
    expect(
      within(grid).queryByRole("button", { name: /Heart & blood pressure/ }),
    ).toBeNull();
    // A document tile opens its preview; a press on the backdrop closes it.
    await user.click(
      within(grid).getByRole("button", { name: /Prescription — ramipril 5mg/ }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeVisible();
    const backdrop = dialog.parentElement!;
    await user.pointer({ keys: "[MouseLeft]", target: backdrop });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Back to the list.
    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Grid view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("opens a document from its name in the list, and Escape closes the preview", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);
    await user.click(
      screen.getByRole("button", { name: "Prescription — ramipril 5mg" }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says no records match, in the list and in the grid", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);
    await user.type(
      screen.getByRole("searchbox", { name: "Search your records" }),
      "no such record",
    );
    expect(screen.getByText("No matching records")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Grid view" }));
    expect(screen.getByText("No matching records")).toBeVisible();
    expect(screen.getByLabelText(/visible library items/)).toHaveAccessibleName(
      "0 visible library items",
    );
  });

  it("shows a file that arrives with no size as just a PDF", async () => {
    const user = userEvent.setup();
    render(
      <App
        bridge={bridge({
          selectPdf: vi.fn().mockResolvedValue({ name: "no-size.pdf" }),
        })}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "New document — choose a sample PDF",
      }),
    );
    expect(await screen.findByText("PDF · session only")).toBeVisible();
  });

  it("flips the backup, biometric and Health Connect demos both ways, and says what a passphrase change would be", async () => {
    const user = userEvent.setup();
    render(<App bridge={bridge()} />);
    await user.click(screen.getByRole("button", { name: "Security & backup" }));
    for (const name of ["Backup to a folder demo", "Biometric unlock demo"]) {
      const toggle = screen.getByRole("button", { name });
      const before = toggle.getAttribute("aria-pressed");
      await user.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).not.toBe(before);
      await user.click(toggle);
      expect(toggle.getAttribute("aria-pressed")).toBe(before);
    }
    await user.click(screen.getByRole("button", { name: "Show purpose" }));
    expect(
      screen.getByText(
        "Passphrase change is demonstrated visually; no security material was created or changed.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Health data" }));
    const connect = screen.getAllByRole("button", { name: "Connect demo" });
    await user.click(connect[connect.length - 1]);
    expect(screen.getByText("Demo connected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Disconnect demo" }));
    expect(
      screen.queryByRole("button", { name: "Disconnect demo" }),
    ).toBeNull();
  });

  it("names the bridge as the browser preview when there is no native runtime", async () => {
    const user = userEvent.setup();
    render(
      <App
        bridge={bridge({
          getRuntimeInfo: vi.fn().mockResolvedValue({
            platform: "test-os",
            architecture: "test-arch",
            appVersion: "0.1.0",
            message: "Hello from the browser",
            native: false,
          }),
        })}
      />,
    );
    await user.click(screen.getByText("Evaluation details"));
    expect(await screen.findByText("Browser preview")).toBeVisible();
  });
});
