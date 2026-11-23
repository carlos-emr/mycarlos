import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";

/** One shipped library or tool, as scripts/generate-third-party-notices.mjs writes it. */
export interface NoticeComponent {
  ecosystem: "npm" | "cargo" | "bundled";
  name: string;
  version: string;
  /** The SPDX licence expression the package declares. */
  license: string;
  /** The licence ids that apply when the declared expression offers a choice or a pair. */
  applied?: ReadonlyArray<string>;
  /** The package's own source address (a bundled tool's `source`). */
  repository?: string;
  source?: string;
  /** The licence and notice files that came with it, by id into `texts`. */
  texts: ReadonlyArray<{ id: string; name: string }>;
}

export interface ThirdPartyNotices {
  schema: number;
  components: ReadonlyArray<NoticeComponent>;
  texts: Readonly<Record<string, string>>;
}

export interface NoticesData {
  notices: ThirdPartyNotices;
  /** The full text of the licence myCarlos itself is under (the repository's LICENSE). */
  ownLicence: string;
}

/** The build this is: its version, and its commit where the build was made from a checkout. */
export const BUILD_LABEL =
  typeof __MYCARLOS_VERSION__ === "string"
    ? `${__MYCARLOS_VERSION__}${__MYCARLOS_COMMIT__ ? `, commit ${__MYCARLOS_COMMIT__}` : ""}`
    : "";

/** Where the complete source of this version of myCarlos is, for the AGPL's source offer. */
export const SOURCE_ADDRESS = "https://github.com/carlos-emr/mycarlos";

/** Reads the generated notices and the licence text on first use, so the long texts are not
 * part of the app's first load. */
export async function loadNoticesData(): Promise<NoticesData> {
  const [notices, licence] = await Promise.all([
    import("./notices/third-party-notices.json"),
    import("../../LICENSE?raw"),
  ]);
  return {
    notices: notices.default as unknown as ThirdPartyNotices,
    ownLicence: licence.default,
  };
}

const KIND_KEY = {
  npm: "notices.kind.javascript",
  cargo: "notices.kind.rust",
  bundled: "notices.kind.bundled",
} as const;

/** The libraries whose name, version or licence contains what was typed. */
function filter(
  components: ReadonlyArray<NoticeComponent>,
  query: string,
): ReadonlyArray<NoticeComponent> {
  const needle = query.trim().toLowerCase();
  if (!needle) return components;
  return components.filter((component) =>
    `${component.name} ${component.version} ${component.license}`
      .toLowerCase()
      .includes(needle),
  );
}

/** One library: a closed entry that shows its licence texts when opened. */
function NoticeEntry({
  component,
  texts,
}: {
  component: NoticeComponent;
  texts: Readonly<Record<string, string>>;
}) {
  const { t } = useI18n();
  // The texts are built only once the entry has been opened: there are hundreds of entries.
  const [opened, setOpened] = useState(false);
  // "MIT OR Apache-2.0" is used under one of them: say which, as the texts shown are its.
  const applied = (component.applied ?? []).join(" and ");
  const usedUnder = applied && applied !== component.license ? applied : null;
  const address = component.repository ?? component.source ?? null;
  return (
    <li className="notice-entry">
      <details onToggle={(event) => setOpened(event.currentTarget.open)}>
        <summary>
          <span className="notice-name">
            {component.name}{" "}
            <span className="notice-version">{component.version}</span>
          </span>
          <span className="notice-licence">{component.license}</span>
        </summary>
        <p className="notice-kind">{t(KIND_KEY[component.ecosystem])}</p>
        {usedUnder && (
          <p className="notice-kind">
            {t("notices.usedUnder", { license: usedUnder })}
          </p>
        )}
        {address && (
          <p className="notice-kind">{t("notices.repository", { address })}</p>
        )}
        {opened && component.texts.length === 0 && <p>{t("notices.noText")}</p>}
        {opened &&
          component.texts.map((file) => (
            <div key={`${file.id}-${file.name}`}>
              <p className="notice-file">
                <strong>{file.name}</strong>
              </p>
              <pre
                className="notice-text"
                role="region"
                aria-label={`${component.name} ${component.version}: ${file.name}`}
                tabIndex={0}
              >
                {texts[file.id]}
              </pre>
            </div>
          ))}
      </details>
    </li>
  );
}

