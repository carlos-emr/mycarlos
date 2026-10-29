import { formatNumber, t as translateNow } from "../i18n";

/** A count shown as a bare number beside a name (the sidebar, Security's
 * Hidden entry). A screen reader hears what it counts ("3 documents") after
 * the visible name, so the control's name still starts with its visible
 * words (WCAG 2.5.3). */
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
