import { humanText, visibleText } from "../test/humanText";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { LOCALES, translate } from "../i18n";
import { AnonymizePreview } from "./AnonymizePreview";
import { joinPages, type DocumentText } from "../documentText";
import type {
  KnownIdentifiers,
  PatientProfile,
  TextCopyOutcome,
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
      _kept?: { start: number; end: number }[],
    ): Promise<TextSaveOutcome> => ({
      saved: true,
      hits: [],
    }),
  ),
  pickDestination = vi.fn(async (_ticket: string) => "pick-1" as string | null),
  details = known,
  // The native copy: the same file a save writes, here "FAKE header line", a blank line, the
  // text and a newline, or a refusal.
  copyText = vi.fn(
    async (
      _ticket: string,
      text: string,
      _kept?: { start: number; end: number }[],
    ): Promise<TextCopyOutcome> => ({
      approved: `FAKE header line\n\n${text}\n`,
      hits: [],
    }),
  ),
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
      knownDetails={async () => details}
      pickDestination={pickDestination}
      saveText={saveText}
      copyText={copyText}
      exportHeader="FAKE header line"
      onClose={onClose}
    />,
  );
  return {
    readText,
    saveText,
    copyText,
    pickDestination,
    onClose,
    cancelRead,
  };
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
    // Each mark says what it is, for screen readers; a replaced date too.
    const marks = within(region).getAllByText(/\(.*\)/, {
      selector: "mark span",
    });
    expect(marks.map((mark) => plain(mark.textContent))).toEqual(
      expect.arrayContaining([
        " (removed: name)",
        " (removed: date of birth)",
        " (date replaced)",
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

  it("offers to keep a name inside an eponym phrase as a medical term, one or all, and undoes it (#214)", async () => {
    const user = userEvent.setup();
    const eponymPages = [
      {
        index: 0,
        text: "Patient: Peter Bell\nHas Bell's palsy. Follow up Bell's palsy in May.",
      },
    ];
    const { copyText } = renderPreview({
      text: documentText({
        pages: eponymPages,
        ...joinPages(eponymPages),
      }),
      details: { ...known, names: ["Peter Bell"] },
    });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    // Removed by default, as before.
    expect(shownString()).not.toContain("Bell's palsy");
    expect(
      screen.getAllByText(/This may be a medical term:.*Bell's palsy/),
    ).toHaveLength(2);
    // Each Keep has a name of its own: the words around the term tell the two apart.
    const keeps = screen.getAllByRole("button", { name: /^Keep “/ });
    expect(
      new Set(keeps.map((keep) => keep.getAttribute("aria-label"))).size,
    ).toBe(keeps.length);
    await user.click(keeps[0]);
    expect(shownString()).toContain("Has Bell's palsy.");
    expect(shownString()).toContain("Follow up [NAME 1, other form 1]'s palsy");
    await user.click(
      screen.getByRole("button", { name: humanText("Undo the last removal") }),
    );
    expect(shownString()).not.toContain("Has Bell's palsy.");
    await user.click(screen.getAllByRole("button", { name: /Keep all/ })[0]);
    expect(shownString()).toContain("Has Bell's palsy.");
    expect(shownString()).toContain("Follow up Bell's palsy");
    // A copy names the kept phrases' places to the native check, which reads them against its
    // own list (#366): a claim, never a fact.
    await user.click(
      screen.getByRole("button", { name: humanText("Copy text") }),
    );
    const [, copied, kept] = copyText.mock.calls[0];
    expect(kept).toHaveLength(2);
    for (const range of kept as { start: number; end: number }[])
      expect((copied as string).slice(range.start, range.end)).toBe(
        "Bell's palsy",
      );
    // The full name is never offered and stays removed.
    expect(shownString()).not.toContain("Peter");
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
    // Native code finds something inside a date placeholder: the whole
    // placeholder goes.
    const saveText = vi.fn(
      async (
        _pickId: string,
        _ticket: string,
        text: string,
        _kept?: { start: number; end: number }[],
      ) => {
        const at = text.indexOf("[DATE 1]");
        return at >= 0
          ? { saved: false, hits: [{ start: at + 1, end: at + 3 }] }
          : { saved: true, hits: [] };
      },
    );
    renderPreview({ saveText });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    expect(shownString()).toContain("Seen [DATE 1] by");
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
    expect(shownString()).not.toContain("[DATE 1]");
    expect(saveText).toHaveBeenCalledTimes(1);
  });

  it("sends no real date, and puts the details back into the AI's answer after the save, flagging what it cannot match", async () => {
    const user = userEvent.setup();
    const twoDates = [
      {
        index: 0,
        text: "Patient: Avery Example\nDOB: 1961-04-17\nSeen 2026-10-08 by Dr. Ward. Pain since 2026-09-24. Review 03/04/2026. A 92-year-old woman.",
      },
    ];
    const { saveText } = renderPreview({
      text: documentText({ pages: twoDates, ...joinPages(twoDates) }),
    });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    // Nothing to paste into before the save.
    expect(screen.queryByLabelText(humanText("The AI's answer"))).toBeNull();
    const sent = shownString();
    expect(sent).toContain("Pain since [DATE 1]");
    expect(sent).toContain("Seen [DATE 2, 14 days after DATE 1]");
    expect(sent).toContain("Review [DATE 3]");
    expect(sent).toContain("[AGE 1, 90+]");
    expect(sent).not.toMatch(/\b20\d\d\b|1961|Avery/);
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    await screen.findByText(humanText("The text was saved."));
    expect(saveText.mock.calls[0][2]).toBe(sent);

    const box = screen.getByLabelText(humanText("The AI's answer"));
    const putBack = screen.getByRole("button", {
      name: humanText("Put details back"),
    });
    expect(putBack).toBeDisabled();
    await user.click(box);
    await user.paste(
      "[NAME 1] was seen on [DATE 2, 14 days after DATE 1] (pain since [DATE 1]) " +
        "by [DOCTOR 1]; review [DATE 3]; [AGE 1, 90+]. " +
        "Also [DATE 2, 15 days after DATE 1] and [DATE 9] and [AGE 1, 89+].",
    );
    await user.click(putBack);
    const result = await screen.findByRole("region", {
      name: humanText("The answer with the details put back"),
    });
    expect(result).toHaveTextContent(
      "Avery Example was seen on 2026-10-08 (pain since 2026-09-24) by Ward; review 03/04/2026; 92-year-old.",
    );
    // What it could not match is left as written and highlighted, never guessed.
    const flagged = Array.from(result.querySelectorAll("mark")).map((mark) =>
      plain(mark.firstChild?.textContent ?? ""),
    );
    expect(flagged).toEqual([
      "[DATE 2, 15 days after DATE 1]",
      "[DATE 9]",
      "[AGE 1, 89+]",
    ]);
    expect(
      screen.getByText(
        humanText(
          "Marks that could not be matched to this text, or that were changed, are highlighted (3). Check them against the original.",
        ),
      ),
    ).toBeInTheDocument();
    expect(result).not.toHaveTextContent("1961");
  });

  it("writes the placeholders in the document's language, and puts back marks written in another (#215)", async () => {
    const user = userEvent.setup();
    const letter = [
      {
        index: 0,
        text:
          "Madame, nous avons vu Avery Example le 2026-10-08 à la clinique pour une douleur dans la poitrine. " +
          "Elle est suivie depuis le 2026-09-24 et elle prend du ramipril 5 mg. Nous la reverrons dans un mois " +
          "avec les résultats de ses analyses. Le traitement est bien toléré et la patiente ne signale pas " +
          "d'effet secondaire. Elle doit revenir avant la fin du mois si les douleurs reviennent.",
      },
    ];
    const { saveText } = renderPreview({
      text: documentText({ pages: letter, ...joinPages(letter) }),
    });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    // The app is in English; the letter is French.
    const sent = shownString();
    expect(sent).toContain(
      "nous avons vu [NOM 1] le [DATE 2, 14 jours après DATE 1]",
    );
    expect(sent).toContain("suivie depuis le [DATE 1]");
    expect(sent).not.toMatch(/\[NAME|days after|Avery|2026/);
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    await screen.findByText(humanText("The text was saved."));
    expect(saveText.mock.calls[0][2]).toBe(sent);
    await user.click(screen.getByLabelText(humanText("The AI's answer")));
    // The AI answered in English and translated the marks.
    await user.paste(
      "[NAME 1] was seen on [DATE 2, 14 days after DATE 1]; [NOM 1] since [DATE 1].",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Put details back") }),
    );
    const result = await screen.findByRole("region", {
      name: humanText("The answer with the details put back"),
    });
    expect(result).toHaveTextContent(
      "Avery Example was seen on 2026-10-08; Avery Example since 2026-09-24.",
    );
    expect(result.querySelectorAll("mark")).toHaveLength(0);
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

  it("highlights what is still in the text and may identify someone, counts it once for a screen reader, and offers Remove", async () => {
    const user = userEvent.setup();
    const checkPages = [
      {
        index: 0,
        text: "Patient: Avery Example\nSeen with Blake at room 214 on Monday. Ramipril 5 mg.",
      },
    ];
    renderPreview({
      text: documentText({ pages: checkPages, ...joinPages(checkPages) }),
    });
    const region = await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    const marks = () =>
      [...region.querySelectorAll<HTMLElement>("[data-check]")].map(
        (mark) => mark.textContent,
      );
    // The capitalised word that does not start a sentence and the number of three digits; not
    // the placeholders, "Monday", the drug, "Seen" (a sentence start) or the dose "5".
    expect(marks()).toEqual(["Blake", "214"]);
    // The help says what the flags miss: capitals-only names, a line's first word, scripts
    // without capitals, and names that are also months, drugs or medical terms.
    const help = document.querySelector(".native-anonymize-checks")!;
    expect(help).toHaveHumanTextContent(/does not find everything/);
    expect(help).toHaveHumanTextContent(/names written in capitals/);
    expect(help).toHaveHumanTextContent(/start of a line/);
    expect(help).toHaveHumanTextContent(/Chinese, Korean or Arabic/);
    expect(help).toHaveHumanTextContent(/months, drugs or medical terms/);
    // One count for a screen reader, in a closed list, not a stop at each word.
    expect(screen.getByText(humanText("2 words to check"))).toBeInTheDocument();
    // Decoration only: a flagged word is plain text in a span, with its offset like any other.
    for (const flagged of region.querySelectorAll("[data-check]")) {
      expect(flagged.tagName).toBe("SPAN");
      expect(flagged).toHaveAttribute("data-start");
    }
    // Clicking a highlighted word offers Remove for it; Remove takes it out as one step.
    await user.click(region.querySelector<HTMLElement>("[data-check]")!);
    await user.click(
      screen
        .getAllByRole("button", { name: humanText("Remove “Blake”") })
        .find((button) => button.closest(".native-anonymize-picked"))!,
    );
    expect(marks()).toEqual(["214"]);
    expect(region).not.toHaveTextContent("Blake");
    expect(screen.getByText(humanText("1 word to check"))).toBeInTheDocument();
    expect(
      document.querySelector(".native-anonymize-summary"),
    ).toHaveHumanTextContent(/1 removed by you/);
    // The list below the text reaches the same removal from the keyboard.
    await user.click(
      screen.getByRole("button", { name: humanText("Remove “214”") }),
    );
    expect(marks()).toEqual([]);
    expect(document.querySelector(".native-anonymize-checks")).toBeNull();
  });

  it("tells the patient where the pasted text goes and what the saved file is, beside Save", async () => {
    renderPreview();
    const save = await screen.findByRole("button", {
      name: humanText("Save the text…"),
    });
    const advice = document.querySelector<HTMLElement>(
      ".native-anonymize-advice",
    )!;
    expect(advice).toHaveHumanTextContent(
      "Where you paste this decides what is kept: a chat service may keep it or learn from it, depending on your account settings.",
    );
    expect(advice).toHaveHumanTextContent(
      "The saved file is not protected by myCarlos. It has no names, but it holds the medical details. Delete it when you are done.",
    );
    // Above the action row that holds Save.
    expect(
      advice.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // "Removing details is never perfect" is the first, prominent note.
    expect(
      document.querySelector(".native-anonymize-warning"),
    ).toHaveHumanTextContent(/^Removing details is never perfect/);
  });

  it("copies only what the native check returns, which is the text Save would write, and warns about the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { saveText, copyText } = renderPreview();
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    // The plain warning is there, before anything is copied.
    expect(
      document.querySelector(".native-anonymize-advice"),
    ).toHaveHumanTextContent(
      "Copied text can stay on this device: Windows clipboard history, and clipboard sync between devices, may keep a copy.",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Copy text") }),
    );
    expect(
      await screen.findByText(humanText("The text was copied.")),
    ).toBeInTheDocument();
    // The check ran on the shown text with the ticket, and the clipboard got what it returned.
    expect(copyText).toHaveBeenCalledWith("FAKE-ticket-1", shownString(), []);
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0];
    // A clipboard that refuses says so (a copy does not use up the ticket).
    writeText.mockRejectedValueOnce(new Error("FAKE: blocked"));
    await user.click(
      screen.getByRole("button", { name: humanText("Copy text") }),
    );
    expect(
      await screen.findByText(humanText("The text could not be copied.")),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    await screen.findByText(humanText("The text was saved."));
    const [, , saved] = saveText.mock.calls[0];
    // The same text went to both checks, and the copy is the file built from it.
    expect(saved).toBe(copyText.mock.calls[0][1]);
    expect(copied).toBe(`FAKE header line\n\n${saved}\n`);
    expect(copied).not.toMatch(/Avery|Example|1961/);
  });

  it("copies nothing when the native check refuses, and takes out what it found, as Save does", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    // The check finds "Ward" (offsets in the shown text) still standing.
    const { copyText } = renderPreview({
      copyText: vi.fn(
        async (
          _ticket: string,
          text: string,
          _kept?: { start: number; end: number }[],
        ) => {
          const at = text.indexOf("ward");
          return { approved: null, hits: [{ start: at, end: at + 4 }] };
        },
      ),
    });
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    expect(shownString()).toContain("Admitted to the ward on day 3.");
    await user.click(
      screen.getByRole("button", { name: humanText("Copy text") }),
    );
    expect(copyText).toHaveBeenCalledTimes(1);
    // Nothing reached the clipboard; the refused range is taken out for the patient to check.
    expect(writeText).not.toHaveBeenCalled();
    expect(shownString()).toContain("Admitted to the [REMOVED 1] on day 3.");
    expect(
      await screen.findByText(humanText(/were still in the text/)),
    ).toBeInTheDocument();
  });

  it("saves exactly the words with or without the flags: they are decoration only", async () => {
    const user = userEvent.setup();
    const checkPages = [
      {
        index: 0,
        text: "Patient: Avery Example\nSeen with Blake at room 214 on Monday.",
      },
    ];
    const { saveText } = renderPreview({
      text: documentText({ pages: checkPages, ...joinPages(checkPages) }),
    });
    const region = await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    expect(region.querySelectorAll("[data-check]")).toHaveLength(2);
    await user.click(
      screen.getByRole("button", { name: humanText("Save the text…") }),
    );
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: humanText("Save the text…"),
      }),
    );
    await screen.findByText(humanText("The text was saved."));
    const [, , saved] = saveText.mock.calls[0];
    // No markup, no marker and nothing added for the flagged words: the shown words, as they are.
    expect(saved).toBe(shownString());
    expect(saved).toBe(
      "Patient: [NAME 1]\nSeen with Blake at room 214 on Monday.",
    );
  });

  it("counts each kind with its language's plural forms", () => {
    const count = (
      locale: Parameters<typeof translate>[0],
      kind: string,
      n: number,
    ) =>
      visibleText(
        translate(
          locale,
          `interface.AnonymizePreview.removedCount.${kind}` as Parameters<
            typeof translate
          >[1],
          { count: n },
        ),
      );
    // English and French: one and other; Polish: one, few, many; Chinese: no plural.
    expect(count("en", "name", 1)).toBe("1 name");
    expect(count("en", "name", 4)).toBe("4 names");
    expect(count("en", "phone", 2)).toBe("2 phone numbers");
    expect(count("en", "date", 6)).toBe("6 dates replaced");
    expect(count("fr", "name", 1)).toBe("1 nom");
    expect(count("fr", "phone", 2)).toBe("2 numéros de téléphone");
    expect(count("pl", "phone", 1)).toBe("1 numer telefonu");
    expect(count("pl", "phone", 2)).toBe("2 numery telefonów");
    expect(count("pl", "phone", 5)).toBe("5 numerów telefonów");
    expect(count("zh-CN", "phone", 2)).toBe("2 个电话号码");
    // Every kind has a form in every language, and no placeholder is left in it.
    for (const locale of LOCALES)
      for (const kind of [
        "name",
        "doctor",
        "clinic",
        "healthCard",
        "recordNumber",
        "sin",
        "dateOfBirth",
        "age",
        "address",
        "postalCode",
        "phone",
        "email",
        "web",
        "unclearDate",
        "manual",
        "date",
      ])
        for (const n of [1, 2, 5, 22])
          expect(count(locale, kind, n), `${locale} ${kind} ${n}`).toMatch(
            new RegExp(String(n)),
          );
  });

  it("says at the top what was removed, by kind, and follows each removal and undo", async () => {
    const user = userEvent.setup();
    renderPreview();
    await screen.findByRole("region", {
      name: humanText("The text that will be saved"),
    });
    const summary = () =>
      document.querySelector<HTMLElement>(".native-anonymize-summary")!;
    // From the automatic result: the patient's name, birth date, a date and the doctor.
    expect(summary()).toHaveHumanTextContent(/^Removed: .*1 name/);
    expect(summary()).toHaveHumanTextContent(/1 date of birth/);
    expect(summary()).not.toHaveHumanTextContent(/removed by you/);
    await user.type(
      screen.getByLabelText(humanText("Word or phrase to remove everywhere")),
      "chest pain",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Remove everywhere") }),
    );
    expect(summary()).toHaveHumanTextContent(/1 removed by you/);
    await user.click(
      screen.getByRole("button", { name: humanText("Undo the last removal") }),
    );
    expect(summary()).not.toHaveHumanTextContent(/removed by you/);
  });

  it("puts Close last in the action row, at the bottom right, on a wide window", async () => {
    const user = userEvent.setup();
    await page.viewport(1100, 800);
    try {
      const { onClose } = renderPreview();
      await screen.findByRole("region", {
        name: humanText("The text that will be saved"),
      });
      const dialog = screen.getByRole("dialog");
      const close = within(dialog).getByRole("button", {
        name: humanText("Close"),
      });
      const save = within(dialog).getByRole("button", {
        name: humanText("Save the text…"),
      });
      const row = close.closest("footer")!;
      // Beside Save, after it in reading and Tab order.
      expect(row).toContainElement(save);
      expect(
        save.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Not in the header any more. (Where it sits on the page, and its 44px
      // target, are checked with the real stylesheet in tests/anonymize-preview.spec.ts.)
      expect(dialog.querySelector("header")).not.toContainElement(close);
      // Escape still closes.
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalled();
    } finally {
      await page.viewport(414, 896);
    }
  });

  it("keeps Close in the header on a narrow window", async () => {
    await page.viewport(360, 800);
    try {
      renderPreview();
      await screen.findByRole("region", {
        name: humanText("The text that will be saved"),
      });
      const dialog = screen.getByRole("dialog");
      const close = within(dialog).getByRole("button", {
        name: humanText("Close"),
      });
      expect(dialog.querySelector("header")).toContainElement(close);
      expect(close.closest("footer")).toBeNull();
    } finally {
      await page.viewport(414, 896);
    }
  });

  it("still has a Close at the bottom before the text is shown, on a wide window", async () => {
    await page.viewport(1100, 800);
    try {
      renderPreview({
        readText: vi.fn(() => new Promise<DocumentText>(() => {})),
      });
      const dialog = screen.getByRole("dialog");
      const close = await within(dialog).findByRole("button", {
        name: humanText("Close"),
      });
      expect(close.closest("footer")).not.toBeNull();
    } finally {
      await page.viewport(414, 896);
    }
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
      "[Text cut after page 1]",
      "Pages with no text that could be read, left out (they may be scans): 2",
      "Pages whose text was cut short: 3",
      "Pages that could not be read, left out: 4",
    ])
      expect(screen.getByText(humanText(note))).toBeInTheDocument();
  });
});