/** Settings > Preferences > Open-source notices: the libraries myCarlos is built with and their
 * licences, myCarlos's own licence, and where to get its source (AGPL section 13). */
export function OpenSourceNotices({
  onBack,
  load = loadNoticesData,
}: {
  onBack: () => void;
  load?: () => Promise<NoticesData>;
}) {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "failed" }
    | { status: "ready"; data: NoticesData }
  >({ status: "loading" });
  const [query, setQuery] = useState("");
  const [showOwn, setShowOwn] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  // The count is announced once the typing pauses, not at every keystroke.
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query), 500);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setState({ status: "ready", data });
      },
      () => {
        if (!cancelled) setState({ status: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);

  const components =
    state.status === "ready" ? state.data.notices.components : [];
  const matches = useMemo(() => filter(components, query), [components, query]);

  return (
    <main className="library-main purpose-screen open-source-notices">
      <button className="button breadcrumb" type="button" onClick={onBack}>
        <span aria-hidden="true">‹</span> {t("notices.back")}
      </button>
      <div className="main-head">
        <div>
          <h1 ref={headingRef} tabIndex={-1}>
            {t("notices.title")}
          </h1>
          <p>{t("notices.intro")}</p>
        </div>
      </div>

      <section className="setting-row notice-own">
        <div>
          <h2>{t("notices.own.title")}</h2>
          <p>{t("notices.own.body")}</p>
          <h3>{t("notices.source.title")}</h3>
          <p>{t("notices.source.body", { version: BUILD_LABEL })}</p>
          <p>
            <code className="notice-address" id="notice-source-address">
              {SOURCE_ADDRESS}
            </code>{" "}
            <button
              className="button"
              type="button"
              aria-describedby="notice-source-address"
              onClick={() => {
                if (!navigator.clipboard) {
                  setCopyStatus(t("notices.copyFailed"));
                  return;
                }
                navigator.clipboard.writeText(SOURCE_ADDRESS).then(
                  () => setCopyStatus(t("notices.copied")),
                  () => setCopyStatus(t("notices.copyFailed")),
                );
              }}
            >
              {t("notices.copy")}
            </button>
          </p>
          <p className="status-line" role="status">
            {copyStatus}
          </p>
          <details onToggle={(event) => setShowOwn(event.currentTarget.open)}>
            <summary>{t("notices.own.show")}</summary>
            {showOwn && state.status === "ready" && (
              <pre
                className="notice-text"
                role="region"
                aria-label={t("notices.own.title")}
                tabIndex={0}
              >
                {state.data.ownLicence}
              </pre>
            )}
            {showOwn && state.status === "loading" && (
              <p>{t("notices.loading")}</p>
            )}
            {showOwn && state.status === "failed" && (
              <p>{t("notices.failed")}</p>
            )}
          </details>
        </div>
      </section>

      <h2 className="notice-list-title">{t("notices.list.title")}</h2>
      {state.status === "loading" && (
        <p role="status">{t("notices.loading")}</p>
      )}
      {state.status === "failed" && <p role="alert">{t("notices.failed")}</p>}
      {state.status === "ready" && (
        <>
          <label className="notice-search">
            <span>{t("notices.search")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p className="status-line" role="status">
            {settled.trim()
              ? t("notices.count.filtered", {
                  count: filter(components, settled).length,
                  total: components.length,
                })
              : t("notices.count.all", { total: components.length })}
          </p>
          {matches.length === 0 ? (
            <p>{t("notices.none")}</p>
          ) : (
            <ul className="notice-list">
              {matches.map((component) => (
                <NoticeEntry
                  key={`${component.ecosystem}:${component.name}@${component.version}`}
                  component={component}
                  texts={state.data.notices.texts}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
