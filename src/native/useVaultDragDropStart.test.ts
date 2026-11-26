import { act, renderHook } from "@testing-library/react";
import type { DragEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useVaultDragDrop } from "./useVaultDragDrop";

// Where a drag may start: not while the vault is busy or read-only. FAKE data only.

function dragEvent(): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {
      effectAllowed: "none",
      dropEffect: "none",
      setData: vi.fn(),
      getData: () => "",
    },
  } as unknown as DragEvent;
}

describe("starting a drag", () => {
  it("is refused while the vault is disabled: no data is put on the drag, and a later drop moves nothing", () => {
    const onMove = vi.fn();
    const { result, rerender } = renderHook(
      ({ disabled }) => useVaultDragDrop({ disabled, onMove }),
      { initialProps: { disabled: true } },
    );
    const started = dragEvent();
    act(() =>
      result.current.startDrag(started, { kind: "records", ids: ["record"] }),
    );
    expect(started.preventDefault).toHaveBeenCalledOnce();
    expect(started.dataTransfer.setData).not.toHaveBeenCalled();
    expect(started.dataTransfer.effectAllowed).toBe("none");
    // Enabled again: there is still no drag to drop, so a drop moves nothing.
    rerender({ disabled: false });
    act(() => result.current.dropInto(dragEvent(), "destination"));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("an enabled start puts only the kind of item on the drag, never a name or an id", () => {
    const { result } = renderHook(() =>
      useVaultDragDrop({ disabled: false, onMove: vi.fn() }),
    );
    const started = dragEvent();
    act(() =>
      result.current.startDrag(started, {
        kind: "folder",
        id: "FAKE-folder-id",
      }),
    );
    expect(started.dataTransfer.effectAllowed).toBe("move");
    expect(started.dataTransfer.setData).toHaveBeenCalledExactlyOnceWith(
      "application/x-mycarlos-item",
      "folder",
    );
  });
});
