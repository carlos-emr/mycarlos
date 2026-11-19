import { describe, expect, it } from "vitest";
import { boxStyle, boxesToDraw, centreIn, MAX_BOXES } from "./pageHighlight";

describe("the quoted words' boxes on a page picture (#292)", () => {
  it("draws every box the helper found, as given", () => {
    const rects: [number, number, number, number][] = [
      [0.1, 0.2, 0.5, 0.25],
      [0, 0.26, 1, 1],
    ];
    expect(boxesToDraw({ rects })).toEqual(rects);
  });

  it("draws none when any box is not a box on the picture: never a part as if it were all", () => {
    const good: [number, number, number, number] = [0.1, 0.2, 0.5, 0.25];
    for (const bad of [
      [0.5, 0.2, 0.4, 0.25], // right of its own right
      [0.1, 0.3, 0.5, 0.3], // no height
      [-0.01, 0.2, 0.5, 0.25],
      [0.1, 0.2, 1.01, 0.25],
      [0.1, 0.2, Number.NaN, 0.25],
      [0.1, 0.2, 0.5],
      ["0.1", 0.2, 0.5, 0.25],
    ]) {
      expect(
        boxesToDraw({ rects: [good, bad as [number, number, number, number]] }),
      ).toEqual([]);
    }
    expect(boxesToDraw({ rects: [], absent: "unaligned" })).toEqual([]);
    expect(boxesToDraw(null)).toEqual([]);
    expect(boxesToDraw(undefined)).toEqual([]);
    expect(boxesToDraw({ rects: Array(MAX_BOXES + 1).fill(good) })).toEqual([]);
    expect(boxesToDraw({ rects: Array(MAX_BOXES).fill(good) })).toHaveLength(
      MAX_BOXES,
    );
  });

  it("places a box in percent of the picture, so it holds at any size", () => {
    expect(boxStyle([0.1, 0.2, 0.5, 0.25])).toEqual({
      left: "10.0000%",
      top: "20.0000%",
      width: "40.0000%",
      height: "5.0000%",
    });
  });

  it("scrolls only the given scroller to centre the target", () => {
    const scroller = document.createElement("div");
    scroller.style.cssText = "height: 100px; width: 100px; overflow: auto";
    const inner = document.createElement("div");
    inner.style.cssText = "height: 1000px; width: 1000px; position: relative";
    const target = document.createElement("span");
    target.style.cssText =
      "position: absolute; top: 600px; left: 400px; width: 20px; height: 10px";
    inner.append(target);
    scroller.append(inner);
    document.body.append(scroller);
    const before = window.scrollY;
    centreIn(scroller, target);
    // Its middle, 605 down and 410 across, in the middle of the 100 x 100 view.
    expect(scroller.scrollTop).toBe(555);
    expect(scroller.scrollLeft).toBe(360);
    expect(window.scrollY).toBe(before);
    scroller.remove();
  });
});
