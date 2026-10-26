import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PersonDetailsList,
  detailsProblem,
  trimmedDetails,
} from "./PersonDetails";
import { localDateText } from "../vault";

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
  it("edits explicit details, retains refused edits and permits clearing", async () => {
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
      screen.getByRole("button", { name: "Edit details for FAKE Mary" }),
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
      screen.getByRole("form", { name: "Details for FAKE Mary" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Details for FAKE Mary" }),
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
      screen.getByRole("button", { name: "Edit details for FAKE Mary" }),
    ).toBeDisabled();
  });
});
