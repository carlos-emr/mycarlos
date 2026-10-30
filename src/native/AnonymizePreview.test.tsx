import { humanText } from "../test/humanText";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AnonymizePreview } from "./AnonymizePreview";
import { joinPages, type DocumentText } from "../documentText";
import type {
  KnownIdentifiers,
  PatientProfile,
  TextSaveOutcome,
  VaultRecord,
} from "../vault";

// #72 part B. Synthetic documents and FAKE names only.
const record: VaultRecord = {
  id: "record-1",
  profileId: "profile-1",
  folderIds: [],
  displayName: "FAKE_Clinic_letter.pdf",
  sourceLabel: "Manual import — unverified",
  mediaType: "application/pdf",
  plaintextSize: 2048,
  importedAtMs: 1,
  available: true,
  verifiedClinicName: "Maplewood Family Health Team",
};
const people: PatientProfile[] = [
  {
    id: "profile-1",
    displayName: "Avery",
    createdAtMs: 1,
    fullName: "Avery Example",
    birthDate: "1961-04-17",
  },
];
const pages = [
  {
    index: 0,
    text: "Patient: Avery Example\nDOB: 1961-04-17\nSeen 2026-10-08 by Dr. Ward for chest pain.\nAdmitted to the ward on day 3. Ramipril 5 mg.",
  },
];
const documentText = (extra: Partial<DocumentText> = {}): DocumentText => ({
  pageCount: 1,
  pages,
  ...joinPages(pages),
  emptyPages: [],
  cutPages: [],
  failedPages: [],
  truncated: false,
  ticket: "FAKE-ticket-1",
  ...extra,
});
const known: KnownIdentifiers = {
  names: [],
  birthDates: [],
  doctorNames: [],
  clinicNames: [],
};
const refusal = (code: string) =>
  Object.assign(new Error(code), { code, message: `FAKE ${code}` });

function renderPreview({
  text = documentText(),
  readText = vi.fn(async (_password?: string) => text),
  saveText = vi.fn(
    async (
      _pickId: string,
      _ticket: string,
      _text: string,
    ): Promise<TextSaveOutcome> => ({
      saved: true,
      hits: [],
    }),
  ),
  pickDestination = vi.fn(async (_ticket: string) => "pick-1" as string | null),
} = {}) {
  const onClose = vi.fn();
  const cancelRead = vi.fn();
  render(
    <AnonymizePreview
      record={record}
      people={people}
      clinicNames={["Maplewood Family Health Team"]}
      readText={readText}
      cancelRead={cancelRead}
      knownDetails={async () => known}
      pickDestination={pickDestination}
      saveText={saveText}
      exportHeader="FAKE header line"
      onClose={onClose}
    />,
  );
  return { readText, saveText, pickDestination, onClose, cancelRead };
}

const shownText = () =>
  screen.getByRole("region", {
    name: humanText("The text that will be saved"),
  });
/** The text as the file would hold it: the runs and the marks, without the
 * labels read out after each mark. */
const shownString = () =>
  Array.from(shownText().childNodes)
    .map((node) =>
      node.nodeName === "MARK"
        ? (node.firstChild?.textContent ?? "")
        : (node.textContent ?? ""),
    )
    .join("");
const plain = (text: string | null) =>
  (text ?? "").replace(/[\u2068\u2069]/g, "");

