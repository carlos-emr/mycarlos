import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocaleOverride } from "../i18n";
import { humanText, visibleText } from "../test/humanText";
import type { AcceptedModel, ModelRow, ModelStatus } from "../ai/types";
import { AiModelSetting } from "./AiModelSetting";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
  registerEnded: null as (() => Promise<void>) | null,
  onEnded: null as ((outcome: unknown) => void) | null,
  /** The progress event's listener. */
  get listener() {
    return this.listeners["ai-model-add-progress"] ?? null;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (
    name: string,
    handler: (event: { payload: unknown }) => void,
  ) => {
    if (name === "ai-model-add-ended" && native.registerEnded)
      await native.registerEnded();
    const listener = (event: { payload: unknown }) => {
      if (name === "ai-model-add-ended") native.onEnded?.(event.payload);
      handler(event);
    };
    native.listeners[name] = listener;
    return () => {
      if (native.listeners[name] === listener) delete native.listeners[name];
    };
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

function answer(
  map: Record<string, unknown>,
  initial: ModelStatus = { state: "notInstalled" },
  pickedIndex = 0,
) {
  const catalog = (map.ai_model_catalog as AcceptedModel[] | undefined) ?? [
    fake,
  ];
  let rows: ModelRow[] = Array.isArray(map.ai_models)
    ? structuredClone(map.ai_models)
    : catalog.map((model, index) => ({
        index,
        model,
        state:
          initial.state === "damaged"
            ? "damaged"
            : initial.state === "installed" &&
                model.sha256 === initial.model.sha256
              ? "installed"
              : "notDownloaded",
        inUse:
          initial.state === "installed" &&
          model.sha256 === initial.model.sha256,
        addedByYou: false,
      }));
  const added = (outcome: unknown, index = 0, picked = false) => {
    if ((outcome as { outcome?: string })?.outcome !== "added") return;
    const row = rows.find((entry) => entry.index === index);
    if (row) {
      row.state = "installed";
      row.addedByYou = picked;
      if (!rows.some((entry) => entry.inUse)) row.inUse = true;
    }
  };
  let activeIndex = 0;
  let pickedCopy = false;
  native.onEnded = (outcome) => added(outcome, activeIndex, pickedCopy);
  native.invoke.mockImplementation(
    (command: string, args?: { request?: { index: number } }) => {
      if (command === "ai_model_status" && !(command in map)) {
        const chosen = rows.find(
          (row) => row.inUse && row.state !== "notDownloaded",
        );
        return Promise.resolve(
          chosen?.state === "installed"
            ? {
                state: "installed",
                model: { name: chosen.model.name, sha256: chosen.model.sha256 },
              }
            : chosen?.state === "damaged"
              ? { state: "damaged" }
              : { state: "notInstalled" },
        );
      }
      if (command === "ai_models" && typeof map.ai_models !== "function")
        return Promise.resolve(structuredClone(rows));
      if (
        command === "ai_model_download" ||
        command === "ai_model_add_picked"
      ) {
        activeIndex =
          command === "ai_model_add_picked"
            ? pickedIndex
            : (args?.request?.index ?? 0);
        pickedCopy = command === "ai_model_add_picked";
      }
      const value = map[command];
      const result =
        typeof value === "function"
          ? (value as () => Promise<unknown>)()
          : Promise.resolve(value);
      return result.then((ended) => {
        const index = args?.request?.index ?? 0;
        if (
          command === "ai_model_download" ||
          command === "ai_model_add_picked"
        )
          added(
            ended,
            command === "ai_model_add_picked" ? pickedIndex : index,
            command === "ai_model_add_picked",
          );
        if (command === "ai_model_use" && ended)
          rows.forEach((row) => {
            row.inUse = row.index === index;
          });
        if (command === "ai_model_remove" && ended) {
          rows = rows.map((row) =>
            row.index === index
              ? {
                  ...row,
                  state: "notDownloaded",
                  inUse: false,
                  addedByYou: false,
                }
              : row,
          );
          if (!rows.some((row) => row.inUse)) {
            const first = rows.find((row) => row.state === "installed");
            if (first) first.inUse = true;
          }
        }
        return ended;
      });
    },
  );
}

beforeEach(() => {
  native.invoke.mockReset();
  native.listeners = {};
  native.registerEnded = null;
  native.onEnded = null;
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
      "This is not a file myCarlos accepts. Choose one of the model files listed above.",
    ],
    [
      "tooBig",
      "This is not a file myCarlos accepts. Choose one of the model files listed above.",
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
    expect(native.invoke).not.toHaveBeenCalledWith("ai_model_download", {
      request: { index: 0 },
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: /^Download /,
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
        name: /^Download /,
      }),
    );
    await waitFor(() => expect(native.listener).not.toBeNull());
    act(() =>
      native.listener?.({
        payload: { done: 500_000_000, total: 2_500_000_000 },
      }),
    );
    expect(visibleText(screen.getByRole("status").textContent ?? "")).toBe(
      "Downloading and checking… 500 of 2,500 MB",
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
        name: /^Download /,
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
      name: /^Download /,
    });
    download.focus();
    await userEvent.keyboard("{Enter}");
    // A disabled Download yields keyboard focus to the immediately available Cancel.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
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

describe("The progress bar (#275)", () => {
  const TOTAL = 3_013_000_000;
  const bar = () =>
    screen.queryByRole("progressbar", { name: humanText("Model download") });
  const tell = (done: number, total = TOTAL) =>
    act(() => native.listener?.({ payload: { done, total } }));
  async function startDownload(result: () => Promise<unknown>) {
    answer({
      ai_model_catalog: [{ ...fake, sizeBytes: TOTAL }],
      ai_model_download: result,
      ai_model_add_cancel: null,
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: /^Download /,
      }),
    );
    await waitFor(() => expect(native.listener).not.toBeNull());
  }

  it("fills from the same byte counts as the text, with a name and its value in words", async () => {
    await startDownload(() => new Promise(() => undefined));
    // Nothing before the first count.
    expect(bar()).toBeNull();
    tell(0);
    expect(bar()).toHaveAttribute("aria-valuenow", "0");
    tell(1_240_000_000);
    expect(visibleText(screen.getByRole("status").textContent ?? "")).toBe(
      "Downloading and checking… 1,240 of 3,013 MB",
    );
    expect(bar()).toHaveAttribute("aria-valuemin", "0");
    expect(bar()).toHaveAttribute("aria-valuemax", "100");
    expect(bar()).toHaveAttribute("aria-valuenow", "41");
    expect(visibleText(bar()!.getAttribute("aria-valuetext") ?? "")).toBe(
      "41%, 1,240 of 3,013 MB",
    );
    expect(screen.getByText(humanText("41%, 1,240 of 3,013 MB"))).toBeVisible();
    tell(TOTAL);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
    // Not a live region: the status text says the progress at its own pace.
    expect(
      bar()!.closest("[aria-live], [role=status], [role=alert]"),
    ).toBeNull();
    // Cancel sits beside it.
    expect(
      within(bar()!.parentElement!).getByRole("button", {
        name: humanText("Cancel"),
      }),
    ).toBeVisible();
  });

  it("disables the busy download and labels the final byte phase without starting another copy", async () => {
    await startDownload(() => new Promise(() => undefined));
    const downloading = screen.getByRole("button", {
      name: humanText("Downloading FAKE model"),
    });
    expect(downloading).toBeDisabled();
    tell(1_500_000_000);
    await userEvent.click(downloading);
    expect(
      native.invoke.mock.calls.filter(
        ([command]) => command === "ai_model_download",
      ),
    ).toHaveLength(1);
    tell(TOTAL);
    expect(
      screen.getByRole("button", { name: humanText("Installing FAKE model") }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Downloading and checking",
    );
    const counts = screen.getByText(humanText("100%, 3,013 of 3,013 MB"));
    expect(counts).toBeVisible();
    expect(counts).toHaveAttribute("aria-hidden", "true");
    expect(
      bar()!.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("starts a resumed download where it stopped", async () => {
    await startDownload(() => new Promise(() => undefined));
    // A resume's first count is what is already on disk.
    tell(1_500_000_000);
    expect(bar()).toHaveAttribute("aria-valuenow", "49");
  });

  it("shows for Add a model file's check too, and goes when it ends", async () => {
    let finish: (value: unknown) => void = () => undefined;
    answer({
      ai_model_catalog: [fake],
      ai_model_add_picked: () => new Promise((resolve) => (finish = resolve)),
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: humanText("Add a model file…"),
      }),
    );
    await waitFor(() => expect(native.listener).not.toBeNull());
    tell(1_000_000_000, 2_500_000_000);
    expect(bar()).toHaveAttribute("aria-valuenow", "40");
    expect(visibleText(bar()!.getAttribute("aria-valuetext") ?? "")).toBe(
      "40%, 1,000 of 2,500 MB",
    );
    await act(async () => finish({ outcome: "added", status: installed }));
    await screen.findByText(humanText("Model added"));
    expect(bar()).toBeNull();
  });

  it.each([
    ["cancelled", null],
    [
      "network",
      "The download did not finish. Check your internet connection and try again.",
    ],
  ])(
    "goes when the download ends %s, and the messages stay as they are",
    async (outcome, text) => {
      let finish: (value: unknown) => void = () => undefined;
      await startDownload(() => new Promise((resolve) => (finish = resolve)));
      tell(700_000_000);
      expect(bar()).not.toBeNull();
      await act(async () => finish({ outcome }));
      expect(bar()).toBeNull();
      if (text)
        expect(
          visibleText((await screen.findByRole("alert")).textContent ?? ""),
        ).toBe(text);
      else expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});

describe("A copy still running when the row opens again (#275)", () => {
  const TOTAL = 2_500_000_000;
  const bar = () =>
    screen.queryByRole("progressbar", { name: humanText("Model download") });
  const running = { kind: "download", done: 900_000_000, total: TOTAL };

  it("subscribes before querying and refreshes a copy that finished before subscription", async () => {
    let registered!: () => void;
    native.registerEnded = () =>
      new Promise((resolve) => (registered = resolve));
    answer({
      ai_model_catalog: [fake],
      ai_model_add_active: null,
      ai_model_status: installed,
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await screen.findByText(fake.sourceUrl);
    expect(native.invoke).not.toHaveBeenCalledWith("ai_model_add_active");
    await act(async () => registered());
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(installed));
    expect(bar()).toBeNull();
  });

  it("does not resurrect a stale active snapshot after completion during the query", async () => {
    let snapshot!: (now: unknown) => void;
    answer({
      ai_model_catalog: [fake],
      ai_model_add_active: () => new Promise((resolve) => (snapshot = resolve)),
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("ai_model_add_active"),
    );
    await act(async () => {
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      });
      snapshot(running);
    });
    await screen.findByText(humanText("Model added"));
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(installed);
    expect(bar()).toBeNull();
    expect(
      screen.getByRole("button", {
        name: /^Remove /,
      }),
    ).toHaveAttribute("aria-disabled", "false");
  });

  it("does not resurrect a stale busy snapshot after the running copy ends", async () => {
    let asked = 0;
    let snapshot!: (now: unknown) => void;
    answer({
      ai_model_catalog: [fake],
      ai_model_download: { outcome: "busy" },
      ai_model_add_active: () =>
        asked++ === 0
          ? Promise.resolve(null)
          : new Promise((resolve) => (snapshot = resolve)),
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await waitFor(() => expect(asked).toBe(1));
    await userEvent.click(
      await screen.findByRole("button", {
        name: /^Download /,
      }),
    );
    await waitFor(() => expect(asked).toBe(2));
    await act(async () => {
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      });
      snapshot(running);
    });
    await screen.findByText(humanText("Model added"));
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(installed);
    expect(bar()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps completion heard before a pending command is refused as busy", async () => {
    let refused!: (result: unknown) => void;
    answer({
      ai_model_catalog: [fake],
      ai_model_add_active: null,
      ai_model_download: () => new Promise((resolve) => (refused = resolve)),
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: /^Download /,
      }),
    );
    await act(async () => {
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      });
      refused({ outcome: "busy" });
    });
    await screen.findByText(humanText("Model added"));
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(installed);
    expect(bar()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not restore a removed model from a delayed hydration status", async () => {
    let reads = 0;
    let snapshot!: (status: ModelStatus) => void;
    answer(
      {
        ai_model_catalog: [fake],
        ai_model_add_active: null,
        ai_model_status: () =>
          ++reads === 1
            ? new Promise((resolve) => (snapshot = resolve))
            : Promise.resolve({ state: "notInstalled" }),
        ai_model_remove: { state: "notInstalled" },
      },
      installed,
    );
    const onStatus = vi.fn();
    render(<AiModelSetting status={installed} onStatus={onStatus} />);
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("ai_model_status"),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /^Remove / }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: /^Remove /,
      }),
    );
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledExactlyOnceWith({
        state: "notInstalled",
      }),
    );
    await act(async () => snapshot(installed));
    expect(onStatus).toHaveBeenCalledExactlyOnceWith({ state: "notInstalled" });
  });

  it.each(["cancelled", "notListed"] as const)(
    "keeps a model installed while a picker was open when the picker ends %s",
    async (outcome) => {
      let snapshot!: (now: unknown) => void;
      let picked!: (result: unknown) => void;
      answer({
        ai_model_catalog: [fake],
        ai_model_add_active: () =>
          new Promise((resolve) => (snapshot = resolve)),
        ai_model_add_picked: () => new Promise((resolve) => (picked = resolve)),
      });
      const onStatus = vi.fn();
      render(
        <AiModelSetting
          status={{ state: "notInstalled" }}
          onStatus={onStatus}
        />,
      );
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith("ai_model_add_active"),
      );
      await userEvent.click(
        await screen.findByRole("button", {
          name: humanText("Add a model file…"),
        }),
      );
      await act(async () => {
        native.listeners["ai-model-add-ended"]?.({
          payload: { outcome: "added", status: installed },
        });
        picked({ outcome });
        snapshot(running);
      });
      await waitFor(() =>
        expect(onStatus).toHaveBeenCalledExactlyOnceWith(installed),
      );
      expect(bar()).toBeNull();
      if (outcome === "cancelled")
        expect(screen.queryByRole("alert")).toBeNull();
      else
        expect(visibleText(screen.getByRole("alert").textContent ?? "")).toBe(
          "This is not a file myCarlos accepts. Choose one of the model files listed above.",
        );
    },
  );

  it("shows the download with its bar and Cancel, follows it, and hears how it ends", async () => {
    // The patient pressed Download, went to another page, and came back:
    // the row is new, and native still runs the download.
    let active: unknown = null;
    answer({
      ai_model_catalog: [fake],
      ai_model_download: () => new Promise(() => undefined),
      ai_model_add_active: () => Promise.resolve(active),
      ai_model_add_cancel: null,
    });
    const first = render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: /^Download /,
      }),
    );
    await waitFor(() => expect(native.listener).not.toBeNull());
    act(() =>
      native.listener?.({ payload: { done: 700_000_000, total: TOTAL } }),
    );
    expect(bar()).toHaveAttribute("aria-valuenow", "28");
    first.unmount();
    native.listeners = {};

    active = running;
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await screen.findByText(
      humanText("Downloading and checking… 900 of 2,500 MB"),
    );
    expect(bar()).toHaveAttribute("aria-valuenow", "36");
    expect(
      screen.getByRole("button", { name: humanText("Cancel") }),
    ).toBeVisible();
    // Its buttons can't start a second copy.
    expect(
      screen
        .getByRole("button", { name: /^Download / })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
    // It follows the copy's progress, then hears how it ended.
    act(() =>
      native.listener?.({ payload: { done: 1_000_000_000, total: TOTAL } }),
    );
    expect(bar()).toHaveAttribute("aria-valuenow", "40");
    act(() =>
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      }),
    );
    await screen.findByText(humanText("Model added"));
    expect(onStatus).toHaveBeenCalledWith(installed);
    expect(bar()).toBeNull();
  });

  it("Cancel there stops the copy that runs", async () => {
    answer({
      ai_model_catalog: [fake],
      ai_model_add_active: running,
      ai_model_add_cancel: null,
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: humanText("Cancel") }),
    );
    expect(native.invoke).toHaveBeenCalledWith("ai_model_add_cancel");
    act(() =>
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "cancelled" },
      }),
    );
    await waitFor(() => expect(bar()).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a press while it runs shows that copy and says it is still downloading", async () => {
    let asked = 0;
    answer({
      ai_model_catalog: [fake],
      ai_model_download: { outcome: "busy" },
      // Not yet when the row opens; running when the press is refused.
      ai_model_add_active: () =>
        Promise.resolve(asked++ === 0 ? null : running),
    });
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: /^Download /,
      }),
    );
    expect(
      visibleText((await screen.findByRole("alert")).textContent ?? ""),
    ).toBe("The model is still downloading.");
    expect(bar()).toHaveAttribute("aria-valuenow", "36");
    expect(
      screen.queryByText(humanText(/The AI helper is working/)),
    ).toBeNull();
  });
});

