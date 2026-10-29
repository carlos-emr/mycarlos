import { humanText } from "../test/humanText";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateVault, ResetConfirmation, UnlockVault } from "./VaultAuth";

const restoreBridge = {
  pickRestoreSource: vi.fn().mockResolvedValue(null),
  inspectRestore: vi.fn(),
  restore: vi.fn(),
};

describe("CreateVault", () => {
  it("refuses a passphrase under the minimum as the vault counts it", () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(
      screen.getByLabelText(humanText("Whose records will you keep here?")),
      {
        target: { value: "Jamie" },
      },
    );
    // Fifteen code points typed with a decomposed accent are fourteen after NFC
    // normalization, which is the form the vault checks.
    const short = "café lanterns!";
    expect([...short].length).toBe(15);
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i)))
      fireEvent.change(field, { target: { value: short } });

    expect(screen.getByText(humanText(/too short/))).toBeVisible();
    const create = screen.getByRole("button", {
      name: humanText("Create vault"),
    });
    expect(create).toBeDisabled();
    fireEvent.submit(create.closest("form")!);
    expect(onCreate).not.toHaveBeenCalled();

    // Astral characters count once each, as the vault counts them.
    const astral = "\u{1F332}".repeat(15);
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i)))
      fireEvent.change(field, { target: { value: astral } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(create).toBeEnabled();
  });

  it("accepts a profile name of 120 characters that need two UTF-16 units each", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const profile = screen.getByLabelText(
      humanText("Whose records will you keep here?"),
    );
    fireEvent.change(profile, { target: { value: "\u{1F332}".repeat(120) } });
    expect(profile).toHaveValue("\u{1F332}".repeat(120));
    expect((profile as HTMLInputElement).maxLength).toBe(240);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(profile, { target: { value: "a".repeat(121) } });
    expect(screen.getByRole("alert")).toHaveHumanTextContent("too long");
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeDisabled();
  });

  it("refuses a profile name of only spaces, which the vault would refuse", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    fireEvent.change(
      screen.getByLabelText(humanText("Whose records will you keep here?")),
      {
        target: { value: "   " },
      },
    );
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i)))
      fireEvent.change(field, {
        target: { value: "river-azimuth-cobalt-sparrow-934" },
      });
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeDisabled();
  });

  it("reads the passphrase rules with the passphrase field", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription(
      /^0 character password Your passphrase needs to be: At least 15 characters\s*, not yet/,
    );
  });

  it("keeps an empty status line on the page without taking up space", () => {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    // The Create form's own; the checklist's is read by screen readers only,
    // and the last is under "Restore from a backup".
    const status = document.querySelector<HTMLElement>("form > [role=status]")!;
    expect(status).toBeEmptyDOMElement();
    expect(status.getBoundingClientRect().height).toBe(0);
    // The same 12px as between the other fields.
    const above = screen
      .getByRole("button", {
        name: humanText("Show passphrase in Confirm passphrase"),
      })
      .getBoundingClientRect();
    const create = screen
      .getByRole("button", { name: humanText("Create vault") })
      .getBoundingClientRect();
    expect(create.top - above.bottom).toBeCloseTo(12, 0);
  });

  it("does not silently shorten a long pasted passphrase", () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={onCreate}
      />,
    );
    fireEvent.change(
      screen.getByLabelText(humanText("Whose records will you keep here?")),
      {
        target: { value: "Jamie" },
      },
    );
    const long = "a".repeat(1025);
    for (const field of screen.getAllByLabelText(humanText(/passphrase/i))) {
      fireEvent.change(field, { target: { value: long } });
      expect(field).toHaveValue(long);
    }
    expect(screen.getByRole("alert")).toHaveHumanTextContent("too long");
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeDisabled();
  });
});

