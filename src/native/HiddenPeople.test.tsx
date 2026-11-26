import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride, translate } from "../i18n";
import type { HiddenProfile, PatientProfile } from "../vault";
import { humanText, visibleText } from "../test/humanText";
import {
  ArrivedWhileHiddenDialog,
  HidePersonButton,
  HiddenPeopleList,
} from "./HiddenPeople";

// Hiding a whole person and bringing them back (#360): tidiness, not secrecy; nothing is
// deleted, and one action reverses it. FAKE data only.

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
});

const en = (
  key: Parameters<typeof translate>[1],
  params?: Parameters<typeof translate>[2],
) => visibleText(translate("en", key, params));

const avery: PatientProfile = {
  id: "p1",
  displayName: "FAKE Avery",
  createdAtMs: 1,
};

describe("the Hide button on a person's line", () => {
  const props = { person: avery, onlyOne: false, busy: false, readOnly: false };

  it("asks first, says what hiding is, and hides only on confirmation", async () => {
    const user = userEvent.setup();
    const onHide = vi.fn();
    render(<HidePersonButton {...props} onHide={onHide} />);
    const hide = screen.getByRole("button", {
      name: humanText(en("hiddenPeople.hideFor", { name: "FAKE Avery" })),
    });
    expect(hide).toHaveAttribute("aria-haspopup", "dialog");
    await user.click(hide);
    const ask = await screen.findByRole("alertdialog", {
      name: humanText(en("hiddenPeople.confirm.title", { name: "FAKE Avery" })),
    });
    expect(
      within(ask).getByText(
        humanText(en("hiddenPeople.confirm.body", { name: "FAKE Avery" })),
      ),
    ).toBeVisible();
    // Cancelling hides nothing, and asking again works.
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(onHide).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(hide);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: humanText(
          en("hiddenPeople.confirm.hide", { name: "FAKE Avery" }),
        ),
      }),
    );
    expect(onHide).toHaveBeenCalledExactlyOnceWith("p1");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the only person the library shows cannot be hidden: the button is off and says why", () => {
    render(<HidePersonButton {...props} onlyOne onHide={vi.fn()} />);
    const hide = screen.getByRole("button", {
      name: humanText(en("hiddenPeople.hideFor", { name: "FAKE Avery" })),
    });
    expect(hide).toBeDisabled();
    expect(hide).toHaveAccessibleDescription(en("hiddenPeople.lastPerson"));
  });

  it.each([
    ["busy", { busy: true }],
    ["read-only", { readOnly: true }],
  ])("is off while %s", (_, extra) => {
    render(<HidePersonButton {...props} {...extra} onHide={vi.fn()} />);
    expect(screen.getByRole("button")).toBeDisabled();
    // No explanation of "last person" when that is not the reason.
    expect(screen.queryByText(en("hiddenPeople.lastPerson"))).toBeNull();
  });
});

describe("Hidden people in Security", () => {
  const hidden: HiddenProfile[] = [
    {
      id: "h1",
      displayName: "FAKE Casey",
      hiddenAtMs: Date.UTC(2026, 9, 7, 12),
      documents: 3,
    },
    {
      id: "h2",
      displayName: "FAKE Drew",
      hiddenAtMs: Date.UTC(2026, 9, 8, 12),
      documents: 1,
    },
  ];

  it("shows nothing when nobody is hidden", () => {
    const { container } = render(
      <HiddenPeopleList
        hidden={[]}
        busy={false}
        readOnly={false}
        onRestore={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists who is hidden, since when and how many documents, and restores the one chosen", async () => {
    const user = userEvent.setup();
    setLocaleOverride("en");
    const onRestore = vi.fn();
    render(
      <HiddenPeopleList
        hidden={hidden}
        busy={false}
        readOnly={false}
        onRestore={onRestore}
      />,
    );
    const list = screen.getByRole("list", { name: en("hiddenPeople.list") });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("FAKE Casey");
    expect(rows[0].textContent).toContain("October 7, 2026");
    expect(visibleText(rows[0].textContent ?? "")).toContain(
      en("hiddenPeople.documents", { count: 3 }),
    );
    expect(visibleText(rows[1].textContent ?? "")).toContain(
      en("hiddenPeople.documents", { count: 1 }),
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText(en("hiddenPeople.restoreFor", { name: "FAKE Drew" })),
      }),
    );
    expect(onRestore).toHaveBeenCalledExactlyOnceWith("h2");
  });

  it("offers handing their records over only when the library can, and passes the person", async () => {
    const user = userEvent.setup();
    const onHandOver = vi.fn();
    const { rerender } = render(
      <HiddenPeopleList
        hidden={hidden}
        busy={false}
        readOnly={false}
        onRestore={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Hand/ })).toBeNull();
    rerender(
      <HiddenPeopleList
        hidden={hidden}
        busy={false}
        readOnly={false}
        onRestore={vi.fn()}
        onHandOver={onHandOver}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: humanText(en("hiddenPeople.handOverFor", { name: "FAKE Casey" })),
      }),
    );
    expect(onHandOver).toHaveBeenCalledExactlyOnceWith(hidden[0]);
  });

  it.each([
    ["busy", { busy: true, readOnly: false }],
    ["read-only", { busy: false, readOnly: true }],
  ])("restoring and handing over are off while %s", (_, state) => {
    render(
      <HiddenPeopleList
        hidden={hidden}
        {...state}
        onRestore={vi.fn()}
        onHandOver={vi.fn()}
      />,
    );
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
  });
});

describe("documents that arrived for a person while they were hidden", () => {
  const arrived = [
    { recordId: "r1", displayName: "FAKE Letter.pdf" },
    { recordId: "r2", displayName: "FAKE Result.pdf" },
  ];

  it("lists them by title, offers to move them to the person or leave them, and Escape leaves them", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const onLeave = vi.fn();
    render(
      <ArrivedWhileHiddenDialog
        name="FAKE Casey"
        arrived={arrived}
        onMove={onMove}
        onLeave={onLeave}
      />,
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: humanText(en("hiddenPeople.arrived.title", { name: "FAKE Casey" })),
    });
    const list = within(dialog).getByRole("list", {
      name: en("hiddenPeople.arrived.list"),
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["FAKE Letter.pdf", "FAKE Result.pdf"]);
    expect(
      within(dialog).getByText(
        humanText(
          en("hiddenPeople.arrived.body", { name: "FAKE Casey", count: 2 }),
        ),
      ),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(onLeave).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("button", {
        name: humanText(
          en("hiddenPeople.arrived.move", { name: "FAKE Casey" }),
        ),
      }),
    );
    expect(onMove).toHaveBeenCalledOnce();
    await user.click(
      within(dialog).getByRole("button", {
        name: en("hiddenPeople.arrived.leave"),
      }),
    );
    expect(onLeave).toHaveBeenCalledTimes(2);
  });
});
