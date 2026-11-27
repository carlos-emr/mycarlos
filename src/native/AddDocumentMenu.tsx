import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Icon, type IconName } from "../Icon";
import { t as translateNow, useI18n } from "../i18n";

export interface AddMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** For a choice among several (Sort, View): this one is the current. */
  checked?: boolean;
  onChoose: () => void;
}

/**
 * A menu button, the one menu of the app's decluttered screens (Add document, a person's "…", Sort,
 * View, a document's "More"): a button that opens a short menu. Enter, Space or the Down arrow opens
 * it with the first item focused, the arrows, Home and End move through it (skipping what cannot
 * be used), Escape closes it and gives the focus back to the button, Tab leaves it, and a press
 * outside closes it. A chosen item closes the menu first and returns the focus to the button, so a
 * dialog it opens comes back to the button. `variant` and `align` only change how it is drawn.
 */
export function MenuButton({
  label,
  buttonName,
  children,
  items,
  disabled = false,
  variant = "toolbar",
  align = "start",
}: {
  /** The menu's name, and the button's unless `buttonName` says more (it must hold the words the
   * button shows). */
  label: string;
  buttonName?: string;
  /** What the button shows (it is named by `label` unless it shows the same words). */
  children?: ReactNode;
  items: AddMenuItem[];
  disabled?: boolean;
  variant?: "primary" | "toolbar" | "icon";
  align?: "start" | "end";
}) {
  useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const itemButtons = () =>
    Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) ?? [],
    );

  // Opened: the first item takes the focus.
  useEffect(() => {
    if (open) itemButtons()[0]?.focus();
  }, [open]);
  // A press outside the menu closes it.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (item: AddMenuItem) => {
    setOpen(false);
    buttonRef.current?.focus();
    item.onChoose();
  };
  const move = (event: KeyboardEvent<HTMLElement>) => {
    const entries = itemButtons();
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    const go = (index: number) => {
      event.preventDefault();
      entries[(index + entries.length) % entries.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return go(at + 1);
      case "ArrowUp":
        return go(at - 1);
      case "Home":
        return go(0);
      case "End":
        return go(entries.length - 1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      case "Tab":
        setOpen(false);
    }
  };

  return (
    <div className={`menu-button menu-button-${variant}`} ref={rootRef}>
      <button
        ref={buttonRef}
        className="menu-button-trigger"
        type="button"
        aria-label={
          buttonName ?? (children && variant !== "icon" ? undefined : label)
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((now) => !now)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {children}
      </button>
      {open && (
        <div
          id={menuId}
          className={`menu-button-list menu-button-list-${align}`}
          role="menu"
          aria-label={label}
          onKeyDown={move}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              disabled={item.disabled}
              onClick={() => choose(item)}
            >
              {item.checked !== undefined && (
                // The current choice is said by a tick, not by colour alone.
                <span className="menu-button-tick" aria-hidden="true">
                  {item.checked ? "✓" : ""}
                </span>
              )}
              {item.icon && <Icon name={item.icon} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The sidebar's primary "Add document" menu. */
export function AddDocumentMenu({
  items,
  disabled = false,
  working = false,
}: {
  items: AddMenuItem[];
  disabled?: boolean;
  /** Something is being saved or read: the button says so, as the old New button did, and waits. */
  working?: boolean;
}) {
  useI18n();
  const label = translateNow("interface.AddMenu.addDocument");
  const shown = working
    ? translateNow("interface.VaultLibrary.working")
    : label;
  return (
    <MenuButton
      label={label}
      items={items}
      disabled={disabled || working}
      variant="primary"
    >
      <Icon name="plus" />
      <span className="menu-button-label">{shown}</span>
      <span className="menu-button-chevron" aria-hidden="true">
        ▾
      </span>
    </MenuButton>
  );
}
