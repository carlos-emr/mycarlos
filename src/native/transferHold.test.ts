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

  it("is running while any operation is under way, with or without a transfer", () => {
    const hold = new TransferHold();
    expect(hold.running).toBe(false);
    hold.operationStarted();
    expect(hold.running).toBe(true);
    expect(hold.active).toBe(false);
    hold.operationStarted();
    expect(hold.operationEnded()).toBe(false);
    expect(hold.running).toBe(true);
    expect(hold.operationEnded()).toBe(true);
    expect(hold.running).toBe(false);
  });
});
