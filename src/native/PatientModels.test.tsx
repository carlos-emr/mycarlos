import { humanText } from "../test/humanText";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { AiModelSetting } from "./AiModelSetting";
import { PatientModelRows } from "./PatientModelRows";
import { ReaderAiPanel } from "./ReaderAiPanel";
import { fakeDocumentText, fakeLocalModel } from "../test/fakeLocalModel";
import type { PatientModelRow } from "../ai/types";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
const hash = "a".repeat(64);
const patient: PatientModelRow = {
  index: null,
  model: null,
  number: 1,
  sha256: hash,
  sizeBytes: 1000000,
  state: "installed",
  addedByYou: true,
  checked: false,
  trial: "passed",
  inUse: false,
};
beforeEach(() => {
  native.invoke.mockReset();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "ai_models") return [];
    if (command === "ai_model_add_picked")
      return { outcome: "notListed", pickId: "FAKE-opaque-pick" };
    if (command === "ai_model_add_unchecked") return { outcome: "cancelled" };
    if (command === "ai_model_status") return { state: "notInstalled" };
    if (command === "ai_model_add_active") return null;
  });
});

it("sends only the retained opaque pick after a separate explicit confirmation", async () => {
  const user = userEvent.setup();
  render(
    <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Add a model file…" }),
  );
  const question = await screen.findByRole("alertdialog", {
    name: "Add an unlisted model?",
  });
  expect(native.invoke).not.toHaveBeenCalledWith(
    "ai_model_add_unchecked",
    expect.anything(),
  );
  await user.click(
    within(question).getByRole("button", { name: "Add and try this model" }),
  );
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("ai_model_add_unchecked", {
      request: { pickId: "FAKE-opaque-pick" },
    }),
  );
  expect(native.invoke).not.toHaveBeenCalledWith(
    "ai_model_approve",
    expect.anything(),
  );
});

it("cancelling the unlisted-file question does not copy or approve it", async () => {
  const user = userEvent.setup();
  render(
    <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Add a model file…" }),
  );
  const question = await screen.findByRole("alertdialog");
  await user.click(within(question).getByRole("button", { name: "Cancel" }));
  expect(
    native.invoke.mock.calls.some(
      ([command]) =>
        command === "ai_model_add_unchecked" || command === "ai_model_approve",
    ),
  ).toBe(false);
});

it("patient actions use the hash, and Remove asks first", async () => {
  const action = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<PatientModelRows rows={[patient]} busy={false} onAction={action} />);
  await user.click(
    screen.getByRole("button", { name: humanText("Use Your model 1") }),
  );
  expect(action).toHaveBeenCalledWith("ai_model_use", hash);
  await user.click(
    screen.getByRole("button", { name: humanText("Try again Your model 1") }),
  );
  expect(action).toHaveBeenCalledWith("ai_model_trial", hash);
  await user.click(
    screen.getByRole("button", { name: humanText("Remove Your model 1") }),
  );
  expect(action).not.toHaveBeenCalledWith("ai_model_remove", hash);
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  expect(action).toHaveBeenCalledWith("ai_model_remove", hash);
});

it("a model without a passed trial cannot be selected", () => {
  render(
    <PatientModelRows
      rows={[{ ...patient, state: "unusable", trial: "template" }]}
      busy={false}
      onAction={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: humanText("Use Your model 1") }),
  ).toBeDisabled();
  expect(
    screen.getByText("This model has no supported chat template."),
  ).toBeVisible();
});

function reader() {
  const model = fakeLocalModel({
    status: {
      state: "installed",
      model: { name: "FAKE patient model", sha256: hash },
    },
  });
  const original = model.summarize;
  model.summarize = vi
    .fn()
    .mockRejectedValueOnce({ code: "aiNeedsApproval" })
    .mockImplementation(original);
  model.status = vi.fn(model.status);
  render(
    <ReaderAiPanel
      ai={{
        model,
        loadText: async () => fakeDocumentText(["FAKE patient document."]),
        cancelText: vi.fn(),
        onOpenPreferences: vi.fn(),
      }}
      tool="summary"
      initialTerm=""
      contextFor={() => ""}
      onShowSource={vi.fn()}
      onCancel={vi.fn()}
      onReturnFocus={vi.fn()}
    />,
  );
  return model;
}
it("first-answer consent approves only this hash, then retries the requested summary", async () => {
  const model = reader();
  const user = userEvent.setup();
  const question = await screen.findByRole("alertdialog", {
    name: "Allow answers from this model?",
  });
  expect(native.invoke).not.toHaveBeenCalled();
  await user.click(
    within(question).getByRole("button", { name: "Allow for this vault" }),
  );
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("ai_model_approve", {
      request: { sha256: hash },
    }),
  );
  await waitFor(() => expect(model.summarize).toHaveBeenCalledTimes(2));
});
it("a changed selected model is never approved by the old question", async () => {
  const model = reader();
  const user = userEvent.setup();
  const question = await screen.findByRole("alertdialog");
  vi.mocked(model.status).mockResolvedValue({
    state: "installed",
    model: { name: "FAKE changed model", sha256: "b".repeat(64) },
  });
  await user.click(
    within(question).getByRole("button", { name: "Allow for this vault" }),
  );
  await waitFor(() => expect(model.status).toHaveBeenCalledTimes(3));
  expect(native.invoke).not.toHaveBeenCalled();
  expect(model.summarize).toHaveBeenCalledTimes(1);
});

