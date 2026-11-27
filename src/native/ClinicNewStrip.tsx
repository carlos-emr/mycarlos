/**
 * The seam for the "New" marker: the slot above the list where a strip of "{N} new from your
 * clinic" with Show them and Mark all as seen will go (scope: new-marker-scope-20261124). It shows
 * nothing until the marker's own PRs give the library a count of new clinic documents, so the
 * overhaul leaves the place, the props and the test, and takes nothing else for the marker.
 */
export function ClinicNewStrip({
  count,
}: {
  /** How many clinic documents are new to the patient on this device. Zero shows nothing. */
  count: number;
  /** Opens the list of only the new documents (not wired yet). */
  onShow?: () => void;
  /** Marks every new document as seen (not wired yet). */
  onMarkAllSeen?: () => void;
}) {
  void count;
  return null;
}
