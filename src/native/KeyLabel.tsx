/** Letters and digits read out one at a time, not as a word, so that 0 and
 * O, or 1 and I, are clear. */
export const spoken = (text: string) => text.split("").join(" ");

/** A recovery key's short label, as it is printed, and spelled out to a
 * screen reader: a label such as "BEAD" is not a word. */
export function KeyLabel({ label }: { label: string }) {
  return (
    <strong>
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{spoken(label)}</span>
    </strong>
  );
}