it("an unsupported platform can still remove a patient-added file", () => {
  render(
    <PatientModelRows
      rows={[{ ...patient, state: "unusable" }]}
      busy={false}
      unsupported
      onAction={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("button", { name: humanText("Use Your model 1") }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: humanText("Try again Your model 1") }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: humanText("Remove Your model 1") }),
  ).toBeEnabled();
});

it("busy row actions keep focus but do not admit another action", async () => {
  const action = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  const view = render(
    <PatientModelRows rows={[patient]} busy={false} onAction={action} />,
  );
  const trial = screen.getByRole("button", {
    name: humanText("Try again Your model 1"),
  });
  trial.focus();
  view.rerender(<PatientModelRows rows={[patient]} busy onAction={action} />);
  expect(trial).toHaveFocus();
  expect(trial).toHaveAttribute("aria-disabled", "true");
  await user.click(trial);
  expect(action).not.toHaveBeenCalled();
});
it("cancelling first-answer consent grants no approval", async () => {
  const model = reader();
  const user = userEvent.setup();
  const question = await screen.findByRole("alertdialog");
  await user.click(within(question).getByRole("button", { name: "Cancel" }));
  expect(native.invoke).not.toHaveBeenCalled();
  expect(model.summarize).toHaveBeenCalledTimes(1);
});
it("cancelling while the selected hash is being checked stops approval", async () => {
  const model = reader();
  const user = userEvent.setup();
  const question = await screen.findByRole("alertdialog");
  let finish!: (status: Awaited<ReturnType<typeof model.status>>) => void;
  vi.mocked(model.status).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(
    within(question).getByRole("button", { name: "Allow for this vault" }),
  );
  await user.click(within(question).getByRole("button", { name: "Cancel" }));
  await act(async () =>
    finish({
      state: "installed",
      model: { name: "FAKE patient model", sha256: hash },
    }),
  );
  expect(native.invoke).not.toHaveBeenCalled();
  expect(model.summarize).toHaveBeenCalledTimes(1);
});

it("reconciles catalog and patient rows together without treating the patient hash as an index", async () => {
  const user = userEvent.setup();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === "ai_models")
      return [
        {
          index: 0,
          model: {
            name: "FAKE listed model",
            fileName: "fake.gguf",
            sizeBytes: 1000000,
            sha256: "b".repeat(64),
            licence: "FAKE licence",
            notices: [],
            sourceUrl: "https://example.invalid/fake.gguf",
          },
          state: "notDownloaded",
          addedByYou: false,
          inUse: false,
        },
        patient,
      ];
    if (command === "ai_model_status" || command === "ai_model_use")
      return {
        state: "installed",
        model: { name: "FAKE patient model", sha256: hash },
      };
    if (command === "ai_model_add_active") return null;
  });
  render(
    <AiModelSetting status={{ state: "notInstalled" }} onStatus={vi.fn()} />,
  );
  expect(await screen.findByText("FAKE listed model")).toBeVisible();
  const use = await screen.findByRole("button", {
    name: humanText("Use Your model 1"),
  });
  await user.click(use);
  await waitFor(() =>
    expect(native.invoke).toHaveBeenCalledWith("ai_model_use", {
      request: { sha256: hash },
    }),
  );
  expect(native.invoke).not.toHaveBeenCalledWith("ai_model_use", {
    request: { index: null },
  });
  expect(native.invoke).not.toHaveBeenCalledWith(
    "ai_model_approve",
    expect.anything(),
  );
});
