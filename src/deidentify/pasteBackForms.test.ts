import { describe, expect, it } from "vitest";
import { deidentify, restoreChecked } from "./deidentify";

// Paste-back puts each placeholder back as the words that stood there, never the first form's
// words: "Bell" after "Peter Bell" must not come back as "Peter Bell" (#214). FAKE names only.

const run = (text: string) => deidentify(text, { knownNames: ["Peter Bell"] });
const back = (text: string, answer?: string) => {
  const result = run(text);
  return {
    sent: result.toSend,
    restored: restoreChecked(answer ?? result.toSend, result).text,
  };
};

describe("each form of a name is put back as it was written", () => {
  it("full name then short: the short form keeps the person's number and its own note", () => {
    const { sent, restored } = back("Peter Bell came. Later Bell left.");
    expect(sent).toBe("[NAME 1] came. Later [NAME 1, other form 1] left.");
    expect(restored).toBe("Peter Bell came. Later Bell left.");
  });

  it("short then full: the first form seen is the plain placeholder", () => {
    const { sent, restored } = back("Bell came. Later Peter Bell left.");
    expect(sent).toBe("[NAME 1] came. Later [NAME 1, other form 1] left.");
    expect(restored).toBe("Bell came. Later Peter Bell left.");
  });

  it("possessives: the 's stays outside the placeholder and nothing is added", () => {
    const { sent, restored } = back("Peter Bell's file. Bell's chart.");
    expect(sent).toBe("[NAME 1]'s file. [NAME 1, other form 1]'s chart.");
    expect(restored).toBe("Peter Bell's file. Bell's chart.");
  });

  it("a third form gets the next number, and a repeated form the same one", () => {
    const { sent, restored } = back(
      "Peter Bell; Bell; Peter; Bell; Peter Bell.",
    );
    expect(sent).toBe(
      "[NAME 1]; [NAME 1, other form 1]; [NAME 1, other form 2]; [NAME 1, other form 1]; [NAME 1].",
    );
    expect(restored).toBe("Peter Bell; Bell; Peter; Bell; Peter Bell.");
  });

  it("an answer that reorders or repeats placeholders restores each as its own form", () => {
    const result = run("Peter Bell came. Later Bell left.");
    const answer =
      "[NAME 1, other form 1] is stable; [NAME 1] agreed; [NAME 1, other form 1] again, then [NAME 1].";
    expect(restoreChecked(answer, result).text).toBe(
      "Bell is stable; Peter Bell agreed; Bell again, then Peter Bell.",
    );
  });

  it("an answer that drops the note restores the person's first form, never words not in the text", () => {
    const result = run("Peter Bell came. Later Bell left.");
    const out = restoreChecked("[NAME 1] is stable.", result);
    expect(out.text).toBe("Peter Bell is stable.");
    expect(out.flagged).toEqual([]);
  });

  it("a name seen in one form only has no note", () => {
    expect(back("Peter Bell came; Peter Bell left.").sent).toBe(
      "[NAME 1] came; [NAME 1] left.",
    );
  });

  it("two people are never confused: each keeps its own number and forms", () => {
    const result = deidentify("Peter Bell and Ann Cole; Bell and Cole.", {
      knownNames: ["Peter Bell", "Ann Cole"],
    });
    expect(result.toSend).toBe(
      "[NAME 1] and [NAME 2]; [NAME 1, other form 1] and [NAME 2, other form 1].",
    );
    expect(restoreChecked(result.toSend, result).text).toBe(
      "Peter Bell and Ann Cole; Bell and Cole.",
    );
  });
});
