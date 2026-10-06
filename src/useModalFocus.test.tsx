import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Dialog({ close }: { close: () => void }) {
  const ref = useRef<HTMLElement>(null);
  useModalFocus(true, ref, close);
  return (
    <section ref={ref} role="dialog" aria-modal="true" aria-label="Example">
      <h2>Instructions</h2>
      <p>Read this first.</p>
      <button hidden>Hidden</button>
      <button style={{ display: "none" }}>Not displayed</button>
      <div inert>
        <button>Inert</button>
      </div>
      <button disabled>Disabled</button>
      <details>
        <summary>More instructions</summary>
        <input aria-label="Closed detail" />
      </details>
      <textarea aria-label="Notes" />
      <label>
        <input type="radio" name="choice" defaultChecked />
        One
      </label>
      <label>
        <input type="radio" name="choice" />
        Two
      </label>
      <a href="#help">Help</a>
    </section>
  );
}
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && <Dialog close={() => setOpen(false)} />}
    </>
  );
}

function BoundaryDialog({
  radiosFirst,
  checked = true,
}: {
  radiosFirst: boolean;
  checked?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useModalFocus(true, ref, () => {});
  const radios = (
    <>
      <label>
        <input type="radio" name="edge" />
        First choice
      </label>
      <label>
        <input type="radio" name="edge" defaultChecked={checked} />
        Selected choice
      </label>
      <label>
        <input type="radio" name="edge" />
        Last choice
      </label>
    </>
  );
  return (
    <section ref={ref} role="dialog" aria-label="Radio boundary">
      {radiosFirst && radios}
      <button>Action</button>
      {!radiosFirst && radios}
    </section>
  );
}

function InterleavedRadioDialog({
  checked,
}: {
  checked: "first" | "last" | false;
}) {
  const ref = useRef<HTMLElement>(null);
  useModalFocus(true, ref, () => {});
  return (
    <section ref={ref} role="dialog" aria-label="Interleaved radios">
      <label>
        <input
          type="radio"
          name="interleaved"
          defaultChecked={checked === "first"}
        />
        Before action
      </label>
      <button>Intervening action</button>
      <label>
        <input
          type="radio"
          name="interleaved"
          defaultChecked={checked === "last"}
        />
        After action
      </label>
    </section>
  );
}

function InitialFocusDialog({ disabled }: { disabled: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const requested = useRef<HTMLInputElement>(null);
  useModalFocus(true, ref, () => {}, requested);
  return (
    <section ref={ref} role="dialog" aria-label="Initial focus">
      <input
        ref={requested}
        aria-label="Name"
        disabled={disabled}
        tabIndex={-1}
      />
      <button>Close</button>
    </section>
  );
}

describe("modal keyboard focus", () => {
  it.each(["first", "last"] as const)(
    "keeps a button between radio members reachable with %s selected",
    async (checked) => {
      const user = userEvent.setup();
      render(<InterleavedRadioDialog checked={checked} />);
      const action = screen.getByRole("button", { name: "Intervening action" });
      const selected = screen.getByLabelText(
        checked === "first" ? "Before action" : "After action",
      );
      expect(checked === "first" ? selected : action).toHaveFocus();
      selected.focus();
      await user.tab();
      expect(action).toHaveFocus();
      await user.tab();
      expect(selected).toHaveFocus();
      await user.tab({ shift: true });
      expect(action).toHaveFocus();
      await user.tab({ shift: true });
      expect(selected).toHaveFocus();
    },
  );

  it("keeps an intervening button reachable when no radio is selected", async () => {
    const user = userEvent.setup();
    render(<InterleavedRadioDialog checked={false} />);
    const action = screen.getByRole("button", { name: "Intervening action" });
    const first = screen.getByLabelText("Before action");
    const last = screen.getByLabelText("After action");
    first.focus();
    await user.tab();
    expect(action).toHaveFocus();
    last.focus();
    await user.tab({ shift: true });
    expect(action).toHaveFocus();
  });

  it.each([true, false])(
    "wraps unselected contiguous radio groups, radios first: %s",
    async (radiosFirst) => {
      const user = userEvent.setup();
      render(<BoundaryDialog radiosFirst={radiosFirst} checked={false} />);
      const action = screen.getByRole("button", { name: "Action" });
      screen.getByLabelText("First choice").focus();
      await user.tab();
      expect(action).toHaveFocus();
      screen.getByLabelText("Last choice").focus();
      await user.tab({ shift: true });
      expect(action).toHaveFocus();
    },
  );

  it("falls back inside the dialog when its explicit initial control is disabled", () => {
    render(<InitialFocusDialog disabled />);
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("allows an available explicit initial target outside the Tab sequence", () => {
    render(<InitialFocusDialog disabled={false} />);
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it.each([true, false])(
    "wraps at a checked radio group boundary, radios first: %s",
    async (radiosFirst) => {
      const user = userEvent.setup();
      render(<BoundaryDialog radiosFirst={radiosFirst} />);
      const selected = screen.getByLabelText("Selected choice");
      const action = screen.getByRole("button", { name: "Action" });
      expect(radiosFirst ? selected : action).toHaveFocus();
      selected.focus();
      await user.tab({ shift: radiosFirst });
      expect(action).toHaveFocus();
      await user.tab({ shift: !radiosFirst });
      expect(selected).toHaveFocus();
    },
  );

  it("skips static text and unavailable content, includes all control types, wraps both ways and restores the opener", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    // Text is not a Tab stop: the first control takes the first focus.
    const summary = screen.getByText("More instructions");
    expect(summary).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Notes")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("One")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link")).toHaveFocus();
    await user.tab();
    expect(summary).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("link")).toHaveFocus();
    opener.focus();
    await user.tab();
    expect(summary).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(opener).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("preserves reverse traversal through a radio group with no selection", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    (screen.getByLabelText("One") as HTMLInputElement).checked = false;
    screen.getByRole("link").focus();
    await user.tab({ shift: true });
    expect(screen.getByLabelText("Two")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByLabelText("Notes")).toHaveFocus();
  });

  it("keeps a focus target when every dialog control becomes unavailable", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog");
    for (const child of dialog.children) (child as HTMLElement).hidden = true;
    await user.tab();
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
