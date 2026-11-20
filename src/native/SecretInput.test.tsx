import { humanText } from "../test/humanText";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { SecretInput } from "./SecretInput";
import "../styles.css";
import { LOCALES, setLocaleOverride, translate } from "../i18n";

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
  it.each([
    {
      kind: "password" as const,
      count: 10,
      key: "secret.count.password" as const,
    },
    {
      kind: "recovery key" as const,
      count: 11,
      key: "secret.count.recoveryKey" as const,
    },
  ])(
    "preserves literal $kind bytes, selection and private metadata through locale changes",
    ({ kind, count, key }) => {
      setLocaleOverride("en");
      // Password counting uses NFC, while recovery-key counting keeps the raw
      // characters. Neither may normalize or otherwise rewrite the input itself.
      const value = "FAKE e\u0301😀{x}";
      const view = (type: "password" | "text") => (
        <>
          <SecretInput
            aria-label="FAKE secret field"
            aria-describedby="FAKE-secret-help"
            value={value}
            secretKind={kind}
            type={type}
            readOnly
          />
          <p id="FAKE-secret-help">FAKE keep this private.</p>
        </>
      );
      const { rerender } = render(view("password"));
      const input = screen.getByLabelText(
        "FAKE secret field",
      ) as HTMLInputElement;
      const descriptionIds = input.getAttribute("aria-describedby");
      input.focus();
      input.setSelectionRange(2, 5);

      for (const type of ["password", "text"] as const) {
        rerender(view(type));
        for (const locale of LOCALES) {
          act(() => setLocaleOverride(locale));
          const counted = translate(locale, key, { count });
          const description =
            type === "password"
              ? counted
              : translate(locale, "secret.count.shown", {
                  description: counted,
                });
          expect(screen.getByLabelText("FAKE secret field")).toBe(input);
          expect(input).toHaveValue(value);
          expect(input).toHaveAttribute("type", type);
          expect(input).not.toHaveAttribute("title");
          expect(input).toHaveHumanAccessibleDescription(
            `${description} FAKE keep this private.`,
          );
          expect(input).toHaveAttribute("aria-describedby", descriptionIds);
          expect(input).toHaveFocus();
          expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
          for (const attribute of input.attributes)
            if (
              attribute.name.startsWith("aria-") ||
              attribute.name === "title"
            )
              expect(attribute.value).not.toContain(value);
          expect(document.body.textContent).not.toContain(value);
        }
      }
    },
  );

  it("counts passwords after NFC normalization without changing the input", () => {
    const value = "abcdefghijklm" + "e\u0301";
    render(<SecretInput aria-label="Passphrase" value={value} readOnly />);
    const input = screen.getByLabelText(humanText("Passphrase"));
    expect(input).toHaveValue(value);
    expect(input).toHaveHumanAccessibleDescription("14 character passphrase");
  });

  it("gives the character count in the field's description only, not on hover, without copying secrets into accessible metadata", async () => {
    const user = userEvent.setup();
    render(<Field />);
    const input = screen.getByLabelText(humanText("Passphrase"));
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveHumanAccessibleName("Passphrase");
    expect(input).not.toHaveAttribute("title");
    expect(input).toHaveHumanAccessibleDescription(
      "0 character passphrase Use a long passphrase.",
    );
    await user.type(input, "FAKE secret");
    expect(input).not.toHaveAttribute("title");
    expect(input).toHaveHumanAccessibleDescription(
      "11 character passphrase Use a long passphrase.",
    );
    // The count is read with the field; it is text, not a Tab stop.
    const count = screen.getByText(humanText("11 character passphrase"));
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
    expect(input).toHaveHumanAccessibleDescription(
      "11 character passphrase, shown Use a long passphrase.",
    );
    await user.clear(input);
    expect(input).toHaveHumanAccessibleDescription(
      "0 character passphrase, shown Use a long passphrase.",
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
    expect(input).toHaveHumanAccessibleDescription("3 character recovery key");
    expect(document.body.textContent).not.toContain("A😀é");
  });

  it("keeps the count in the accessible description but does not draw it", () => {
    render(<SecretInput aria-label="Passphrase" value="FAKE" readOnly />);
    const input = screen.getByLabelText(humanText("Passphrase"));
    const count = screen.getByText(humanText("4 character passphrase"));
    // Read with the field (its description), by the id the field points at ...
    expect(input.getAttribute("aria-describedby")).toBe(count.id);
    expect(input).toHaveHumanAccessibleDescription("4 character passphrase");
    // ... but visually hidden (the class), and no hover text repeats it.
    expect(count).toHaveClass("sr-only");
    expect(input).not.toHaveAttribute("title");
    // sr-only really takes it out of sight: one pixel, clipped, out of flow.
    const style = getComputedStyle(count);
    expect(style.position).toBe("absolute");
    expect(style.width).toBe("1px");
    expect(style.height).toBe("1px");
    expect(style.overflow).toBe("hidden");
  });
});
