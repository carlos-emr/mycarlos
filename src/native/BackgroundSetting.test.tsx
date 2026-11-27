import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCALES, setLocaleOverride, translate } from "../i18n";
import { humanText } from "../test/humanText";
import { BackgroundSetting } from "./BackgroundSetting";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

const off = {
  supported: true,
  keepRunning: false,
  startAtLogin: false,
  trayReady: false,
  pausedWhileLocked: false,
};
beforeEach(() => {
  native.invoke.mockReset();
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  setLocaleOverride("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  setLocaleOverride(null);
});

const keep = () =>
  screen.findByRole("checkbox", {
    name: humanText(
      "Keep myCarlos running in the background after I close its window",
    ),
  });
const login = () =>
  screen.findByRole("checkbox", {
    name: humanText("Start myCarlos when I sign in to this computer"),
  });

describe("Running in the background", () => {
  it("is not shown where there is no background mode (a phone, or a browser)", async () => {
    native.invoke.mockResolvedValue({ ...off, supported: false });
    render(<BackgroundSetting />);
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("checkbox")).toBeNull();
    vi.unstubAllGlobals();
    native.invoke.mockClear();
    render(<BackgroundSetting />);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("offers two separate choices, both off, and tells the vault stays locked", async () => {
    native.invoke.mockResolvedValue({ ...off });
    render(<BackgroundSetting />);
    expect(await keep()).not.toBeChecked();
    expect(await login()).not.toBeChecked();
    expect(screen.queryByRole("status")).toBeNull();
    // The key fact is in view, in a sentence of its own.
    expect(
      screen.getByText(
        humanText(
          "myCarlos can stay in the background after you close its window. Your vault locks as the window closes.",
        ),
      ),
    ).toBeVisible();
    expect(native.invoke).toHaveBeenCalledWith("background_status", {
      locale: "en",
    });
  });

  it("folds the long explanation under More about running in the background: closed at first, opened, closed again", async () => {
    native.invoke.mockResolvedValue({ ...off });
    const user = userEvent.setup();
    render(<BackgroundSetting />);
    await keep();
    const long = screen.getByText(humanText(/Choose Quit from the icon/));
    const more = screen.getByText(
      humanText("More about running in the background"),
    );
    const details = more.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(long).not.toBeVisible();
    // The same, for a screen reader: the disclosure is a summary that says it is collapsed.
    expect(more.tagName).toBe("SUMMARY");
    // The keys themselves are the browser's own and are driven in tests/preferences-text.spec.ts.
    await user.click(more);
    expect(details.open).toBe(true);
    expect(long).toBeVisible();
    // The name does not change with the state: the browser announces open or closed.
    expect(more).toHaveTextContent("More about running in the background");
    await user.click(more);
    expect(details.open).toBe(false);
    expect(long).not.toBeVisible();
    expect(screen.queryByText(humanText("Less"))).toBeNull();
  });

  it("describes each box by its long explanation alone, which does not repeat the summary", async () => {
    native.invoke.mockResolvedValue({ ...off });
    render(<BackgroundSetting />);
    for (const [box, long, summary] of [
      [
        await keep(),
        /Choose Quit from the icon/,
        /Your vault locks as the window closes\.$/,
      ],
      [
        await login(),
        /starts quietly in the background/,
        /^myCarlos can start when you sign in/,
      ],
    ] as const) {
      const ids = (box.getAttribute("aria-describedby") ?? "").split(" ");
      expect(ids).toHaveLength(1);
      const description = document.getElementById(ids[0])?.textContent ?? "";
      expect(humanText(long)(description)).toBe(true);
      expect(summary.test(description)).toBe(false);
    }
  });

  it("says in view that starting at sign-in is quiet and keeps the vault locked", async () => {
    native.invoke.mockResolvedValue({ ...off });
    render(<BackgroundSetting />);
    await keep();
    expect(
      screen.getByText(
        humanText(
          "myCarlos can start when you sign in to this computer. With the choice above on, it starts quietly in the background with your vault locked.",
        ),
      ),
    ).toBeVisible();
  });

  it("turns each choice on on its own and shows that checks wait while locked", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "background_set_keep_running")
        return {
          ...off,
          keepRunning: true,
          trayReady: true,
          pausedWhileLocked: true,
        };
      if (command === "background_set_start_at_login")
        return { ...off, startAtLogin: true };
      return { ...off };
    });
    render(<BackgroundSetting />);
    const user = userEvent.setup();
    await user.click(await login());
    await waitFor(async () => expect(await login()).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith(
      "background_set_start_at_login",
      {
        enabled: true,
      },
    );
    expect(await keep()).not.toBeChecked();
    await user.click(await keep());
    await waitFor(async () => expect(await keep()).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith("background_set_keep_running", {
      enabled: true,
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "While your vault is locked, myCarlos cannot check for new clinic documents. Unlock it to check.",
    );
  });

  it("says so, and leaves the box off, when the icon cannot be made", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "background_set_keep_running") throw new Error("FAKE");
      return { ...off };
    });
    render(<BackgroundSetting />);
    await userEvent.setup().click(await keep());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A background icon is not available on this computer. myCarlos closes completely when you close its window.",
    );
    expect(await keep()).not.toBeChecked();
  });

  it("says a plain failure of the login choice and keeps it as it was", async () => {
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "background_set_start_at_login") throw new Error("FAKE");
      return { ...off };
    });
    render(<BackgroundSetting />);
    await userEvent.setup().click(await login());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This setting could not be changed. It stays as it was.",
    );
    expect(await login()).not.toBeChecked();
  });

  it("reports the language with each status request so the icon's menu is worded in it", async () => {
    native.invoke.mockResolvedValue({ ...off });
    render(<BackgroundSetting />);
    await keep();
    act(() => setLocaleOverride("fr"));
    await waitFor(() =>
      expect(native.invoke).toHaveBeenLastCalledWith("background_status", {
        locale: "fr",
      }),
    );
  });

  it("has its words in all seven languages", () => {
    for (const locale of LOCALES) {
      for (const key of [
        "background.title",
        "background.keepRunning",
        "background.keepRunningHelp",
        "background.startAtLogin",
        "background.startAtLoginHelp",
        "background.paused",
        "background.unavailable",
        "background.error",
      ] as const) {
        const text = translate(locale, key);
        expect(text.trim(), `${locale} ${key}`).not.toBe("");
        expect(text, `${locale} ${key}`).not.toBe(key);
      }
    }
    expect(translate("fr", "background.title")).toBe(
      "Exécution en arrière-plan",
    );
  });
});