describe("CreateVault passphrase help (#69)", () => {
  const allMet = { longEnough: true, notAName: true, hardToGuess: true };
  const strong = "river azimuth cobalt sparrow 934";

  function renderCreate(
    checkRules = vi.fn().mockResolvedValue(allMet),
    onCreate = vi.fn().mockResolvedValue(undefined),
  ) {
    render(
      <CreateVault
        busy={false}
        notice=""
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onCreate={onCreate}
        checkRules={checkRules}
      />,
    );
    return { checkRules, onCreate };
  }
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(humanText(label)), {
      target: { value },
    });
  const rule = (name: string) =>
    screen.getByText(humanText(name)).closest("li")!;
  // Lets the pause pass, then the answer arrive.
  const pause = (ms = 300) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the rules before typing, read with the passphrase box", () => {
    renderCreate();
    for (const name of [
      "At least 15 characters",
      "Not easy to guess",
      "Not your name",
    ])
      expect(rule(name)).toHaveAttribute("data-met", "false");
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription(
      /At least 15 characters\s*, not yet Not easy to guess\s*, not yet Not your name\s*, not yet/,
    );
  });

  it("says too short while typing, before the confirmation is filled in", () => {
    renderCreate();
    type("Passphrase", "river");
    // Shown, and read with the box, but not an alert: that would interrupt a
    // screen reader at every keystroke.
    expect(screen.getByText(humanText(/too short/))).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription(/This passphrase is too short/);
    expect(rule("At least 15 characters")).toHaveAttribute("data-met", "false");
    type("Passphrase", strong);
    expect(screen.queryByText(humanText(/too short/))).not.toBeInTheDocument();
    expect(rule("At least 15 characters")).toHaveAttribute("data-met", "true");
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription(/At least 15 characters\s*, done/);
  });

  it("asks the vault once typing pauses, about what is typed now", async () => {
    vi.useFakeTimers();
    const { checkRules } = renderCreate(
      vi.fn().mockResolvedValue({ ...allMet, notAName: false }),
    );
    type("Whose records will you keep here?", "Jamie Rivers");
    type("Passphrase", "river azimuth");
    await pause(299);
    type("Passphrase", "river azimuth cobalt jamie 934");
    await pause(299);
    expect(checkRules).not.toHaveBeenCalled();
    await pause(1);
    expect(checkRules).toHaveBeenCalledExactlyOnceWith(
      "river azimuth cobalt jamie 934",
      "Jamie Rivers",
    );
    expect(rule("Not easy to guess")).toHaveAttribute("data-met", "true");
    expect(rule("Not your name")).toHaveAttribute("data-met", "false");
    // Create would only be refused, so it waits for a passphrase that passes.
    type("Confirm passphrase", "river azimuth cobalt jamie 934");
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeDisabled();

    // A change forgets the answer until the vault answers again.
    checkRules.mockResolvedValue(allMet);
    type("Passphrase", strong);
    expect(rule("Not easy to guess")).toHaveAttribute("data-met", "false");
    type("Confirm passphrase", strong);
    await pause();
    expect(rule("Not your name")).toHaveAttribute("data-met", "true");
    expect(
      screen.getByRole("button", { name: humanText("Create vault") }),
    ).toBeEnabled();
  });

  it("says once, politely, when every rule is met", async () => {
    vi.useFakeTimers();
    renderCreate();
    const said = () =>
      screen
        .getAllByRole("status")
        .find((status) => status.closest(".passphrase-checklist"))!;
    expect(said()).toBeEmptyDOMElement();
    type("Passphrase", strong);
    expect(said()).toBeEmptyDOMElement();
    await pause();
    expect(said()).toHaveHumanTextContent(
      "Your passphrase meets all the rules.",
    );
    // Typing on, the answer is forgotten until the next pause, but what was
    // said stands: it is not said again at every pause.
    type("Passphrase", `${strong} more`);
    expect(rule("Not easy to guess")).toHaveAttribute("data-met", "false");
    expect(said()).toHaveHumanTextContent(
      "Your passphrase meets all the rules.",
    );
    // Too short again takes it back.
    type("Passphrase", "river");
    expect(said()).toBeEmptyDOMElement();
  });

  it("drops an answer about a passphrase since changed", async () => {
    vi.useFakeTimers();
    let answer: (rules: typeof allMet) => void = () => undefined;
    const checkRules = vi.fn(
      () => new Promise<typeof allMet>((resolve) => (answer = resolve)),
    );
    renderCreate(checkRules);
    type("Passphrase", "password password");
    await pause();
    expect(checkRules).toHaveBeenCalledOnce();
    type("Passphrase", strong);
    await act(async () => answer(allMet));
    expect(rule("Not easy to guess")).toHaveAttribute("data-met", "false");
  });

  it("never asks again once Create is pressed", async () => {
    vi.useFakeTimers();
    const { checkRules, onCreate } = renderCreate();
    type("Whose records will you keep here?", "Jamie");
    type("Passphrase", strong);
    type("Confirm passphrase", strong);
    await pause();
    expect(checkRules).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: humanText("Create vault") }),
    );
    expect(onCreate).toHaveBeenCalledWith("Jamie", strong);
    await pause(5_000);
    expect(checkRules).toHaveBeenCalledOnce();
    // Nothing of the passphrase stays in the boxes.
    expect(screen.getByLabelText(humanText("Passphrase"))).toHaveValue("");
  });

  it("shows each box on its own, and hides both when the app is hidden", () => {
    renderCreate();
    const passphrase = screen.getByLabelText(humanText("Passphrase"));
    const confirmation = screen.getByLabelText(humanText("Confirm passphrase"));
    const show = screen.getByRole("button", {
      name: humanText("Show passphrase"),
    });
    const showConfirmation = screen.getByRole("button", {
      name: humanText("Show passphrase in Confirm passphrase"),
    });
    expect(show).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(show);
    expect(passphrase).toHaveAttribute("type", "text");
    expect(show).toHaveAttribute("aria-pressed", "true");
    expect(confirmation).toHaveAttribute("type", "password");
    fireEvent.click(showConfirmation);
    expect(confirmation).toHaveAttribute("type", "text");
    expect(showConfirmation).toHaveAttribute("aria-pressed", "true");
    // Shown, a passphrase is not handed to the spell checker, autocorrection
    // or keyboard learning.
    for (const box of [passphrase, confirmation]) {
      expect(box).toHaveAttribute("spellcheck", "false");
      expect(box).toHaveAttribute("autocorrect", "off");
      expect(box).toHaveAttribute("autocapitalize", "off");
      expect(box).toHaveAttribute("autocomplete", "off");
    }

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      fireEvent(document, new Event("visibilitychange"));
    } finally {
      visibility.mockRestore();
    }
    expect(passphrase).toHaveAttribute("type", "password");
    expect(confirmation).toHaveAttribute("type", "password");
    expect(show).toHaveAttribute("aria-pressed", "false");
  });
});

