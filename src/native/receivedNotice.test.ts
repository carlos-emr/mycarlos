import { humanValue } from "../test/humanText";
import { describe, expect, it } from "vitest";
import { receiveNoticeText } from "./receivedNotice";

describe("what the patient is told about shared files", () => {
  it("says nothing when everything shared was received", () => {
    expect(
      humanValue(receiveNoticeText({ dropped: 0, refusedShares: 0 })),
    ).toBe(humanValue(""));
  });

  it("counts refused shares and dropped items, never naming them", () => {
    expect(
      humanValue(receiveNoticeText({ dropped: 2, refusedShares: 1 })),
    ).toBe(
      humanValue(
        "A share was not received: no more than 100 shared files can wait at once. Unlock, so the waiting files go into Shared with me, then share again. 2 shared items were not received: myCarlos accepts PDF files only.",
      ),
    );
    expect(
      humanValue(receiveNoticeText({ dropped: 1, refusedShares: 3 })),
    ).toBe(
      humanValue(
        "3 shares were not received: no more than 100 shared files can wait at once. Unlock, so the waiting files go into Shared with me, then share again. One shared item was not received: myCarlos accepts PDF files only.",
      ),
    );
  });
});
