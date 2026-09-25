import { describe, expect, it } from "vitest";
import { TransferHold } from "./transferHold";

describe("TransferHold", () => {
  it("is active from a transfer until every operation under way has ended", () => {
    const hold = new TransferHold();
    hold.operationStarted();
    expect(hold.active).toBe(false);

    hold.transferStarted();
    hold.operationStarted();
    expect(hold.active).toBe(true);

    expect(hold.operationEnded()).toBe(false);
    expect(hold.active).toBe(true);
    expect(hold.operationEnded()).toBe(true);
    expect(hold.active).toBe(false);
  });
});
