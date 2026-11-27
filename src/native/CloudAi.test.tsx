import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { humanText } from "../test/humanText";
import type {
  CloudAiBridge,
  CloudKeyInfo,
  CloudKeyTest,
  CloudSendAnswer,
  CloudSendPrepared,
} from "../cloudAi";
import { CloudAiSetting } from "./CloudAiSetting";
import { CloudSendStep } from "./CloudSendStep";

// The step as the preview renders it: the text, the document's own text and what was removed.
const Step = ({
  bridge,
  onRefused,
}: {
  bridge: CloudAiBridge;
  onRefused?: (hits: { start: number; end: number }[]) => void;
}) => (
  <CloudSendStep
    bridge={bridge}
    recordId="record-1"
    text="FAKE text [NAME 1]"
    source="FAKE text Morgan"
    labels={["NAME"]}
    removed={[{ replacement: "[NAME 1]", original: "Morgan", manual: false }]}
    onRefused={onRefused}
    disabled={false}
  />
);

// FAKE bridge: nothing here is a real key, a real network or a real vault.
const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEa1b2";

function fakeBridge(initial: CloudKeyInfo[] = [], on = false) {
  let keys = [...initial];
  let enabled = on;
  const calls = {
    send: 0,
    prepare: 0,
    cancel: [] as string[],
    added: [] as string[],
    tested: [] as string[],
  };
  const bridge: CloudAiBridge = {
    enabled: vi.fn(async () => enabled),
    setEnabled: vi.fn(async (value: boolean) => {
      enabled = value;
    }),
    listKeys: vi.fn(async () => keys),
    addKey: vi.fn(async ({ label, key }) => {
      calls.added.push(key);
      if (key.startsWith("sk-ant-admin")) throw { code: "adminKey" };
      if (!key.startsWith("sk-ant-")) throw { code: "badShape" };
      const info: CloudKeyInfo = {
        id: `key-${keys.length + 1}`,
        provider: "anthropic",
        label,
        keyLast4: key.slice(-4),
        addedAtMs: Date.UTC(2026, 10, 20),
      };
      keys = [...keys, info];
      return info;
    }),
    removeKey: vi.fn(async (id: string) => {
      keys = keys.filter((key) => key.id !== id);
    }),
    prepare: vi.fn(async () => {
      calls.prepare += 1;
      const prepared: CloudSendPrepared = {
        exchangeId: "exchange-1",
        characters: 11_000,
        estimatedTokens: 3_000,
        estimatedCostUsd: 0.02,
        modelLabel: "Claude Opus 5.5",
      };
      return prepared;
    }),
    send: vi.fn(async () => {
      calls.send += 1;
      return {
        sentences: [
          {
            text: "FAKE answer: <b>not markup</b> Morgan is stable.",
            quote: "x",
          },
        ],
        flagged: ["[NAME 9]"],
      };
    }),
    testKey: vi.fn(async (id: string): Promise<CloudKeyTest> => {
      calls.tested.push(id);
      return keys.find((key) => key.id === id) ? "accepted" : "rejected";
    }),
    cancel: vi.fn(async (id: string) => {
      calls.cancel.push(id);
    }),
  };
  return { bridge, calls };
}
const home: CloudKeyInfo = {
  id: "key-1",
  provider: "anthropic",
  label: "Home laptop",
  keyLast4: "a1b2",
  addedAtMs: Date.UTC(2026, 10, 20),
};

describe("cloud AI is off in a normal build (#72)", () => {
  it("shows nothing and never asks the bridge", () => {
    const { bridge } = fakeBridge([home], true);
    const { container } = render(<CloudAiSetting bridge={bridge} />);
    render(<Step bridge={bridge} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).toBeNull();
    expect(bridge.enabled).not.toHaveBeenCalled();
    expect(bridge.listKeys).not.toHaveBeenCalled();
  });
});

