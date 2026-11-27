import { act, renderHook } from "@testing-library/react";
import type { DragEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useVaultDragDrop, type DragItem } from "./useVaultDragDrop";

// A drag that is refused at its start: the vault is busy or read-only, so nothing may begin.

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

describe("a drag started while the vault cannot be changed", () => {
  it("is cancelled, puts nothing on the drag, marks nothing as dragged and moves nothing", () => {
    const onMove = vi.fn();
    const item: DragItem = { kind: "records", ids: ["FAKE-record"] };
    const { result } = renderHook(() =>
      useVaultDragDrop({ disabled: true, onMove }),
    );
    const started = dragEvent();
    act(() => result.current.startDrag(started, item));
    // The browser's own drag is cancelled, so no ghost image follows the pointer.
    expect(started.preventDefault).toHaveBeenCalledOnce();
    expect(started.dataTransfer.setData).not.toHaveBeenCalled();
    expect(started.dataTransfer.effectAllowed).toBe("none");
    // Nothing is shown as being dragged...
    expect(result.current.dragClass("row", item)).toBe("row native-draggable");
    // ...a hover is not a drop target...
    const over = dragEvent();
    act(() => result.current.dragOver(over, "FAKE-folder"));
    expect(over.preventDefault).not.toHaveBeenCalled();
    expect(result.current.dropClass("folder", "FAKE-folder")).toBe("folder");
    // ...and a drop on a folder moves nothing, though it is still taken (so the webview does not
    // open a dropped file as a page).
    const dropped = dragEvent();
    act(() => result.current.dropInto(dropped, "FAKE-folder"));
    expect(dropped.preventDefault).toHaveBeenCalledOnce();
    expect(onMove).not.toHaveBeenCalled();
  });
});
