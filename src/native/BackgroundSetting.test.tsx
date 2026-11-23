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
    expect(
      screen.getByText(humanText(/Your vault locks as the window closes/)),
    ).toBeVisible();
    expect(native.invoke).toHaveBeenCalledWith("background_status", {
      locale: "en",
    });
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
