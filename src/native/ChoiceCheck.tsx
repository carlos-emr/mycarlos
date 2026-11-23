/** The check mark inside a chosen button of a radio group drawn as buttons
 * (Appearance, Language). It is there so that the chosen one is told apart by
 * more than its colour. It is for the eye only: the radio itself says
 * "checked", and the name of the choice stays the text beside it. The CSS
 * shows it for the checked radio only, and keeps its room when it is hidden so
 * that choosing does not move the words. */
export function ChoiceCheck() {
  return (
    <svg
      className="choice-check"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}
