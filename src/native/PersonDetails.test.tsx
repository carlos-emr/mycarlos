import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import {
  PersonDetailsList,
  detailsProblem,
  trimmedDetails,
} from "./PersonDetails";
import { localDateText } from "../vault";
import { setLocaleOverride, translate } from "../i18n";

describe("required profile identity details", () => {
  const fullName = "Mary Smith";
  it("requires a full name and a date or an explicit unknown choice", () => {
    expect(detailsProblem({ birthDate: "2000-02-29" })).toBe(
      "personDetails.fullNameRequired",
    );
    expect(detailsProblem({ fullName })).toBe(
      "personDetails.birthDateRequired",
    );
    expect(detailsProblem({ fullName }, true)).toBeNull();
  });
  it("validates exact calendar dates, future dates and full name bounds", () => {
    expect(detailsProblem({ fullName, birthDate: "1900-02-29" })).toBe(
      "personDetails.invalidDate",
    );
    expect(detailsProblem({ fullName, birthDate: "2000-02-29" })).toBeNull();
    expect(detailsProblem({ fullName, birthDate: "0000-01-01" })).toBe(
      "personDetails.invalidDate",
    );
    expect(detailsProblem({ fullName, birthDate: "01/02/2000" })).toBe(
      "personDetails.invalidDate",
    );
    expect(detailsProblem({ fullName, birthDate: "2999-01-01" })).toBe(
      "personDetails.futureDate",
    );
    expect(
      detailsProblem({ fullName, birthDate: localDateText(new Date()) }),
    ).toBeNull();
    expect(
      detailsProblem({ fullName: "a".repeat(121), birthDate: "2000-01-01" }),
    ).toBe("personDetails.nameTooLong");
    expect(trimmedDetails({ fullName: "  ", birthDate: "" })).toEqual({});
    expect(
      trimmedDetails({ fullName: " Mary Smith ", birthDate: "1958-03-12" }),
    ).toEqual({ fullName: "Mary Smith", birthDate: "1958-03-12" });
  });
  it("edits explicit details, retains refused edits and permits clearing the birth date", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(
      <PersonDetailsList
        people={[
          {
            id: "p1",
            displayName: "FAKE Mary",
            createdAtMs: 1,
            fullName: "FAKE Mary Smith",
            birthDate: "1958-03-12",
          },
        ]}
        busy={false}
        onSave={save}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Mary"),
      }),
    );
    fireEvent.change(
      screen.getByLabelText("Full name, as on clinic documents"),
      { target: { value: "FAKE Mary Smith" } },
    );
    fireEvent.click(
      screen.getByLabelText("I don't know this person's date of birth"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith("p1", { fullName: "FAKE Mary Smith" }),
    );
    expect(
      screen.getByRole("form", { name: humanText("Details for FAKE Mary") }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("form", {
          name: humanText("Details for FAKE Mary"),
        }),
      ).not.toBeInTheDocument(),
    );
  });
  it("edits details in a dialog that gives focus back to the person's Edit details button", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(
      <PersonDetailsList
        people={[
          {
            id: "p1",
            displayName: "FAKE Mary",
            createdAtMs: 1,
            fullName: "FAKE Mary Smith",
            birthDate: "1958-03-12",
          },
        ]}
        busy={false}
        onSave={save}
        refusalText="FAKE refusal from the vault"
      />,
    );
    const edit = screen.getByRole("button", {
      name: humanText("Edit details for FAKE Mary"),
    });
    expect(edit).toHaveAttribute("aria-haspopup", "dialog");
    edit.focus();
    fireEvent.click(edit);
    let dialog = screen.getByRole("dialog", { name: "Edit details" });
    const fullName = within(dialog).getByLabelText(
      "Full name, as on clinic documents",
    );
    expect(fullName).toHaveFocus();
    expect(fullName).toHaveValue("FAKE Mary Smith");
    expect(within(dialog).getByLabelText("Date of birth")).toHaveValue(
      "1958-03-12",
    );
    fireEvent.keyDown(fullName, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(edit).toHaveFocus();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(edit);
    dialog = screen.getByRole("dialog", { name: "Edit details" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    // Refused: the dialog stays open and says why.
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "FAKE refusal from the vault",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(edit).toHaveFocus());
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("opens a person with no details with the date box open, and one with only a full name as date unknown", () => {
    render(
      <PersonDetailsList
        people={[
          { id: "p1", displayName: "FAKE Fresh", createdAtMs: 1 },
          {
            id: "p2",
            displayName: "FAKE Named",
            createdAtMs: 2,
            fullName: "FAKE Named Example",
          },
        ]}
        busy={false}
        onSave={vi.fn()}
      />,
    );
    const open = (name: string) => {
      fireEvent.click(
        screen.getByRole("button", {
          name: humanText(`Edit details for ${name}`),
        }),
      );
      const dialog = screen.getByRole("dialog", { name: "Edit details" });
      return {
        dialog,
        unknown: within(dialog).getByRole("checkbox", {
          name: "I don't know this person's date of birth",
        }),
        date: within(dialog).getByLabelText("Date of birth"),
      };
    };
    let shown = open("FAKE Fresh");
    expect(shown.unknown).not.toBeChecked();
    expect(shown.date).toBeEnabled();
    fireEvent.click(
      within(shown.dialog).getByRole("button", { name: "Cancel" }),
    );
    shown = open("FAKE Named");
    expect(shown.unknown).toBeChecked();
    expect(shown.date).toBeDisabled();
  });
  it("opens the person the library's reminder asks for as their own Edit details button does", () => {
    const people = [
      {
        id: "p2",
        displayName: "FAKE Named",
        createdAtMs: 2,
        fullName: "FAKE Named Example",
      },
      {
        id: "p3",
        displayName: "FAKE Dated",
        createdAtMs: 3,
        fullName: "FAKE Dated Example",
        birthDate: "2015-06-01",
      },
    ];
    const list = (openFor: { profileId: string } | null) => (
      <PersonDetailsList
        people={people}
        busy={false}
        onSave={vi.fn()}
        openFor={openFor}
      />
    );
    const shown = () => {
      const dialog = screen.getByRole("dialog", { name: "Edit details" });
      return {
        fullName: within(dialog).getByLabelText(
          humanText("Full name, as on clinic documents"),
        ),
        unknown: within(dialog).getByRole("checkbox", {
          name: "I don't know this person's date of birth",
        }),
        date: within(dialog).getByLabelText("Date of birth"),
        cancel: within(dialog).getByRole("button", { name: "Cancel" }),
      };
    };
    const { rerender } = render(list({ profileId: "p2" }));
    let opened = shown();
    expect(opened.fullName).toHaveValue("FAKE Named Example");
    expect(opened.unknown).toBeChecked();
    expect(opened.date).toBeDisabled();
    fireEvent.click(opened.cancel);
    rerender(list({ profileId: "p3" }));
    opened = shown();
    expect(opened.fullName).toHaveValue("FAKE Dated Example");
    expect(opened.unknown).not.toBeChecked();
    expect(opened.date).toHaveValue("2015-06-01");
    fireEvent.click(opened.cancel);
    // The same person by their own button: the same dialog.
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Named"),
      }),
    );
    opened = shown();
    expect(opened.fullName).toHaveValue("FAKE Named Example");
    expect(opened.unknown).toBeChecked();
    expect(opened.date).toBeDisabled();
  });

  it("disables editing while busy or read-only", () => {
    render(
      <PersonDetailsList
        people={[{ id: "p1", displayName: "FAKE Mary", createdAtMs: 1 }]}
        busy
        onSave={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Mary"),
      }),
    ).toBeDisabled();
  });

  it("rewords validation without losing identity drafts or the unknown-date choice across languages", async () => {
    setLocaleOverride("en");
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(
      <PersonDetailsList
        people={[
          {
            id: "p1",
            displayName: "FAKE Avery",
            createdAtMs: 1,
            birthDate: "2000-02-29",
          },
        ]}
        busy={false}
        onSave={save}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: humanText("Edit details for FAKE Avery"),
      }),
    );
    const name = screen.getByLabelText("Full name, as on clinic documents");
    const date = screen.getByLabelText("Date of birth");
    const unknown = screen.getByRole("checkbox");
    const form = screen.getByRole("form", {
      name: humanText("Details for FAKE Avery"),
    });

    act(() => setLocaleOverride("pl"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Proszę wpisać imię i nazwisko tej osoby.",
    );
    expect(screen.getByRole("button", { name: "Zapisz dane" })).toBeDisabled();
    const draft = "  FAKE אבג { $name }  ";
    fireEvent.change(name, { target: { value: draft } });
    name.focus();
    act(() => setLocaleOverride("pt-BR"));
    expect(
      screen.getByLabelText(translate("pt-BR", "personDetails.fullName")),
    ).toBe(name);
    expect(name).toHaveValue(draft);
    expect(name).toHaveFocus();
    expect(date).toHaveValue("2000-02-29");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(date, { target: { value: "" } });
    act(() => setLocaleOverride("pl"));
    expect(screen.getByLabelText("Data urodzenia")).toBe(date);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Proszę wpisać datę urodzenia lub zaznaczyć, że jest nieznana.",
    );
    expect(screen.getByRole("button", { name: "Zapisz dane" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(unknown);
    expect(date).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();

    act(() => setLocaleOverride("pt-BR"));
    expect(unknown).toBeChecked();
    expect(date).toBeDisabled();
    expect(name).toHaveValue(draft);
    fireEvent.click(screen.getByRole("button", { name: "Salvar dados" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith("p1", { fullName: draft.trim() });
    expect(form).toBeInTheDocument();
    expect(name).toHaveValue(draft);
    expect(unknown).toBeChecked();

    act(() => setLocaleOverride("pl"));
    expect(
      screen.getByRole("form", { name: humanText("Dane osoby FAKE Avery") }),
    ).toBe(form);
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Zapisz dane" }));
    await waitFor(() => expect(form).not.toBeInTheDocument());
    expect(save).toHaveBeenNthCalledWith(2, "p1", { fullName: draft.trim() });
  });
});
