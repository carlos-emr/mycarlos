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
  it("tells a patient that files shared while locked are kept encrypted, and that some could not be", () => {
    expect(
      humanValue(
        receiveNoticeText({
          dropped: 0,
          refusedShares: 0,
          sealed: 2,
          notKept: 1,
        }),
      ),
    ).toBe(
      humanValue(
        "2 shared files are kept, encrypted, for up to 7 days. Unlock myCarlos to add them. One shared file could not be kept. Share it again.",
      ),
    );
    expect(
      humanValue(
        receiveNoticeText({ dropped: 0, refusedShares: 0, sealed: 1 }),
      ),
    ).toBe(
      humanValue(
        "One shared file is kept, encrypted, for up to 7 days. Unlock myCarlos to add it.",
      ),
    );
  });
});
