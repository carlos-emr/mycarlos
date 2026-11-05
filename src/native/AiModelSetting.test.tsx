import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText, visibleText } from "../test/humanText";
import type { AcceptedModel, ModelStatus } from "../ai/types";
import { AiModelSetting } from "./AiModelSetting";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: null as null | ((event: { payload: unknown }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    native.listener = handler;
    return Promise.resolve(() => undefined);
  },
}));

const fake: AcceptedModel = {
  name: "FAKE model",
  fileName: "fake.gguf",
  sizeBytes: 2_500_000_000,
  sha256: "0".repeat(64),
  licence: "Apache-2.0",
  notices: [],
  sourceUrl: "https://example.invalid/fake.gguf",
};
const installed: ModelStatus = {
  state: "installed",
  model: { name: "FAKE model", sha256: fake.sha256 },
};

function answer(map: Record<string, unknown>) {
  native.invoke.mockImplementation((command: string) => {
    const value = map[command];
    return typeof value === "function"
      ? (value as () => Promise<unknown>)()
      : Promise.resolve(value);
  });
}

beforeEach(() => {
  native.invoke.mockReset();
  native.listener = null;
  setLocaleOverride("en");
});
afterEach(() => setLocaleOverride(null));

describe("Add a model file", () => {
  it("shows the accepted model, its size and licence, and the address as text to copy", async () => {
    answer({ ai_model_catalog: [fake] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await screen.findByText(
      humanText("FAKE model, 2,500 MB. Licence: Apache-2.0."),
    );
    expect(screen.getByText(fake.sourceUrl)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: humanText("Copy address") }),
    );
    expect(writeText).toHaveBeenCalledWith(fake.sourceUrl);
    await screen.findByText(humanText("Address copied"));
    vi.unstubAllGlobals();
  });

  it("adds a file, reports the new status and says so", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_add_picked: { outcome: "added", status: installed },
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: humanText("Add a model file…"),
      }),
    );
    await screen.findByText(humanText("Model added"));
    expect(onStatus).toHaveBeenCalledWith(installed);
    // The page sent no path.
    expect(native.invoke).toHaveBeenCalledWith("ai_model_add_picked");
  });

  it("shows progress while checking, with Cancel that stops the copy", async () => {
    let finish: (value: unknown) => void = () => undefined;
    answer({
      ai_model_catalog: [fake],
      ai_model_add_picked: () => new Promise((resolve) => (finish = resolve)),
      ai_model_add_cancel: null,
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    const add = await screen.findByRole("button", {
      name: humanText("Add a model file…"),
    });
    await userEvent.click(add);
    // Still focusable (aria-disabled), so the keyboard focus is not lost.
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add).toHaveFocus();
    await waitFor(() => expect(native.listener).not.toBeNull());
    act(() =>
      native.listener?.({
        payload: { done: 1_000_000_000, total: 2_500_000_000 },
      }),
    );
    await screen.findByText(humanText("Checking the file… 1,000 of 2,500 MB"));
    await userEvent.click(
      screen.getByRole("button", { name: humanText("Cancel") }),
    );
    expect(native.invoke).toHaveBeenCalledWith("ai_model_add_cancel");
    await act(async () => finish({ outcome: "cancelled" }));
    // A cancel is silent.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [
      "wrongHash",
      "This is not the file we expect. Download it again and add the new copy.",
    ],
    [
      "notListed",
      "This is not a file myCarlos accepts. Choose the model file listed above.",
    ],
    [
      "tooBig",
      "This is not a file myCarlos accepts. Choose the model file listed above.",
    ],
    [
      "noDisk",
      "There is not enough free space on this computer. The model needs about 4 GB.",
    ],
    [
      "incomplete",
      "The file could not be read completely. Check that it finished downloading, then try again.",
    ],
    ["busy", "The AI helper is working. Try again when it has finished."],
    ["storage", "The model could not be saved on this computer."],
  ])("explains a refusal: %s", async (outcome, text) => {
    answer({
      ai_model_catalog: [fake],
      ai_model_add_picked: { outcome },
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: humanText("Add a model file…"),
      }),
    );
    expect(
      visibleText((await screen.findByRole("alert")).textContent ?? ""),
    ).toBe(text);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("downloads the default model on a click, and says what is fetched and from where", async () => {
    answer({
      ai_model_catalog: [
        { ...fake, sourceUrl: "https://example.invalid/x/fake.gguf" },
      ],
      ai_model_download: { outcome: "added", status: installed },
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await screen.findByText(
      humanText(
        "Downloads one file (2,500 MB), once, from example.invalid, only when you click. Nothing about you or your documents is sent. The download site sees your internet address, as for any download.",
      ),
    );
    // Nothing is fetched until the click.
    expect(native.invoke).not.toHaveBeenCalledWith("ai_model_download");
    await userEvent.click(
      screen.getByRole("button", {
        name: humanText("Download the default model"),
      }),
    );
    await screen.findByText(humanText("Model added"));
    expect(onStatus).toHaveBeenCalledWith(installed);
  });

  it("labels a download's progress as downloading", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_download: () => new Promise(() => undefined),
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: humanText("Download the default model"),
      }),
    );
    await waitFor(() => expect(native.listener).not.toBeNull());
    act(() =>
      native.listener?.({
        payload: { done: 500_000_000, total: 2_500_000_000 },
      }),
    );
    await screen.findByText(
      humanText("Downloading and checking… 500 of 2,500 MB"),
    );
  });

  it.each([
    [
      "network",
      "The download did not finish. Check your internet connection and try again.",
    ],
    [
      "unavailable",
      "The model is not available at its address right now. Try again later, or add a file you already have.",
    ],
  ])("a download refusal says what happened: %s", async (outcome, text) => {
    answer({
      ai_model_catalog: [fake],
      ai_model_download: { outcome },
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: humanText("Download the default model"),
      }),
    );
    expect(
      visibleText((await screen.findByRole("alert")).textContent ?? ""),
    ).toBe(text);
  });

  it("keeps the keyboard focus in the row: Cancel while copying, the button again after a refusal", async () => {
    let finish: (value: unknown) => void = () => undefined;
    answer({
      ai_model_catalog: [fake],
      ai_model_download: () => new Promise((resolve) => (finish = resolve)),
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    const download = await screen.findByRole("button", {
      name: humanText("Download the default model"),
    });
    download.focus();
    await userEvent.keyboard("{Enter}");
    expect(download).toHaveFocus();
    await waitFor(() => expect(native.listener).not.toBeNull());
    act(() =>
      native.listener?.({ payload: { done: 1_000_000, total: 2_500_000_000 } }),
    );
    expect(
      await screen.findByRole("button", { name: humanText("Cancel") }),
    ).toHaveFocus();
    await act(async () => finish({ outcome: "network" }));
    await screen.findByRole("alert");
    expect(download).toHaveFocus();
  });

  it("a closed picker says nothing", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_add_picked: { outcome: "cancelled" },
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: humanText("Add a model file…"),
      }),
    );
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("ai_model_add_picked"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Remove the model", () => {
  it("asks first, then removes and reports the new status", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_remove: { state: "notInstalled" },
    });
    const onStatus = vi.fn();
    render(<AiModelSetting status={installed} onStatus={onStatus} />);
    expect(screen.getByText(humanText("Installed: FAKE model"))).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: humanText("Remove the model") }),
    );
    expect(native.invoke).not.toHaveBeenCalledWith("ai_model_remove");
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: humanText("Remove the model"),
      }),
    );
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith({ state: "notInstalled" }),
    );
  });

  it("puts the focus on Download after Remove", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_remove: { state: "notInstalled" },
    });
    function Host() {
      const [status, setStatus] = useState<ModelStatus>(installed);
      return <AiModelSetting status={status} onStatus={setStatus} />;
    }
    render(<Host />);
    await userEvent.click(
      screen.getByRole("button", { name: humanText("Remove the model") }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: humanText("Remove the model"),
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: humanText("Download the default model"),
      }),
    ).toHaveFocus();
  });

  it("says so when a run holds the model", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_remove: () => Promise.reject({ code: "busy" }),
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      screen.getByRole("button", { name: humanText("Remove the model") }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: humanText("Remove the model"),
      }),
    );
    expect(
      visibleText((await screen.findByRole("alert")).textContent ?? ""),
    ).toBe("The AI helper is working. Try again when it has finished.");
  });

  it("offers Remove, and no Add, for a damaged file", async () => {
    answer({ ai_model_catalog: [fake] });
    render(<AiModelSetting status={{ state: "damaged" }} onStatus={vi.fn()} />);
    expect(
      screen.getByText(
        humanText(
          "The model file is damaged or has changed. Remove it, then add it again.",
        ),
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: humanText("Remove the model") }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: humanText("Add a model file…") }),
    ).toBeNull();
  });
});

describe("A computer that cannot run the helper", () => {
  it.each([
    [
      "ram",
      "This computer does not have enough memory for the AI helper (it needs about 8 GB).",
    ],
    ["cpu", "This computer’s processor is not supported by the AI helper."],
    [
      "platform",
      "The AI helper is not available on this kind of computer yet.",
    ],
  ] as const)("says why (%s) and offers nothing", async (reason, text) => {
    answer({ ai_model_catalog: [fake] });
    render(
      <AiModelSetting
        status={{ state: "unsupported", reason }}
        onStatus={vi.fn()}
      />,
    );
    expect(screen.getByText(humanText(text))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
