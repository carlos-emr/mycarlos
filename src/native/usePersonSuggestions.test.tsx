import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VaultBridge, VaultRecord } from "../vault";
import { usePersonSuggestions } from "./usePersonSuggestions";
const records = ["a", "b"].map(
  (id) =>
    ({ id, displayName: `FAKE ${id}.pdf`, available: true }) as VaultRecord,
);
const people = [
  {
    id: "p",
    displayName: "FAKE Mary Smith",
    createdAtMs: 1,
    birthDate: "1958-03-12",
  },
];
function Probe({
  bridge,
  paused = false,
  documents = records,
}: {
  bridge: VaultBridge;
  paused?: boolean;
  documents?: VaultRecord[];
}) {
  const hints = usePersonSuggestions(bridge, documents, people, paused);
  return (
    <>
      {documents.map((r) => (
        <div key={r.id}>
          {hints.suggestionFor(r.id) ? `Offer ${r.id}` : `None ${r.id}`}
          <button onClick={() => hints.dismiss(r.id)}>Dismiss {r.id}</button>
        </div>
      ))}
    </>
  );
}
describe("session-only document suggestions", () => {
  it("reads serially, pauses when guarded and forgets dismissals on a new session", async () => {
    let complete!: (value: { name: string; birthDate: string }) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      )
      .mockResolvedValue({ name: "FAKE Mary Smith", birthDate: "1958-03-12" });
    const bridge = { sharedIdentity: read } as unknown as VaultBridge;
    const view = render(<Probe bridge={bridge} paused />);
    expect(read).not.toHaveBeenCalled();
    view.rerender(<Probe bridge={bridge} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    complete({ name: "FAKE Mary Smith", birthDate: "1958-03-12" });
    await screen.findByText("Offer b");
    expect(read).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss a" }));
    expect(screen.getByText("None a")).toBeInTheDocument();
    view.unmount();
    render(<Probe bridge={bridge} />);
    await screen.findByText("Offer a");
  });
  it("silently omits unsupported, failed and ambiguous extraction", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(null);
    render(
      <Probe bridge={{ sharedIdentity: read } as unknown as VaultBridge} />,
    );
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Offer/)).not.toBeInTheDocument();
  });
  it("clears hints and stops queued requests when native auto-lock wins the UI poll", async () => {
    let lock!: (error: unknown) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        name: "FAKE Mary Smith",
        birthDate: "1958-03-12",
      })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            lock = reject;
          }),
      )
      .mockResolvedValue({ name: "FAKE Mary Smith" });
    const queued = [
      ...records,
      { ...records[0], id: "c", displayName: "FAKE c.pdf" },
    ];
    render(
      <Probe
        bridge={{ sharedIdentity: read } as unknown as VaultBridge}
        documents={queued}
      />,
    );
    await screen.findByText("Offer a");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    lock({ code: "locked" });
    await screen.findByText("None a");
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Offer/)).not.toBeInTheDocument();
  });
});
