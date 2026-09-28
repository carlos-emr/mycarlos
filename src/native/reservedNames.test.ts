import { describe, expect, it } from "vitest";
import { RESERVED_DEVICE_NAMES, reservedDeviceName } from "./reservedNames";

// The vault's drift test reads RESERVED_DEVICE_NAMES; these tie the check to it.
describe("reservedDeviceName", () => {
  it.each(RESERVED_DEVICE_NAMES)("refuses %s, in any ASCII case", (name) => {
    expect(reservedDeviceName(name)).toBe(name);
    const lower = name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    expect(reservedDeviceName(`${lower}.pdf`)).toBe(lower);
  });

  it.each(RESERVED_DEVICE_NAMES)("accepts longer names built on %s", (name) => {
    expect(reservedDeviceName(`${name}0`)).toBeUndefined();
    expect(reservedDeviceName(`_${name}`)).toBeUndefined();
  });

  it("cannot be changed at run time", () => {
    expect(Object.isFrozen(RESERVED_DEVICE_NAMES)).toBe(true);
  });
});
