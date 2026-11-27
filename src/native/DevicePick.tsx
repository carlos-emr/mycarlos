import { t as translateNow } from "../i18n";
import type { DeviceInfo } from "./mediaDevices";

/** One of the device lists of the video recording dialog and of the photo dialog: the same chooser
 * in both, so the camera is picked the same way wherever it is used (#359). With more than one
 * device it is a list to choose from (the one in use is selected); with one, plain text, so the
 * patient still sees which one is in use. With none, nothing. */
export function DevicePick({
  kind,
  label,
  unnamed,
  devices,
  current,
  disabled,
  onChange,
}: {
  kind: "camera" | "microphone";
  label: string;
  unnamed:
    | "interface.RecordDialog.unnamedCamera"
    | "interface.RecordDialog.unnamedMicrophone";
  devices: DeviceInfo[];
  current: string | null;
  disabled: boolean;
  onChange: (kind: "camera" | "microphone", id: string) => void;
}) {
  if (devices.length === 0) return null;
  const nameOf = (device: DeviceInfo, index: number) =>
    device.label || translateNow(unnamed, { number: index + 1 });
  // The one in use, if the browser says which it is. When it cannot be matched to a listed device
  // (the system's default, which a stream reports under an alias id), "System default" is shown:
  // never the first device of the list, which would be a guess shown as a fact.
  const selected = devices.find((device) => device.id === current) ?? null;
  if (devices.length === 1)
    return (
      <p className="record-device">
        <span>{label}: </span>
        <strong>{nameOf(devices[0], 0)}</strong>
      </p>
    );
  return (
    <label className="record-device">
      <span>{label}</span>
      <select
        id={`record-device-${kind}`}
        value={selected ? selected.id : ""}
        disabled={disabled}
        onChange={(event) => onChange(kind, event.currentTarget.value)}
      >
        {!selected && (
          <option value="" disabled>
            {translateNow("interface.RecordDialog.systemDefaultDevice")}
          </option>
        )}
        {devices.map((device, index) => (
          <option key={device.id} value={device.id}>
            {nameOf(device, index)}
          </option>
        ))}
      </select>
    </label>
  );
}
