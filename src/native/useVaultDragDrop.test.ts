import { act, renderHook } from "@testing-library/react";
import type { DragEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useVaultDragDrop } from "./useVaultDragDrop";

function dragEvent(payload = ""): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: () => payload,
    },
  } as unknown as DragEvent;
}

describe("vault drag and drop guards", () => {
  it("cancels a drag when the vault becomes busy or read-only before drop", () => {
    const onMove = vi.fn();
    const { result, rerender } = renderHook(
      ({ disabled }) => useVaultDragDrop({ disabled, onMove }),
      { initialProps: { disabled: false } },
    );
    act(() =>
      result.current.startDrag(dragEvent(), {
        kind: "records",
        ids: ["record"],
      }),
    );
    rerender({ disabled: true });
    act(() => result.current.dropInto(dragEvent(), "destination"));
    expect(onMove).not.toHaveBeenCalled();
    // A cancelled drag must not reappear when the next operation finishes.
    rerender({ disabled: false });
    act(() => result.current.dropInto(dragEvent(), "destination"));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("moves the item this drag started into the drop target", () => {
    const onMove = vi.fn();
    const { result } = renderHook(() =>
      useVaultDragDrop({ disabled: false, onMove }),
    );
    const started = dragEvent();
    act(() =>
      result.current.startDrag(started, { kind: "records", ids: ["record"] }),
    );
    // The transferred data names nothing another application could reuse.
    expect(started.dataTransfer.setData).toHaveBeenCalledWith(
      "application/x-mycarlos-item",
      "records",
    );
    act(() => result.current.dropInto(dragEvent(), "destination"));
    expect(onMove).toHaveBeenCalledExactlyOnceWith(
      { kind: "records", ids: ["record"] },
      "destination",
    );
  });

  it.each([
    '{"kind":"records","ids":["record"]}',
    '{"kind":"folder","id":"folder"}',
    "not JSON",
  ])("ignores a drop this app did not start: %s", (payload) => {
    // Another application can offer the same data type with any IDs in it.
    const onMove = vi.fn();
    const { result } = renderHook(() =>
      useVaultDragDrop({ disabled: false, onMove }),
    );
    const over = dragEvent(payload);
    act(() => result.current.dragOver(over, "destination"));
    expect(over.preventDefault).not.toHaveBeenCalled();
    act(() => result.current.dropInto(dragEvent(payload), "destination"));
    expect(onMove).not.toHaveBeenCalled();
  });
});