describe("UnlockVault", () => {
  it("says a passphrase over the vault's byte limit cannot be right instead of sending it", () => {
    const onUnlock = vi.fn().mockResolvedValue(undefined);
    render(
      <UnlockVault
        busy={false}
        notice=""
        autoLockMinutes={5}
        onUnlock={onUnlock}
        onRecover={vi.fn()}
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    // 600 characters need 1800 UTF-8 bytes, over the vault's 1024-byte limit.
    const passphrase = screen.getByLabelText(humanText("Passphrase"));
    fireEvent.change(passphrase, { target: { value: "字".repeat(600) } });

    expect(screen.getByRole("alert")).toHaveHumanTextContent(
      "longer than any vault passphrase",
    );
    const unlock = screen.getByRole("button", { name: humanText("Unlock") });
    expect(unlock).toBeDisabled();
    fireEvent.submit(unlock.closest("form")!);
    expect(onUnlock).not.toHaveBeenCalled();

    fireEvent.change(passphrase, { target: { value: "字".repeat(341) } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(unlock).toBeEnabled();
  });

  it("keeps its status line on the page, so that a new message is read out", () => {
    const props = {
      busy: false,
      autoLockMinutes: 5,
      onUnlock: vi.fn(),
      onRecover: vi.fn(),
      restoreBridge,
      onRestored: vi.fn(),
      onReset: vi.fn(),
    };
    const { rerender } = render(<UnlockVault {...props} notice="" />);
    // The Unlock form's; the other is under "Forgot your passphrase?".
    const status = screen.getAllByRole("status")[0];
    expect(status).toBeEmptyDOMElement();
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription("0 character password");

    rerender(<UnlockVault {...props} notice="FAKE wrong passphrase." />);
    expect(screen.getAllByRole("status")[0]).toBe(status);
    expect(status).toHaveHumanTextContent("FAKE wrong passphrase.");
  });

  it("reads the message it opens with as the focused field's description", () => {
    render(
      <UnlockVault
        busy={false}
        notice="Vault locked."
        autoLockMinutes={5}
        onUnlock={vi.fn()}
        onRecover={vi.fn()}
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const passphrase = screen.getByLabelText(humanText("Passphrase"));
    expect(passphrase).toHaveFocus();
    expect(passphrase).toHaveHumanAccessibleDescription(
      "0 character password Vault locked.",
    );
  });

  it("opens with the recovery key and a new passphrase, and answers there", () => {
    const onRecover = vi.fn().mockResolvedValue(undefined);
    const props = {
      busy: false,
      autoLockMinutes: 5,
      onUnlock: vi.fn(),
      onRecover,
      onReset: vi.fn(),
      restoreBridge,
      onRestored: vi.fn(),
    };
    const { rerender } = render(<UnlockVault {...props} notice="" />);
    fireEvent.change(screen.getByLabelText(humanText("Recovery key")), {
      target: { value: "abcd efgh jkmn pqrs tvwx yz01 2345" },
    });
    const replacement = screen.getByLabelText(humanText("New passphrase"));
    expect(replacement).toHaveHumanAccessibleDescription(
      /^0 character password Use at least 15 characters\./,
    );
    fireEvent.change(replacement, {
      target: { value: "lantern-orbit-willow-cascade-572" },
    });
    const open = screen.getByRole("button", {
      name: humanText("Open with recovery key"),
    });
    expect(open).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText(humanText("Confirm new passphrase")),
      {
        target: { value: "lantern-orbit-willow-cascade-572" },
      },
    );
    expect(open).toBeEnabled();
    fireEvent.click(open);
    expect(onRecover).toHaveBeenCalledWith(
      "abcd efgh jkmn pqrs tvwx yz01 2345",
      "lantern-orbit-willow-cascade-572",
    );

    // Its answer is next to the recovery key, not by Unlock.
    rerender(<UnlockVault {...props} notice="FAKE wrong recovery key." />);
    const [unlockStatus, forgotStatus] = screen.getAllByRole("status");
    expect(unlockStatus).toBeEmptyDOMElement();
    expect(forgotStatus).toHaveHumanTextContent("FAKE wrong recovery key.");
    expect(
      screen.getByLabelText(humanText("Passphrase")),
    ).toHaveHumanAccessibleDescription("0 character password");
    // The key is kept, so that a typo in it can be corrected.
    expect(screen.getByLabelText(humanText("Recovery key"))).toHaveValue(
      "abcd efgh jkmn pqrs tvwx yz01 2345",
    );
  });

  it("hides the recovery key as typed, and clears it when the app is hidden", () => {
    render(
      <UnlockVault
        busy={false}
        notice=""
        autoLockMinutes={5}
        onUnlock={vi.fn()}
        onRecover={vi.fn()}
        restoreBridge={restoreBridge}
        onRestored={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    const field = screen.getByLabelText(humanText("Recovery key"));
    expect(field).toHaveAttribute("type", "password");
    fireEvent.change(field, { target: { value: "ABCD-EFGH" } });
    const show = screen.getByRole("button", {
      name: humanText("Show recovery key"),
    });
    expect(show).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(show);
    expect(field).toHaveAttribute("type", "text");
    expect(show).toHaveAttribute("aria-pressed", "true");

    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    try {
      fireEvent(document, new Event("visibilitychange"));
    } finally {
      visibility.mockRestore();
    }
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("type", "password");
  });
});

describe("ResetConfirmation", () => {
  it("says what setting the vault aside does in plain words before the typed check (#69)", () => {
    const onReset = vi.fn().mockResolvedValue(undefined);
    render(
      <ResetConfirmation
        busy={false}
        actionLabel="Set vault aside"
        onReset={onReset}
      />,
    );
    const plainly = screen.getByText(
      humanText(/Setting the vault aside takes all your documents/),
    );
    const typed = screen.getByLabelText(humanText("Type RESET MYCARLOS VAULT"));
    expect(plainly).toHaveHumanTextContent(
      "its original passphrase or matching recovery key",
    );
    expect(plainly).toHaveHumanTextContent(
      "Starting a new vault does not change those credentials",
    );
    expect(plainly).not.toHaveHumanTextContent(
      "credentials for a new vault do not open it",
    );
    // The sentence comes first, so it is read before the box.
    expect(
      plainly.compareDocumentPosition(typed) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const erase = screen.getByRole("button", {
      name: humanText("Set vault aside"),
    });
    expect(erase).toBeDisabled();
    fireEvent.change(typed, { target: { value: "RESET MYCARLOS VAULT" } });
    fireEvent.click(erase);
    expect(onReset).toHaveBeenCalledWith("RESET MYCARLOS VAULT");
  });
});

for (const locale of LOCALES) {
  it(`keeps reset consent disabled for wrong or stale language text in ${locale}`, () => {
    setLocaleOverride(locale);
    const onReset = vi.fn().mockResolvedValue(undefined);
    render(
      <ResetConfirmation
        busy={false}
        actionLabel="FAKE action"
        onReset={onReset}
      />,
    );
    const field = screen.getByRole("textbox");
    const action = screen.getByRole("button", {
      name: humanText("FAKE action"),
    });
    const phrase = translate(locale, "native.reset.phrase");
    expect(
      screen.getByLabelText(
        humanText(translate(locale, "reset.type", { phrase })),
      ),
    ).toBe(field);
    fireEvent.change(field, { target: { value: phrase.toLowerCase() } });
    expect(action).toBeDisabled();
    fireEvent.change(field, { target: { value: " " + phrase } });
    expect(action).toBeDisabled();
    fireEvent.change(field, { target: { value: phrase.normalize("NFD") } });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledWith(phrase.normalize("NFD"));
    const next = locale === "en" ? "fr" : "en";
    act(() => setLocaleOverride(next));
    expect(screen.getByRole("textbox")).toBe(field);
    expect(field).toHaveValue(phrase.normalize("NFD"));
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
}
