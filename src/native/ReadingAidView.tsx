import { formatDate, useI18n } from "../i18n";

/** The signed, canonical JSON of a clinic reading aid (delivery contract, "Reading aids"),
 * as the vault hands it to the reader after the native receiver verified it. */
export interface ReadingAid {
  language: string;
  notice: { version: string; heading: string; body: string };
  overview: string;
  points: { text: string; evidence: string[] }[];
}

interface ReadingAidViewProps {
  aid: ReadingAid;
  /** When the clinician's review was recorded (the signed approval's time). */
  reviewedAtMs: number;
  /** Opens the original document this aid reads. */
  onOpenOriginal: () => void;
}

const present = (text: unknown): text is string =>
  typeof text === "string" && text.trim() !== "";

/** A notice is plain text; blank lines separate its paragraphs. Never HTML. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * A reading aid is shown only under its notice, and the notice always comes first with a
 * way to open the original. If the notice is missing or blank the aid is not shown at all:
 * the patient is pointed to the original instead.
 */
export function ReadingAidView({
  aid,
  reviewedAtMs,
  onOpenOriginal,
}: ReadingAidViewProps) {
  const { t, locale } = useI18n();
  const noticeShown = present(aid.notice?.heading) && present(aid.notice?.body);
  if (!noticeShown) {
    return (
      <section aria-labelledby="reading-aid-title" className="reading-aid">
        <h2 id="reading-aid-title">{t("readingAid.title")}</h2>
        <p role="alert">{t("readingAid.unavailable")}</p>
        <button type="button" className="button" onClick={onOpenOriginal}>
          {t("readingAid.openOriginal")}
        </button>
      </section>
    );
  }
  return (
    <section
      aria-labelledby="reading-aid-title"
      className="reading-aid"
      lang={aid.language}
    >
      <h2 id="reading-aid-title">{t("readingAid.title")}</h2>
      <div className="reading-aid-notice" role="note">
        <h3>{aid.notice.heading}</h3>
        {paragraphs(aid.notice.body).map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
        <p>
          <button type="button" className="button" onClick={onOpenOriginal}>
            {t("readingAid.openOriginal")}
          </button>
        </p>
      </div>
      <p>
        <small>
          {t("readingAid.checked", {
            date: formatDate(reviewedAtMs, { dateStyle: "medium" }, locale),
          })}
        </small>
      </p>
      <h3>{t("readingAid.overview")}</h3>
      <p>{aid.overview}</p>
      <h3>{t("readingAid.points")}</h3>
      <ol>
        {aid.points.map((point, index) => (
          <li key={index}>
            <p>{point.text}</p>
            {point.evidence.map((excerpt, at) => (
              <blockquote key={at} lang={aid.language}>
                <small>{t("readingAid.evidence")}</small> {excerpt}
              </blockquote>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The line a document's details show when the clinic also sent a reading aid. */
export function ReadingAidEntry({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <p>
      {t("readingAid.available")}{" "}
      <button type="button" className="link-action" onClick={onOpen}>
        {t("readingAid.open")}
      </button>
    </p>
  );
}
