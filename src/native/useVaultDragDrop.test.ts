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

  it.each(["not JSON", "null", '{"kind":"records","ids":[123]}'])(
    "ignores malformed transferred data: %s",
    (payload) => {
      const onMove = vi.fn();
      const { result } = renderHook(() =>
        useVaultDragDrop({ disabled: false, onMove }),
      );
      act(() => result.current.dropInto(dragEvent(payload), "destination"));
      expect(onMove).not.toHaveBeenCalled();
    },
  );
});
