import { useId, useRef } from "react";
import { useI18n } from "../i18n";

/**
 * "{N} new from your clinic": the strip above the library's list for clinic documents the patient
 * has not looked at yet on this device (the New marker, scope: new-marker-scope-20261124).
 *
 * - **Only when there is something new.** A count of zero shows nothing, so the strip is not a
 *   permanent line of the page.
 * - **Words, never a name.** It says how many, never which clinic or which document, so it is
 *   safe on a screen others can see. With documents from more than one clinic it says "clinics".
 * - **A labelled region** whose heading is the count, so a reader hears it with the page; the two
 *   buttons carry the count in their names ("Show them, 3 new from your clinic"), and the visible
 *   words come first in each name.
 * - **Show them** lists only the new documents; while that list is shown the button turns into
 *   **Show all documents**. **Mark all as seen** clears them; the strip then leaves the page and
 *   the library moves the focus to its heading.
 * - It does not announce itself: the library announces a rise in the count politely, once.
 */
export function ClinicNewStrip({
  count,
  clinics = 1,
  showing = false,
  onShow,
  onShowAll,
  onMarkAllSeen,
}: {
  /** How many clinic documents are new to the patient on this device. Zero shows nothing. */
  count: number;
  /** How many different clinics they are from (more than one says "clinics"). */
  clinics?: number;
  /** Whether the list is showing only the new documents. */
  showing?: boolean;
  /** Opens the list of only the new documents. */
  onShow?: () => void;
  /** Goes back to the whole list. */
  onShowAll?: () => void;
  /** Marks every new document as seen. */
  onMarkAllSeen?: () => void;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement | null>(null);
  if (count <= 0) return null;
  const title = t(
    clinics > 1
      ? "interface.clinicNew.fromClinics"
      : "interface.clinicNew.fromClinic",
    { count },
  );
  // The visible words lead each name, so "click Show them" reaches the button (WCAG 2.5.3).
  const named = (action: string) =>
    t("interface.clinicNew.named", { action, detail: title });
  const moveFocusToHeading = () =>
    // After the list has changed, the heading is where the patient was.
    window.requestAnimationFrame(() => heading.current?.focus());
  const showThem = t("interface.clinicNew.showThem");
  const showAll = t("interface.clinicNew.showAll");
  const markAll = t("interface.clinicNew.markAll");
  return (
    <section className="clinic-new-strip" aria-labelledby={headingId}>
      <h2 id={headingId} ref={heading} tabIndex={-1}>
        {title}
      </h2>
      {showing && <p>{t("interface.clinicNew.showing")}</p>}
      <div className="clinic-new-actions">
        <button
          type="button"
          className="button"
          aria-label={showing ? undefined : named(showThem)}
          onClick={() => {
            if (showing) onShowAll?.();
            else onShow?.();
            moveFocusToHeading();
          }}
        >
          {showing ? showAll : showThem}
        </button>
        <button
          type="button"
          className="button"
          aria-label={named(markAll)}
          onClick={() => onMarkAllSeen?.()}
        >
          {markAll}
        </button>
      </div>
    </section>
  );
}
