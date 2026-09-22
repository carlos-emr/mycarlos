import { useState, type DragEvent as ReactDragEvent } from "react";

export type DragItem =
  | { kind: "records"; ids: string[] }
  | { kind: "folder"; id: string };

interface VaultDragDropOptions {
  disabled: boolean;
  onMove: (item: DragItem, folderId: string | null) => void;
}

export function useVaultDragDrop({ disabled, onMove }: VaultDragDropOptions) {
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const startDrag = (event: ReactDragEvent, item: DragItem) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    // Some engines will not start a drag without data. It names no document or
    // folder, since wherever the drag ends can read it, and is not read on drop.
    event.dataTransfer.setData("application/x-mycarlos-item", item.kind);
    setDragItem(item);
  };

  const dragOver = (event: ReactDragEvent, zone: string) => {
    if (disabled || !dragItem) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(zone);
  };

  const dropInto = (event: ReactDragEvent, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    // Only a drag this hook started can move anything. The transferred data
    // is never read back: another application can offer the same type, with
    // any IDs in it, and the webview delivers that drop here as well.
    const item = dragItem;
    setDropTarget(null);
    setDragItem(null);
    if (disabled || !item) return;
    onMove(item, folderId);
  };

  const dragEnd = () => {
    setDragItem(null);
    setDropTarget(null);
  };

  const dragClass = (base: string, item: DragItem) => {
    const dragging =
      item.kind === "folder"
        ? dragItem?.kind === "folder" && dragItem.id === item.id
        : dragItem?.kind === "records" &&
          item.ids.some((id) => dragItem.ids.includes(id));
    return `${base} native-draggable${dragging ? " native-dragging" : ""}`;
  };

  const dropClass = (base: string, zone: string) =>
    `${base}${dropTarget === zone ? " native-drop-target" : ""}`;

  return { startDrag, dragOver, dropInto, dragEnd, dragClass, dropClass };
}

export type VaultDragDrop = ReturnType<typeof useVaultDragDrop>;
