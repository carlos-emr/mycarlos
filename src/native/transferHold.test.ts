import { describe, expect, it } from "vitest";
import { TransferHold } from "./transferHold";

describe("TransferHold", () => {
  it("waits for every operation once one ran a transfer, up to the limit from the first transfer", () => {
    const hold = new TransferHold();
    hold.operationStarted();
    expect(hold.shouldWait(0, 100)).toBe(false);

    hold.transferStarted(10);
    hold.operationStarted();
    // A later transfer does not move the start of the limit.
    hold.transferStarted(50);
    expect(hold.shouldWait(109, 100)).toBe(true);
    expect(hold.shouldWait(110, 100)).toBe(false);

    // Waits until the last operation has ended.
    expect(hold.operationEnded()).toBe(false);
    expect(hold.active).toBe(true);
    expect(hold.operationEnded()).toBe(true);
    expect(hold.active).toBe(false);
    expect(hold.shouldWait(20, 100)).toBe(false);
  });
});
