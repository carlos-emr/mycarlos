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
      <h2 tabIndex={0}>Instructions</h2>
      <p tabIndex={0}>Read this first.</p>
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

describe("modal keyboard focus", () => {
  it("includes static text and all control types, skips unavailable content, wraps both ways and restores the opener", async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveFocus();
    await user.tab();
    expect(screen.getByText("Read this first.")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("More instructions")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("Notes")).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText("One")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link")).toHaveFocus();
    await user.tab();
    expect(heading).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("link")).toHaveFocus();
    opener.focus();
    await user.tab();
    expect(heading).toHaveFocus();
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
