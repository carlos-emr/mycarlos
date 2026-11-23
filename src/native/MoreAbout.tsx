import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n";

/** A closed disclosure for the long explanation of a setting: the sentence that carries the key
 * fact stays visible beside it. A native `<details>`, so the keyboard (Enter and Space on the
 * summary) and screen readers (expanded or collapsed) are the browser's own. */
export function MoreAbout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="more-about"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{open ? t("preferences.less") : t("preferences.more")}</summary>
      <div className="more-about-body">{children}</div>
    </details>
  );
}
