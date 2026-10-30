import { formatNumber, t as translateNow } from "../i18n";

/** A count shown as a bare number beside a name (the sidebar, Security's
 * Hidden entry). A screen reader hears the number with what it counts
 * ("3 documents") where the number is shown, so the control's name still
 * starts with its visible words (WCAG 2.5.3). Anything shown after the count,
 * such as the Hidden entry's scope, comes after the unit in the name. */
export function SpokenCount({ count }: { count: number }) {
  return (
    <>
      <span className="nav-count" aria-hidden="true">
        {formatNumber(count)}
      </span>
      <span className="sr-only">
        {translateNow("sidebar.documents", { count })}
      </span>
    </>
  );
}
