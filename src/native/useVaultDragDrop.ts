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
    event.dataTransfer.setData(
      "application/x-mycarlos-item",
      JSON.stringify(item),
    );
    setDragItem(item);
  };

  const readDragItem = (event: ReactDragEvent): DragItem | null => {
    if (dragItem) return dragItem;
    try {
      const value = JSON.parse(
        event.dataTransfer.getData("application/x-mycarlos-item"),
      ) as DragItem;
      if (value.kind === "folder" && typeof value.id === "string") return value;
      if (
        value.kind === "records" &&
        Array.isArray(value.ids) &&
        value.ids.every((id) => typeof id === "string")
      )
        return value;
    } catch {
      return null;
    }
    return null;
  };

  const dragOver = (event: ReactDragEvent, zone: string) => {
    if (disabled || !readDragItem(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget(zone);
  };

  const dropInto = (event: ReactDragEvent, folderId: string | null) => {
    event.preventDefault();
    event.stopPropagation();
    const item = readDragItem(event);
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
