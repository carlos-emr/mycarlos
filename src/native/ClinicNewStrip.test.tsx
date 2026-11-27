import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClinicNewStrip } from "./ClinicNewStrip";

describe("the New marker's seam", () => {
  it("shows nothing for now, whatever the count", () => {
    for (const count of [0, 1, 7]) {
      const { container, unmount } = render(<ClinicNewStrip count={count} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