describe("with the cloud AI flag on", () => {
  beforeEach(() => vi.stubEnv("VITE_CLOUD_AI", "1"));
  afterEach(() => vi.unstubAllEnvs());

  describe("the key in Settings", () => {
    it("asks for the patient's understanding before it turns on, and adds a key only when on", async () => {
      const user = userEvent.setup();
      const { bridge } = fakeBridge();
      render(<CloudAiSetting bridge={bridge} />);
      const turnOn = await screen.findByRole("button", {
        name: "Turn on cloud AI on this computer",
      });
      expect(turnOn).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add key" })).toBeDisabled();
      expect(await screen.findByText("No key saved.")).toBeVisible();
      await user.click(
        screen.getByRole("checkbox", { name: "I understand this" }),
      );
      await user.click(turnOn);
      expect(bridge.setEnabled).toHaveBeenCalledWith(true);
      expect(
        await screen.findByRole("button", { name: "Turn off cloud AI" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Add key" })).toBeEnabled();
    });

    it("adds a key, empties the field first, and shows it masked with no secret", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([], true);
      render(<CloudAiSetting bridge={bridge} />);
      await user.click(await screen.findByRole("button", { name: "Add key" }));
      const dialog = screen.getByRole("dialog", {
        name: "Add your Anthropic key",
      });
      await user.type(
        within(dialog).getByLabelText("Name for this key"),
        "Home laptop",
      );
      const field = within(dialog).getByLabelText("Anthropic API key");
      expect(field).toHaveAttribute("type", "password");
      await user.type(field, FAKE_KEY);
      await user.click(within(dialog).getByRole("button", { name: "Add key" }));
      await waitFor(() => expect(calls.added).toEqual([FAKE_KEY]));
      expect(
        await screen.findByText(
          humanText(/"Home laptop": key ends in a1b2, added /),
        ),
      ).toBeVisible();
      // The secret is nowhere on the page.
      expect(document.body.innerHTML).not.toContain("FAKEFAKE");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("says why a key was refused, and empties the field even then", async () => {
      const user = userEvent.setup();
      const { bridge } = fakeBridge([], true);
      render(<CloudAiSetting bridge={bridge} />);
      await user.click(await screen.findByRole("button", { name: "Add key" }));
      const dialog = screen.getByRole("dialog");
      await user.type(
        within(dialog).getByLabelText("Name for this key"),
        "Work",
      );
      const field = within(dialog).getByLabelText("Anthropic API key");
      await user.type(field, "sk-ant-admin01-FAKEFAKEFAKEFAKEFAKE");
      await user.click(within(dialog).getByRole("button", { name: "Add key" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "That is an administration key",
      );
      expect(field).toHaveValue("");
      expect(document.body.innerHTML).not.toContain("FAKEFAKE");
      await user.type(field, "not-a-key-at-all-1234567");
      await user.click(within(dialog).getByRole("button", { name: "Add key" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "does not look like an Anthropic API key",
      );
    });

    it("tests a key only when asked, and says the outcome in words", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([home], true);
      render(<CloudAiSetting bridge={bridge} />);
      await screen.findByText(/Home laptop/);
      expect(calls.tested).toEqual([]);
      await user.click(screen.getByRole("button", { name: "Test this key" }));
      expect(await screen.findByText("The key was accepted.")).toBeVisible();
      expect(calls.tested).toEqual(["key-1"]);
      bridge.testKey = vi.fn(async () => "rejected" as const);
      await user.click(screen.getByRole("button", { name: "Test this key" }));
      expect(await screen.findByText(/The key was not accepted/)).toBeVisible();
    });

    it("removes a key only after a confirmation that says older backups still hold it", async () => {
      const user = userEvent.setup();
      const { bridge } = fakeBridge([home], true);
      render(<CloudAiSetting bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Remove key" }),
      );
      const confirm = screen.getByRole("alertdialog", {
        name: "Remove this key?",
      });
      expect(confirm).toHaveTextContent(
        "Older backups of this vault still hold it.",
      );
      expect(bridge.removeKey).not.toHaveBeenCalled();
      await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
      expect(bridge.removeKey).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Remove key" }));
      await user.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Remove key",
        }),
      );
      await waitFor(() =>
        expect(bridge.removeKey).toHaveBeenCalledWith("key-1"),
      );
      expect(await screen.findByText("No key saved.")).toBeVisible();
    });
  });

  describe("the send step in the preview", () => {
    it("shows no button when cloud AI is off or no key is saved", async () => {
      for (const [keys, on] of [
        [[home], false],
        [[], true],
      ] as const) {
        const { bridge } = fakeBridge([...keys], on);
        const { unmount } = render(<Step bridge={bridge} />);
        await waitFor(() => expect(bridge.listKeys).toHaveBeenCalled());
        expect(
          screen.queryByRole("button", { name: /Send to my AI provider/ }),
        ).toBeNull();
        unmount();
      }
    });

    it("shows no confirmation of its own: the native dialog is the one and only", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([home], true);
      render(<Step bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      // The page asks the native side to prepare and then to send, and shows no dialog of its
      // own (the native one names the provider, host, key, model, document, size and cost).
      expect(await screen.findByText("Answer")).toBeVisible();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(calls.prepare).toBe(1);
      expect(calls.send).toBe(1);
    });

    it("sends once and shows the answer as plain text, labelled as written by AI", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([home], true);
      render(<Step bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      expect(await screen.findByText("Answer")).toBeVisible();
      expect(calls.send).toBe(1);
      expect(
        screen.getByText(
          "Written by AI and may be wrong. Check with your doctor.",
        ),
      ).toBeVisible();
      // Markup in an answer is text, never elements.
      expect(document.querySelector(".cloud-ai-answer-text b")).toBeNull();
      expect(
        document.querySelector(".cloud-ai-answer-text")?.textContent,
      ).toContain("<b>not markup</b>");
      // A mark that was not put back is said, as written.
      expect(screen.getByText(/\[NAME 9\]/)).toBeVisible();
    });

    it("asks the native side to prepare with the document's own details, never a model or an address", async () => {
      const user = userEvent.setup();
      const { bridge } = fakeBridge([home], true);
      render(<Step bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      await waitFor(() => expect(bridge.prepare).toHaveBeenCalled());
      const request = vi.mocked(bridge.prepare).mock.calls[0][0];
      expect(Object.keys(request).sort()).toEqual([
        "keyId",
        "labels",
        "language",
        "recordId",
        "removed",
        "source",
        "text",
      ]);
      expect(request).toMatchObject({
        keyId: "key-1",
        recordId: "record-1",
        labels: ["NAME"],
        removed: [
          { replacement: "[NAME 1]", original: "Morgan", manual: false },
        ],
      });
    });

    it("says it was cancelled, not failed, when the native dialog is declined (nothing is sent)", async () => {
      const user = userEvent.setup();
      const { bridge } = fakeBridge([home], true);
      bridge.send = vi.fn(async () => {
        throw { code: "declined" };
      });
      render(<Step bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      expect(await screen.findByRole("status")).not.toHaveTextContent(
        "could not be sent",
      );
    });

    it("says nothing was kept when the send fails, and offers Cancel while waiting", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([home], true);
      let reject: (error: unknown) => void = () => {};
      bridge.send = vi.fn(
        () =>
          new Promise<CloudSendAnswer>((_resolve, fail) => {
            reject = fail;
          }),
      );
      render(<Step bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      expect(await screen.findByText(/Waiting for Anthropic…/)).toBeVisible();
      reject(new Error("FAKE failure"));
      expect(await screen.findByText(/Nothing was kept\./)).toBeVisible();
      expect(calls.send).toBe(0);
    });

    it("a cancel while waiting says Anthropic may already have the text, and shows no answer", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([home], true);
      let resolve: (value: CloudSendAnswer) => void = () => {};
      bridge.send = vi.fn(
        () =>
          new Promise<CloudSendAnswer>((done) => {
            resolve = done;
          }),
      );
      render(<Step bridge={bridge} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(
        await screen.findByText(/Anthropic may already have received the text/),
      ).toBeVisible();
      resolve({
        sentences: [{ text: "FAKE late answer", quote: "x" }],
        flagged: [],
      });
      await waitFor(() => expect(calls.cancel).toContain("exchange-1"));
      expect(screen.queryByText("FAKE late answer")).toBeNull();
    });

    it("a re-check refusal from the native side sends nothing and says so", async () => {
      const user = userEvent.setup();
      const { bridge, calls } = fakeBridge([home], true);
      bridge.prepare = vi.fn(async () => {
        throw { code: "recheck", hits: [{ start: 2, end: 5 }] };
      });
      const onRefused = vi.fn();
      render(<Step bridge={bridge} onRefused={onRefused} />);
      await user.click(
        await screen.findByRole("button", { name: "Send to my AI provider…" }),
      );
      expect(await screen.findByText(/Nothing was kept\./)).toBeVisible();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(calls.send).toBe(0);
      // The preview is told which parts to mark, as for a refused Save.
      expect(onRefused).toHaveBeenCalledWith([{ start: 2, end: 5 }]);
    });
  });
});
