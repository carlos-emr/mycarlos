import { humanText, visibleText } from "../test/humanText";
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
  it("counts passwords after NFC normalization without changing the input", () => {
    const value = "abcdefghijklm" + "e\u0301";
    render(<SecretInput aria-label="Passphrase" value={value} readOnly />);
    const input = screen.getByLabelText(humanText("Passphrase"));
    expect(input).toHaveValue(value);
    expect(visibleText(input.getAttribute("title") ?? "")).toBe(
      "14 character password",
    );
    expect(input).toHaveHumanAccessibleDescription("14 character password");
  });

  it("gives the character count on hover and in the field's description without copying secrets into accessible metadata", async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByLabelText(humanText("Passphrase"));
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveHumanAccessibleName("Passphrase");
    expect(visibleText(input.getAttribute("title") ?? "")).toBe(
      "0 character password",
    );
    await user.type(input, "FAKE secret");
    expect(visibleText(input.getAttribute("title") ?? "")).toBe(
      "11 character password",
    );
    expect(input).toHaveHumanAccessibleDescription(
      "11 character password Use a long passphrase.",
    );
    // The count is read with the field; it is text, not a Tab stop.
    const count = screen.getByText(humanText("11 character password"));
    expect(count).not.toHaveAttribute("tabindex");
    await user.tab();
    expect(
      screen.getByRole("button", { name: humanText("Toggle visibility") }),
    ).toHaveFocus();
    for (const attr of input.attributes) {
      if (attr.name.startsWith("aria-") || attr.name === "title")
        expect(attr.value).not.toContain("FAKE secret");
    }
    expect(document.body.textContent).not.toContain("FAKE secret");
    await user.click(
      screen.getByRole("button", { name: humanText("Toggle visibility") }),
    );
    expect(input).toHaveAttribute("type", "text");
    expect(visibleText(input.getAttribute("title") ?? "")).toBe(
      "11 character password, shown",
    );
    await user.clear(input);
    expect(visibleText(input.getAttribute("title") ?? "")).toBe(
      "0 character password, shown",
    );
    await user.click(
      screen.getByRole("button", { name: humanText("Toggle visibility") }),
    );
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
    const input = screen.getByLabelText(humanText("Recovery key"));
    expect(visibleText(input.getAttribute("title") ?? "")).toBe(
      "3 character recovery key",
    );
    expect(input).toHaveHumanAccessibleDescription("3 character recovery key");
    expect(document.body.textContent).not.toContain("A😀é");
  });
});
