import { describe, expect, it } from "vitest";
import { receiveNoticeText, waitingText } from "./receivedNotice";

describe("what the patient is told about shared files", () => {
  it("says nothing when everything shared was received", () => {
    expect(receiveNoticeText({ dropped: 0, refusedShares: 0 })).toBe("");
    expect(waitingText(0)).toBe("");
  });

  it("counts refused shares and dropped items, never naming them", () => {
    expect(receiveNoticeText({ dropped: 2, refusedShares: 1 })).toBe(
      "A share was not received: no more than 100 shared files can wait at once. Unlock, so the waiting files go into Shared with me, then share again. 2 shared items were not received: myCarlos accepts PDF files only.",
    );
    expect(receiveNoticeText({ dropped: 1, refusedShares: 3 })).toBe(
      "3 shares were not received: no more than 100 shared files can wait at once. Unlock, so the waiting files go into Shared with me, then share again. One shared item was not received: myCarlos accepts PDF files only.",
    );
  });

  it("tells the lock screen how many wait, and that they are not kept", () => {
    expect(waitingText(1)).toBe(
      "One shared file is waiting. Unlock and it goes into Shared with me. If myCarlos closes first, it is not kept: share it again.",
    );
  });
});
