import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import type { ClinicPatient, PatientProfile } from "../vault";
import { humanText, visibleText } from "../test/humanText";
import { FileUnderDialog } from "./FileUnder";

// File under…: a clinic document waiting in Shared with me, filed under a person the patient
// chooses. Nobody is chosen for them, and nothing is saved to a person's details unless they
// tick the box that says exactly what will be saved. FAKE data only.

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

const clinic: ClinicPatient = {
  name: "FAKE Casey Person",
  birthDate: "2001-02-03",
};
const bare: PatientProfile = {
  id: "p1",
  displayName: "FAKE Avery",
  createdAtMs: 1,
};
const named: PatientProfile = {
  id: "p2",
  displayName: "FAKE Blake",
  createdAtMs: 2,
  fullName: "FAKE Someone Else",
  birthDate: "1999-09-09",
};

function renderDialog(
  props: Partial<Parameters<typeof FileUnderDialog>[0]> = {},
) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <FileUnderDialog
      documentName="FAKE Letter.pdf"
      clinic={clinic}
      people={[bare, named]}
      busy={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

const person = () =>
  screen.getByRole("combobox", { name: en("fileUnder.person") });

describe("filing a clinic document under a person", () => {
  it("names the document and the clinic's own words, and chooses nobody for the patient", () => {
    const { onConfirm } = renderDialog();
    expect(
      screen.getByRole("dialog", {
        name: humanText(en("fileUnder.title", { document: "FAKE Letter.pdf" })),
      }),
    ).toBeVisible();
    expect(screen.getByText(humanText(/FAKE Casey Person/))).toBeVisible();
    expect(screen.getByText(humanText(/2001-02-03/))).toBeVisible();
    // The choice has no answer yet: it takes the focus, and the button is not a way through.
    expect(person()).toHaveFocus();
    expect((person() as HTMLSelectElement).value).toBe("");
    const confirm = screen.getByRole("button", {
      name: en("fileUnder.choose"),
    });
    expect(confirm).toBeDisabled();
    fireEvent.submit(confirm.closest("form")!);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("offers to save what the clinic says only into a field the person has none of, never ticked for them", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.selectOptions(person(), "p1");
    const tick = screen.getByRole("checkbox");
    expect(tick).not.toBeChecked();
    // It says exactly what would be saved.
    expect(
      screen.getByText(
        humanText(
          en("fileUnder.saveDetails", {
            what: en("fileUnder.what.both", {
              name: "FAKE Casey Person",
              date: "2001-02-03",
            }),
            person: "FAKE Avery",
          }),
        ),
      ),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: humanText(en("fileUnder.confirm", { person: "FAKE Avery" })),
      }),
    );
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("p1", false);
  });

  it("saves the details only when the box was ticked, and a new choice of person unticks it", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      people: [bare, { ...bare, id: "p3", displayName: "FAKE Also Bare" }],
    });
    await user.selectOptions(person(), "p1");
    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    await user.selectOptions(person(), "p3");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.click(screen.getByRole("checkbox"));
    await user.click(
      screen.getByRole("button", {
        name: humanText(en("fileUnder.confirm", { person: "FAKE Also Bare" })),
      }),
    );
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("p3", true);
  });

  it("warns and offers nothing for a person whose name or birth date differs from the clinic's", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.selectOptions(person(), "p2");
    expect((await screen.findByRole("alert")).textContent).toContain(
      en("fileUnder.differs"),
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    // The patient can still file the document under them: nothing is saved.
    await user.click(
      screen.getByRole("button", {
        name: humanText(en("fileUnder.confirm", { person: "FAKE Blake" })),
      }),
    );
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("p2", false);
  });

  it("says when the next documents from this clinic would not file themselves under the person, and words the box for saving details only", async () => {
    const user = userEvent.setup();
    renderDialog({
      clinic: { ...clinic, matchingPeople: ["p1", "someone-else"] },
    });
    await user.selectOptions(person(), "p1");
    expect(screen.getByText(en("fileUnder.notOnItsOwn"))).toBeVisible();
    expect(
      screen.getByText(
        humanText(
          en("fileUnder.saveDetailsOnly", {
            what: en("fileUnder.what.both", {
              name: "FAKE Casey Person",
              date: "2001-02-03",
            }),
            person: "FAKE Avery",
          }),
        ),
      ),
    ).toBeVisible();
  });

  it("while it is working nothing can be changed, chosen or sent", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog({ busy: true });
    expect(person()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(person().closest("form")!);
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Cancel, Escape and a click outside leave; a click inside does not", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".dialog-backdrop")!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});