describe("Remove the model", () => {
  it("asks first, then removes and reports the new status", async () => {
    answer(
      {
        ai_model_catalog: [fake],
        ai_model_remove: { state: "notInstalled" },
      },
      installed,
    );
    const onStatus = vi.fn();
    render(<AiModelSetting status={installed} onStatus={onStatus} />);
    expect(
      await screen.findByRole("radio", { name: "FAKE model" }),
    ).toBeChecked();
    await userEvent.click(
      await screen.findByRole("button", { name: /^Remove / }),
    );
    expect(native.invoke).not.toHaveBeenCalledWith("ai_model_remove");
    expect(native.invoke).not.toHaveBeenCalledWith("ai_model_remove", {
      request: { index: 0 },
    });
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: /^Remove /,
      }),
    );
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith({ state: "notInstalled" }),
    );
  });

  it("puts the focus on Download after Remove", async () => {
    answer(
      {
        ai_model_catalog: [fake],
        ai_model_remove: { state: "notInstalled" },
      },
      installed,
    );
    function Host() {
      const [status, setStatus] = useState<ModelStatus>(installed);
      return <AiModelSetting status={status} onStatus={setStatus} />;
    }
    render(<Host />);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Remove / }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: /^Remove /,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: /^Download /,
      }),
    ).toHaveFocus();
  });

  it("says so when a run holds the model", async () => {
    answer(
      {
        ai_model_catalog: [fake],
        ai_model_remove: () => Promise.reject({ code: "busy" }),
      },
      installed,
    );
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Remove / }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: /^Remove /,
      }),
    );
    expect(
      visibleText((await screen.findByRole("alert")).textContent ?? ""),
    ).toBe("The AI helper is working. Try again when it has finished.");
  });

  it("offers Remove, and no Add, for a damaged file", async () => {
    answer({ ai_model_catalog: [fake] }, { state: "damaged" });
    render(<AiModelSetting status={{ state: "damaged" }} onStatus={vi.fn()} />);
    expect(
      await screen.findByText(
        humanText(
          "The model file is damaged or has changed. Remove it, then add it again.",
        ),
      ),
    ).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: /^Remove / }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: humanText("Add a model file…") }),
    ).toBeVisible();
    // A damaged catalogue row is repaired through Remove; the global picker
    // remains available for another verified catalogue file.
    expect(
      within(screen.getByRole("region", { name: fake.name })).queryByRole(
        "button",
        { name: humanText("Add a model file…") },
      ),
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

describe("Device model catalog (#276A)", () => {
  const second: AcceptedModel = {
    ...fake,
    name: "FAKE Gemma",
    fileName: "FAKE-gemma.gguf",
    sha256: "1".repeat(64),
    sizeBytes: 2_800_000_000,
    sourceUrl: "https://example.invalid/FAKE-gemma.gguf",
  };
  const usedSecond: ModelStatus = {
    state: "installed",
    model: { name: second.name, sha256: second.sha256 },
  };
  const entries = (both = true): ModelRow[] => [
    {
      index: 0,
      model: fake,
      state: "installed",
      inUse: true,
      addedByYou: false,
    },
    {
      index: 1,
      model: second,
      state: both ? "installed" : "notDownloaded",
      inUse: false,
      addedByYou: false,
    },
  ];
  const region = (name: string) => screen.getByRole("region", { name });
  const radio = (name: string) => screen.getByRole("radio", { name });

  for (const outcome of ["committed", "rejected", "superseded"] as const) {
    it(`reconciles a switch ${outcome} after its initiating view closes`, async () => {
      const chosen = entries().map((row) => ({
        ...row,
        inUse: row.index === 1,
      }));
      let currentRows = entries();
      let currentStatus = installed;
      let finish!: () => void;
      let switches = 0;
      const readRows = vi.fn(() =>
        Promise.resolve(structuredClone(currentRows)),
      );
      answer({
        ai_models: readRows,
        ai_model_status: () => Promise.resolve(currentStatus),
        ai_model_add_active: null,
        ai_model_use: () => {
          if (++switches === 1)
            return new Promise((resolve, reject) => {
              finish = () =>
                outcome === "rejected"
                  ? reject({ code: "busy" })
                  : resolve(usedSecond);
            });
          currentRows = entries();
          currentStatus = installed;
          return Promise.resolve(installed);
        },
      });
      const oldStatus = vi.fn();
      const first = render(
        <AiModelSetting status={installed} onStatus={oldStatus} />,
      );
      await userEvent.click(
        await screen.findByRole("radio", { name: second.name }),
      );
      first.unmount();
      // In the stale-delivery case the native commit precedes the reply.
      if (outcome === "superseded") {
        currentRows = chosen;
        currentStatus = usedSecond;
      }
      const onStatus = vi.fn();
      render(<AiModelSetting status={installed} onStatus={onStatus} />);
      await screen.findByRole("radio", { name: second.name });
      await waitFor(() =>
        expect(
          radio(outcome === "superseded" ? second.name : fake.name),
        ).toBeChecked(),
      );
      if (outcome === "superseded") {
        await userEvent.click(radio(fake.name));
        await waitFor(() => expect(radio(fake.name)).toBeChecked());
        expect(onStatus).toHaveBeenLastCalledWith(installed);
      }
      const before = readRows.mock.calls.length;
      if (outcome === "committed") {
        currentRows = chosen;
        currentStatus = usedSecond;
      }
      await act(async () => finish());
      await waitFor(() =>
        expect(readRows.mock.calls.length).toBeGreaterThan(before),
      );
      expect(
        radio(outcome === "committed" ? second.name : fake.name),
      ).toBeChecked();
      if (outcome === "committed")
        expect(onStatus).toHaveBeenLastCalledWith(usedSecond);
      else if (outcome === "rejected")
        expect(onStatus).not.toHaveBeenCalledWith(usedSecond);
      else expect(onStatus).toHaveBeenLastCalledWith(installed);
      expect(oldStatus).not.toHaveBeenCalled();
    });
  }

  for (const snapshot of ["already empty", "delayed empty"] as const) {
    it(`owns a download first seen in progress after an ${snapshot} activity snapshot`, async () => {
      let empty!: (value: null) => void;
      answer({
        ai_models: entries(false),
        ai_model_add_active: () =>
          snapshot === "delayed empty"
            ? new Promise((resolve) => {
                empty = resolve;
              })
            : Promise.resolve(null),
      });
      render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
      await screen.findByRole("button", { name: "Download FAKE Gemma" });
      await waitFor(() =>
        expect(native.invoke).toHaveBeenCalledWith("ai_model_add_active"),
      );
      act(() =>
        native.listener?.({
          payload: { index: 1, done: 1_400_000_000, total: 2_800_000_000 },
        }),
      );
      if (snapshot === "delayed empty") await act(async () => empty(null));
      const row = region(second.name);
      expect(
        within(row).getByRole("button", { name: "Downloading FAKE Gemma" }),
      ).toBeDisabled();
      expect(within(row).getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "50",
      );
      expect(within(row).getByRole("button", { name: "Cancel" })).toBeVisible();
      expect(row).toHaveTextContent("Downloading");
      expect(screen.getByRole("status")).toHaveTextContent(
        "Downloading and checking",
      );
      expect(screen.getByRole("status")).not.toHaveTextContent(
        "Checking the file",
      );
      act(() =>
        native.listener?.({
          payload: { index: 1, done: 2_800_000_000, total: 2_800_000_000 },
        }),
      );
      expect(
        within(row).getByRole("button", { name: "Installing FAKE Gemma" }),
      ).toBeDisabled();
      act(() =>
        native.listeners["ai-model-add-ended"]?.({
          payload: { outcome: "cancelled" },
        }),
      );
      await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
      expect(
        within(region(second.name)).getByRole("button", {
          name: "Download FAKE Gemma",
        }),
      ).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    });
  }

  it("keeps an index-less picked-file check global after an empty activity snapshot", async () => {
    answer({ ai_models: entries(false), ai_model_add_active: null });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await screen.findByRole("button", { name: "Download FAKE Gemma" });
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("ai_model_add_active"),
    );
    act(() =>
      native.listener?.({
        payload: { done: 1_400_000_000, total: 2_800_000_000 },
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking the file");
    expect(within(region(second.name)).queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });

  for (const operation of ["use", "remove", "failure"] as const) {
    it(`reconciles ${operation} after an older completion during its native request`, async () => {
      let currentRows = entries();
      let currentStatus = installed;
      let settle!: () => void;
      answer({
        ai_models: () => Promise.resolve(structuredClone(currentRows)),
        ai_model_status: () => Promise.resolve(currentStatus),
        ai_model_add_active: () => new Promise(() => undefined),
        [operation === "remove" ? "ai_model_remove" : "ai_model_use"]: () =>
          new Promise((resolve, reject) => {
            settle = () => {
              currentRows = entries().map((row) => ({
                ...row,
                inUse: row.index === 1,
                ...(operation === "remove" && row.index === 0
                  ? { state: "notDownloaded" as const }
                  : {}),
              }));
              currentStatus = usedSecond;
              if (operation === "failure") reject({ code: "busy" });
              else resolve(currentStatus);
            };
          }),
      });
      const onStatus = vi.fn();
      render(<AiModelSetting status={installed} onStatus={onStatus} />);
      await screen.findByRole("radio", { name: second.name });
      if (operation === "remove") {
        await userEvent.click(
          screen.getByRole("button", { name: "Remove FAKE model" }),
        );
        await userEvent.click(
          within(screen.getByRole("alertdialog")).getByRole("button", {
            name: "Remove FAKE model",
          }),
        );
      } else await userEvent.click(radio(second.name));
      act(() =>
        native.listeners["ai-model-add-ended"]?.({
          payload: { outcome: "added", status: installed },
        }),
      );
      expect(radio(second.name)).toHaveAttribute("aria-disabled", "true");
      await act(async () => settle());
      await waitFor(() => expect(radio(second.name)).toBeChecked());
      expect(onStatus).toHaveBeenLastCalledWith(usedSecond);
      if (operation === "remove") expect(radio(fake.name)).toBeDisabled();
      if (operation === "failure")
        expect(screen.getByRole("alert")).toHaveTextContent(
          "The AI helper is working",
        );
      expect(screen.getByRole("status")).not.toHaveTextContent("Model added");
    });
  }

  it("reconciles a historical completion delivered after the choice has settled", async () => {
    let currentRows = entries();
    let currentStatus = installed;
    answer({
      ai_models: () => Promise.resolve(structuredClone(currentRows)),
      ai_model_status: () => Promise.resolve(currentStatus),
      ai_model_add_active: () => new Promise(() => undefined),
      ai_model_use: () => {
        currentRows = entries().map((row) => ({
          ...row,
          inUse: row.index === 1,
        }));
        currentStatus = usedSecond;
        return Promise.resolve(usedSecond);
      },
    });
    const onStatus = vi.fn();
    render(<AiModelSetting status={installed} onStatus={onStatus} />);
    await userEvent.click(
      await screen.findByRole("radio", { name: second.name }),
    );
    await waitFor(() => expect(radio(second.name)).toBeChecked());
    act(() =>
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      }),
    );
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith(usedSecond));
    expect(radio(second.name)).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Model in use changed",
    );
  });

  for (const failedHalf of ["status", "rows"] as const) {
    it(`publishes no half pair when ${failedHalf} fails; explicit Retry reads both`, async () => {
      let changed = false;
      let fail = false;
      const statusRead = vi.fn(() =>
        fail && failedHalf === "status"
          ? Promise.reject(new Error("FAKE unreadable status"))
          : Promise.resolve(changed ? usedSecond : installed),
      );
      const rowsRead = vi.fn(() =>
        fail && failedHalf === "rows"
          ? Promise.reject(new Error("FAKE unreadable rows"))
          : Promise.resolve(
              entries().map((row) => ({
                ...row,
                inUse: changed ? row.index === 1 : row.index === 0,
              })),
            ),
      );
      answer({
        ai_models: rowsRead,
        ai_model_status: statusRead,
        ai_model_add_active: () => new Promise(() => undefined),
        ai_model_use: () => {
          changed = true;
          fail = true;
          return Promise.resolve(usedSecond);
        },
      });
      const onStatus = vi.fn();
      render(<AiModelSetting status={installed} onStatus={onStatus} />);
      await userEvent.click(
        await screen.findByRole("radio", { name: second.name }),
      );
      await screen.findByRole("alert");
      expect(radio(fake.name)).toBeChecked();
      expect(onStatus).not.toHaveBeenCalledWith(usedSecond);
      const beforeStatus = statusRead.mock.calls.length;
      const beforeRows = rowsRead.mock.calls.length;
      fail = false;
      await userEvent.click(
        screen.getByRole("button", { name: "Read the model list again" }),
      );
      await waitFor(() => expect(radio(second.name)).toBeChecked());
      expect(onStatus).toHaveBeenLastCalledWith(usedSecond);
      expect(statusRead.mock.calls.length).toBe(beforeStatus + 1);
      expect(rowsRead.mock.calls.length).toBe(beforeRows + 1);
      expect(screen.queryByRole("alert")).toBeNull();
    });
  }

  for (const ending of [
    "completion",
    "unmount",
    "read failure after completion",
  ] as const) {
    it(`guards an in-flight reconciliation against ${ending}`, async () => {
      let changed = false;
      let statusReads = 0;
      let rowReads = 0;
      let releaseStatus!: (status: ModelStatus) => void;
      let releaseRows!: (rows: ModelRow[]) => void;
      const chosen = entries().map((row) => ({
        ...row,
        inUse: row.index === 1,
      }));
      answer({
        ai_models: () => {
          if (!changed) return Promise.resolve(entries());
          return ++rowReads === 1
            ? new Promise((resolve) => {
                releaseRows = resolve;
              })
            : Promise.resolve(chosen);
        },
        ai_model_status: () =>
          ++statusReads === 1
            ? new Promise((resolve, reject) => {
                releaseStatus = (value) =>
                  ending === "read failure after completion"
                    ? reject(new Error("FAKE superseded read failure"))
                    : resolve(value);
              })
            : Promise.resolve(usedSecond),
        ai_model_add_active: () => new Promise(() => undefined),
        ai_model_use: () => {
          changed = true;
          return Promise.resolve(usedSecond);
        },
      });
      const onStatus = vi.fn();
      const view = render(
        <AiModelSetting status={installed} onStatus={onStatus} />,
      );
      await userEvent.click(
        await screen.findByRole("radio", { name: second.name }),
      );
      await waitFor(() => expect(rowReads).toBe(1));
      if (ending === "unmount") view.unmount();
      else
        act(() =>
          native.listeners["ai-model-add-ended"]?.({
            payload: { outcome: "added", status: installed },
          }),
        );
      await act(async () => {
        releaseRows(entries());
        releaseStatus(installed);
      });
      if (ending === "unmount") expect(onStatus).not.toHaveBeenCalled();
      else {
        await waitFor(() => expect(radio(second.name)).toBeChecked());
        expect(onStatus).toHaveBeenCalledExactlyOnceWith(usedSecond);
        expect(rowReads).toBe(2);
        expect(statusReads).toBe(2);
        expect(screen.getByRole("status")).toHaveTextContent(
          "Model in use changed",
        );
      }
    });
  }

  it("lists every offered model with size, licence, device choice and Add even when installed", async () => {
    answer({ ai_models: entries(false) });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    const group = await screen.findByRole("radiogroup", {
      name: "Model in use",
    });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(radio(fake.name)).toBeChecked();
    expect(radio(second.name)).toBeDisabled();
    expect(visibleText(region(second.name).textContent ?? "")).toContain(
      "2,800 MB",
    );
    expect(region(second.name)).toHaveTextContent("Apache-2.0");
    expect(region(second.name)).toHaveTextContent("Not downloaded");
    expect(
      within(region(second.name)).getByRole("button", {
        name: "Download FAKE Gemma",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Add a model file…" }),
    ).toBeVisible();
    expect(
      native.invoke.mock.calls.some(
        ([command]) => command === "ai_model_download",
      ),
    ).toBe(false);
  });

  it("switches by native index, keeps focus and waits for the persisted choice", async () => {
    let finish!: (status: ModelStatus) => void;
    answer({
      ai_models: entries(),
      ai_model_use: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const onStatus = vi.fn();
    render(<AiModelSetting status={installed} onStatus={onStatus} />);
    await screen.findByRole("radio", { name: second.name });
    await userEvent.click(radio(second.name));
    expect(native.invoke).toHaveBeenCalledWith("ai_model_use", {
      request: { index: 1 },
    });
    expect(radio(fake.name)).toBeChecked();
    expect(radio(second.name)).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish(usedSecond));
    await waitFor(() => expect(radio(second.name)).toBeChecked());
    expect(radio(second.name)).toHaveFocus();
    expect(onStatus).toHaveBeenCalledWith(usedSecond);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Model in use changed",
    );
  });

  it("keyboard radio navigation chooses the other installed model", async () => {
    answer({ ai_models: entries(), ai_model_use: usedSecond });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    const first = await screen.findByRole("radio", { name: fake.name });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(radio(second.name)).toBeChecked());
    expect(native.invoke).toHaveBeenCalledWith("ai_model_use", {
      request: { index: 1 },
    });
    expect(radio(second.name)).toHaveFocus();
  });

  it("a refused switch leaves the original radio checked and says why", async () => {
    answer({
      ai_models: entries(),
      ai_model_use: () => Promise.reject({ code: "busy" }),
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await screen.findByRole("radio", { name: second.name });
    await userEvent.click(radio(second.name));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The AI helper is working",
    );
    expect(radio(fake.name)).toBeChecked();
    expect(radio(second.name)).not.toBeChecked();
  });

  it("downloads A while B stays In use, then keeps both installed", async () => {
    let finish!: (outcome: unknown) => void;
    answer({
      ai_models: entries(false),
      ai_model_download: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const onStatus = vi.fn();
    render(<AiModelSetting status={installed} onStatus={onStatus} />);
    const announcer = screen.getByRole("status");
    await userEvent.click(
      await screen.findByRole("button", { name: "Download FAKE Gemma" }),
    );
    expect(native.invoke).toHaveBeenCalledWith("ai_model_download", {
      request: { index: 1 },
    });
    act(() =>
      native.listener?.({
        payload: { done: 1_400_000_000, total: second.sizeBytes, index: 1 },
      }),
    );
    expect(
      within(region(second.name)).getByRole("progressbar"),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByRole("status")).toBe(announcer);
    expect(announcer).toHaveTextContent("Downloading and checking");
    expect(within(region(fake.name)).queryByRole("progressbar")).toBeNull();
    expect(radio(fake.name)).toBeChecked();
    await act(async () => finish({ outcome: "added", status: installed }));
    await screen.findByRole("button", { name: "Remove FAKE Gemma" });
    expect(radio(fake.name)).toBeChecked();
    expect(radio(second.name)).toBeEnabled();
    expect(onStatus).toHaveBeenCalledWith(installed);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("remounts the correct download row and resets it when Cancel ends the copy", async () => {
    answer({
      ai_models: entries(false),
      ai_model_add_active: {
        kind: "download",
        index: 1,
        done: 1_400_000_000,
        total: second.sizeBytes,
      },
      ai_model_add_cancel: null,
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await screen.findByRole("progressbar");
    expect(
      screen.getByRole("button", { name: "Downloading FAKE Gemma" }),
    ).toBeDisabled();
    expect(
      within(region(second.name)).getByRole("progressbar"),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(within(region(fake.name)).queryByRole("progressbar")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(native.invoke).toHaveBeenCalledWith("ai_model_add_cancel");
    act(() =>
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "cancelled" },
      }),
    );
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(radio(fake.name)).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Download FAKE Gemma" }),
    ).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an accepted picked file adds a second row without replacing the one in use", async () => {
    answer(
      {
        ai_models: entries(false),
        ai_model_add_picked: { outcome: "added", status: installed },
      },
      installed,
      1,
    );
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a model file…" }),
    );
    await screen.findByRole("button", { name: "Remove FAKE Gemma" });
    expect(region(second.name)).toHaveTextContent("Added by you");
    expect(radio(fake.name)).toBeChecked();
    expect(radio(second.name)).toBeEnabled();
    expect(native.invoke).toHaveBeenCalledWith("ai_model_add_picked");
  });

  it("removing an inactive model preserves the model in use", async () => {
    answer({ ai_models: entries(), ai_model_remove: installed });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove FAKE Gemma" }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove FAKE Gemma",
      }),
    );
    await screen.findByRole("button", { name: "Download FAKE Gemma" });
    expect(native.invoke).toHaveBeenCalledWith("ai_model_remove", {
      request: { index: 1 },
    });
    expect(radio(fake.name)).toBeChecked();
  });

  it("removing In use moves the radio to the remaining installed model", async () => {
    answer({ ai_models: entries(), ai_model_remove: usedSecond });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove FAKE model" }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove FAKE model",
      }),
    );
    const download = await screen.findByRole("button", {
      name: "Download FAKE model",
    });
    expect(radio(second.name)).toBeChecked();
    expect(download).toHaveFocus();
  });

  it("an old list reply cannot undo a newer choice after completion", async () => {
    let oldList!: (rows: ModelRow[]) => void;
    let requests = 0;
    const chosen = entries().map((row) => ({ ...row, inUse: row.index === 1 }));
    answer({
      ai_models: () => {
        requests += 1;
        if (requests === 2)
          return new Promise((resolve) => {
            oldList = resolve;
          });
        return Promise.resolve(requests > 2 ? chosen : entries());
      },
      ai_model_use: usedSecond,
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await screen.findByRole("radio", { name: second.name });
    act(() =>
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      }),
    );
    await waitFor(() => expect(requests).toBe(2));
    await userEvent.click(radio(second.name));
    await waitFor(() => expect(radio(second.name)).toBeChecked());
    await act(async () => oldList(entries()));
    expect(radio(second.name)).toBeChecked();
    expect(radio(fake.name)).not.toBeChecked();
  });

  it("a failed list read offers an explicit retry", async () => {
    let calls = 0;
    answer({
      ai_models: () =>
        ++calls === 1
          ? Promise.reject(new Error("FAKE unreadable list"))
          : Promise.resolve(entries()),
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The model list could not be read",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Read the model list again" }),
    );
    await screen.findByRole("radio", { name: second.name });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Catalog copy focus and global picker ownership", () => {
  const other: AcceptedModel = {
    ...fake,
    name: "FAKE other",
    sha256: "2".repeat(64),
  };
  const twoRows: ModelRow[] = [
    {
      index: 0,
      model: fake,
      state: "installed",
      addedByYou: false,
      inUse: true,
    },
    {
      index: 1,
      model: other,
      state: "notDownloaded",
      addedByYou: false,
      inUse: false,
    },
  ];
  it("finishing another row's download does not take focus from the model in use", async () => {
    let finish!: (result: unknown) => void;
    answer({
      ai_models: twoRows,
      ai_model_download: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Download FAKE other" }),
    );
    act(() =>
      native.listener?.({
        payload: { index: 1, done: 1_250_000_000, total: fake.sizeBytes },
      }),
    );
    const selected = screen.getByRole("radio", { name: fake.name });
    selected.focus();
    await act(async () => finish({ outcome: "added", status: installed }));
    await screen.findByRole("button", { name: "Remove FAKE other" });
    expect(selected).toHaveFocus();
  });
  it("a picked-file check has one global bar instead of claiming an offered row", async () => {
    answer({
      ai_models: twoRows,
      ai_model_add_picked: () => new Promise(() => undefined),
    });
    render(<AiModelSetting status={installed} onStatus={vi.fn()} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a model file…" }),
    );
    act(() =>
      native.listener?.({
        payload: { done: 900_000_000, total: fake.sizeBytes },
      }),
    );
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    for (const row of screen.getAllByRole("region"))
      expect(within(row).queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking the file");
  });
  it("a picker rejection keeps an installation completed while the picker was open", async () => {
    let reject!: (reason: unknown) => void;
    answer({
      ai_model_catalog: [fake],
      ai_model_add_picked: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    });
    const onStatus = vi.fn();
    render(
      <AiModelSetting status={{ state: "notInstalled" }} onStatus={onStatus} />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Add a model file…" }),
    );
    await act(async () => {
      native.listeners["ai-model-add-ended"]?.({
        payload: { outcome: "added", status: installed },
      });
      reject(new Error("FAKE picker failed"));
    });
    await screen.findByRole("button", { name: "Remove FAKE model" });
    expect(onStatus).toHaveBeenCalledWith(installed);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