describe("the anonymize preview (#72 part B)", () => {
  it("shows the text with every removal marked and named, and the fixed first line", async () => {
    renderPreview();
    const region = await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    expect(region).toHaveTextContent("Patient: [NAME 1]");
    expect(region).not.toHaveTextContent("Avery");
    expect(region).not.toHaveTextContent("1961");
    // Each mark says what it is, for screen readers; a moved date too.
    const marks = within(region).getAllByText(/\(.*\)/, {
      selector: "mark span",
    });
    expect(marks.map((mark) => plain(mark.textContent))).toEqual(
      expect.arrayContaining([
        " (removed: name)",
        " (removed: date of birth)",
        " (date moved)",
        " (removed: doctor)",
      ]),
    );
    expect(screen.getByText("FAKE header line")).toBeInTheDocument();
    expect(region).toHaveTextContent("Ramipril 5 mg.");
  });

  it("removes a possible name with one press, a typed phrase everywhere, and undoes the last removal", async () => {
    const user = userEvent.setup();
    renderPreview();
    const region = await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    expect(region).toHaveTextContent("Admitted to the ward on day 3.");
    await user.click(
      screen.getByRole("button", { name: humanText("Remove “ward”") }),
    );
    expect(shownString()).toContain("Admitted to the [REMOVED 1] on day 3.");
    await user.type(
      screen.getByLabelText(humanText("Word or phrase to remove everywhere")),
      "chest pain",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Remove everywhere") }),
    );
    expect(shownString()).toContain("for [REMOVED 2].");
    expect(screen.getByRole("status")).toHaveHumanTextContent(
      "Removed in 1 places.",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Undo the last removal") }),
    );
    expect(shownString()).toContain("for chest pain.");
    expect(shownString()).toContain("[REMOVED 1]");
    // Undo never puts back what the remover took out.
    await user.click(
      screen.getByRole("button", { name: humanText("Undo the last removal") }),
    );
    expect(shownString()).not.toContain("Avery");
    expect(
      screen.getByRole("button", { name: humanText("Undo the last removal") }),
    ).toBeDisabled();
  });

  it("saves only the preview's text, after the confirmation, and never without it", async () => {
    const user = userEvent.setup();
    const { saveText, pickDestination } = renderPreview();
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    expect(saveText).not.toHaveBeenCalled();
    expect(pickDestination).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent("Anyone who opens it can read it.");
    await user.click(
      within(confirm).getByRole("button", { name: humanText("Cancel") }),
    );
    expect(saveText).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    expect(
      await screen.findByText(humanText("The text was saved.")),
    ).toBeInTheDocument();
    expect(pickDestination).toHaveBeenCalledWith("FAKE-ticket-1");
    expect(saveText).toHaveBeenCalledTimes(1);
    const [pickId, ticket, saved] = saveText.mock.calls[0];
    expect(pickId).toBe("pick-1");
    expect(ticket).toBe("FAKE-ticket-1");
    expect(saved).toBe(shownString());
    expect(saved).not.toMatch(/Avery|Example|1961/);
    // One save per ticket: the button is off afterwards.
    expect(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    ).toBeDisabled();
  });

  it("says so and changes nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    const { saveText } = renderPreview({
      pickDestination: vi.fn(async () => null),
    });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    expect(
      await screen.findByText(humanText("Save cancelled. Nothing changed.")),
    ).toBeInTheDocument();
    expect(saveText).not.toHaveBeenCalled();
  });

  it("takes out what native code refused, whole, and asks to save again", async () => {
    const user = userEvent.setup();
    // The preview draws its own shift: the moved date is read from the text.
    const saveText = vi.fn(
      async (_pickId: string, _ticket: string, text: string) => {
        const at = text.search(/\d{4}-\d{2}-\d{2}/);
        return at >= 0
          ? { saved: false, hits: [{ start: at + 2, end: at + 4 }] }
          : { saved: true, hits: [] };
      },
    );
    renderPreview({ saveText });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    const moved = /Seen (\d{4}-\d{2}-\d{2})/.exec(shownString())?.[1];
    expect(moved).toBeDefined();
    expect(moved).not.toBe("2026-10-08");
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    expect(
      await screen.findByText(
        humanText(
          "Details the vault knows were still in the text, in 1 places. They have now been removed; check the text and save again.",
        ),
      ),
    ).toBeInTheDocument();
    expect(shownString()).toContain("Seen [REMOVED 1] by");
    expect(shownString()).not.toContain(moved!);
    expect(saveText).toHaveBeenCalledTimes(1);
  });

  it("asks for the document's own password, and stops the read when closed", async () => {
    const user = userEvent.setup();
    const readText = vi.fn(async (password?: string) => {
      if (password === "FAKE-open") return documentText();
      throw refusal(password ? "pdfWrongPassword" : "pdfLocked");
    });
    const { cancelRead, onClose } = renderPreview({ readText });
    const box = await screen.findByLabelText(humanText("Document password"));
    await user.type(box, "nope{Enter}");
    expect(await screen.findByRole("alert")).toHaveHumanTextContent(
      "That password did not open the document.",
    );
    await user.type(
      screen.getByLabelText(humanText("Document password")),
      "FAKE-open{Enter}",
    );
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    await user.click(screen.getByRole("button", { name: humanText("Close") }));
    expect(cancelRead).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("names the pages left out, cut or empty, and the signs it could not read", async () => {
    renderPreview({
      text: documentText({
        pageCount: 60,
        emptyPages: [1],
        cutPages: [2],
        failedPages: [3],
        truncated: true,
      }),
    });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    for (const note of [
      "Only the first 1 pages are included. The file will say so.",
      "Pages with no text that could be read, left out (they may be scans): 2",
      "Pages whose text was cut short: 3",
      "Pages that could not be read, left out: 4",
    ])
      expect(screen.getByText(humanText(note))).toBeInTheDocument();
  });
});
