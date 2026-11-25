import type { ReactNode } from "react";

/** A closed disclosure for the long explanation of a setting: the sentences that carry the key
 * facts stay visible beside it. A native `<details>`, so the keyboard (Enter and Space on the
 * summary) and screen readers (expanded or collapsed) are the browser's own. Its name says what
 * it is about and stays the same open or closed, so two of them on one page are told apart and
 * the state is the browser's to announce. */
export function MoreAbout({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <details className="more-about">
      <summary>{label}</summary>
      <div className="more-about-body">{children}</div>
    </details>
  );
}
