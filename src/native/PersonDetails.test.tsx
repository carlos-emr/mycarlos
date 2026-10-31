import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
