import { describe, expect, it } from "vitest";
import { deidentify } from "./deidentify";
import fixture from "./fixtures/date-forms.json";

// The native re-check (src-tauri/src/text_recheck.rs, `date_hits`) runs the
// same cases: a date the remover reads is replaced by a placeholder here, and
// refused there if it is still in the text. Synthetic text only.
describe("the date forms the remover and the native re-check agree on", () => {
  it.each(fixture.cases)("$text", ({ text, date }) => {
    const sent = deidentify(text, { knownNames: [] }).toSend;
    if (date) {
      expect(sent).not.toBe(text);
      expect(sent).toMatch(/\[DATE \d+/);
      // The page's own output has no date left for the native check to refuse.
      expect(sent).not.toMatch(/\b(?:19|20)\d{2}\b/);
    } else {
      expect(sent).toBe(text);
    }
  });
});
