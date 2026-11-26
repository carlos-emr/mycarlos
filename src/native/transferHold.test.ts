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

  it("counts operations by session: one a lock left behind neither runs nor holds anything back later", () => {
    const hold = new TransferHold();
    // A picker of session 0 that never answers.
    hold.operationStarted(0);
    expect(hold.running).toBe(true);
    // The vault locks: session 1 is shown with nothing under way.
    hold.moveTo(1);
    expect(hold.running).toBe(false);
    // Its own operations count and end as always, though the old picker is still open.
    hold.operationStarted(1);
    expect(hold.running).toBe(true);
    expect(hold.operationEnded(1)).toBe(true);
    expect(hold.running).toBe(false);
    // The old picker answering at last ends in its own session, and is the last one there.
    expect(hold.operationEnded(0)).toBe(true);
    // It does not cut short an operation that is under way in the new session.
    hold.operationStarted(1);
    hold.operationStarted(0);
    expect(hold.operationEnded(0)).toBe(false);
    expect(hold.running).toBe(true);
    expect(hold.operationEnded(1)).toBe(true);
  });

  it("keeps a transfer that ran before a lock known until its operation ends", () => {
    const hold = new TransferHold();
    hold.operationStarted(0);
    hold.transferStarted();
    hold.moveTo(1);
    // Its late failure is still held for the next unlock.
    expect(hold.active).toBe(true);
    expect(hold.operationEnded(0)).toBe(true);
    expect(hold.active).toBe(false);
  });
});
