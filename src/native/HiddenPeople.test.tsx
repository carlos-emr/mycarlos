import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import { translate } from "../i18n";
import { HidePersonButton } from "./HiddenPeople";

const PERSON = { id: "p1", displayName: "FAKE Avery Example", createdAtMs: 1 };

describe("Hide on a person's line in Security (#360)", () => {
  afterEach(cleanup);

  it("is there for a person who can be hidden", () => {
    const onHide = vi.fn();
    render(
      <HidePersonButton
        person={PERSON}
        onlyOne={false}
        busy={false}
        readOnly={false}
        onHide={onHide}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: humanText(
          translate("en", "hiddenPeople.hideFor", { name: PERSON.displayName }),
        ),
      }),
    ).toBeEnabled();
  });

  it("is not drawn for the only person, and nothing explains it either", () => {
    const { container } = render(
      <HidePersonButton
        person={PERSON}
        onlyOne
        busy={false}
        readOnly={false}
        onHide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByText(humanText(translate("en", "hiddenPeople.lastPerson"))),
    ).toBeNull();
  });

  it("is disabled, not removed, while the library is busy or read-only", () => {
    for (const flags of [
      { busy: true, readOnly: false },
      { busy: false, readOnly: true },
    ]) {
      const { unmount } = render(
        <HidePersonButton
          person={PERSON}
          onlyOne={false}
          onHide={vi.fn()}
          {...flags}
        />,
      );
      expect(screen.getByRole("button")).toBeDisabled();
      unmount();
    }
  });
});
