import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SecretInput } from "./SecretInput";

function Field() {
  const [value, setValue] = useState("");
  const [shown, show] = useState(false);
  return (
    <>
      <label>
        Passphrase
        <SecretInput
          aria-label="Passphrase"
          value={value}
          type={shown ? "text" : "password"}
          aria-describedby="rules"
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <p id="rules">Use a long passphrase.</p>
      <button onClick={() => show(!shown)}>Toggle visibility</button>
    </>
  );
}

describe("secret input", () => {
  it("gives the character count on hover and focus without copying secrets into accessible metadata", async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByLabelText("Passphrase");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAccessibleName("Passphrase");
    expect(input).toHaveAttribute("title", "0 character password");
    await user.type(input, "FAKE secret");
    expect(input).toHaveAttribute("title", "11 character password");
    expect(input).toHaveAccessibleDescription(
      "11 character password Use a long passphrase.",
    );
    const count = screen.getByText("11 character password");
    expect(count).toHaveAttribute("tabindex", "0");
    await user.tab();
    expect(count).toHaveFocus();
    for (const attr of input.attributes) {
      if (attr.name.startsWith("aria-") || attr.name === "title")
        expect(attr.value).not.toContain("FAKE secret");
    }
    expect(document.body.textContent).not.toContain("FAKE secret");
    await user.click(screen.getByRole("button", { name: "Toggle visibility" }));
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("title", "11 character password, shown");
    await user.clear(input);
    expect(input).toHaveAttribute("title", "0 character password, shown");
    await user.click(screen.getByRole("button", { name: "Toggle visibility" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("counts Unicode characters and identifies recovery keys without exposing their value", () => {
    render(
      <SecretInput
        aria-label="Recovery key"
        secretKind="recovery key"
        value="A😀é"
        readOnly
      />,
    );
    const input = screen.getByLabelText("Recovery key");
    expect(input).toHaveAttribute("title", "3 character recovery key");
    expect(input).toHaveAccessibleDescription("3 character recovery key");
    expect(document.body.textContent).not.toContain("A😀é");
  });
});
