import { useRef, useState } from "react";
import { Icon } from "../Icon";
import { useI18n } from "../i18n";
import { useModalFocus } from "../useModalFocus";
import { LanguageSetting, languageName } from "./LanguageSetting";

/** The way to another language from the unlock and set-up screens, where the
 * full list is not shown (it is on the first set-up screen and in Settings):
 * a small button with a globe and the current language's OWN name, which stays
 * recognisable to someone who cannot read the screen's words, opening the same
 * list in a dialog. The list is the Settings one, so a choice is remembered
 * the same way. */
export function LanguageButton() {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="language-corner">
      <button
        ref={opener}
        type="button"
        className="language-button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="globe" />
        <span lang={locale}>{languageName(locale)}</span>
        <span className="sr-only"> ({t("language.title")})</span>
      </button>
      {open && (
        <LanguageDialog
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function LanguageDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocus(true, dialogRef, onClose, closeRef);
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="record-dialog native-language-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="language-dialog-title"
      >
        <header className="dialog-head">
          <div>
            <h2 id="language-dialog-title">{t("language.title")}</h2>
          </div>
        </header>
        <LanguageSetting compact showTitle={false} />
        <footer className="native-dialog-actions">
          <button
            ref={closeRef}
            className="button primary"
            type="button"
            onClick={onClose}
          >
            {t("interface.AnonymizePreview.close")}
          </button>
        </footer>
      </section>
    </div>
  );
}
