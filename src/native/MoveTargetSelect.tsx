import { useI18n, t as translateNow } from "../i18n";
import type { Ref } from "react";
import type { VaultFolder } from "../vault";

/** A person a document can go to, with their folders. */
export interface MoveTarget {
  profileId: string;
  name: string;
  folders: VaultFolder[];
}

/** "<person>|<folder>", with no folder for the person's records. */
export const moveTargetValue = (profileId: string, folderId: string | null) =>
  `${profileId}|${folderId ?? ""}`;

export function parseMoveTarget(value: string): {
  profileId: string;
  folderId: string | null;
} {
  const [profileId, folderId] = value.split("|");
  return { profileId, folderId: folderId || null };
}

/** Where a document goes: a person's records or one of
 * their folders. With one person, their folders as on the sidebar; with
 * several, a group for each. */
export function MoveTargetSelect({
  ref,
  label,
  targets,
  value,
  current,
  disabled,
  onChange,
}: {
  ref?: Ref<HTMLSelectElement>;
  /** The select's accessible name. */
  label: string;
  targets: MoveTarget[];
  value: string;
  /** An option for staying in Shared with me, chosen to start with. */
  current?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  useI18n();
  const options = (target: MoveTarget) => [
    <option
      key={target.profileId}
      value={moveTargetValue(target.profileId, null)}
    >
      {targets.length > 1
        ? translateNow("interface.person.records", { name: target.name })
        : translateNow("sidebar.myRecords")}
    </option>,
    ...target.folders.map((folder) => (
      <option
        key={folder.id}
        value={moveTargetValue(target.profileId, folder.id)}
      >
        {folder.name}
      </option>
    )),
  ];
  return (
    <select
      ref={ref}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {current !== undefined && <option value="">{current}</option>}
      {targets.length > 1
        ? targets.map((target) => (
            <optgroup key={target.profileId} label={target.name}>
              {options(target)}
            </optgroup>
          ))
        : targets.flatMap(options)}
    </select>
  );
}
