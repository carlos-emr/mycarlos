import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  useI18n,
  useTextState,
  message,
  deferredText,
  t as translateNow,
  type UiText,
} from "../i18n";
import { vaultErrorMessage } from "../vault";
import type { VaultBridge, VaultSnapshot, PortalLinkSummary } from "../vault";

interface Props {
  bridge: VaultBridge;
  snapshot: VaultSnapshot;
  busy: boolean;
  readOnly: boolean;
  run: (operation: () => Promise<void>) => Promise<void>;
  refresh: () => Promise<VaultSnapshot>;
  setNotice: (text: UiText) => void;
  compact?: boolean;
}

export function PortalDocuments({
  bridge,
  snapshot,
  busy,
  readOnly,
  run,
  refresh,
  setNotice,
  compact = false,
}: Props) {
  const { t } = useI18n();
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [device, setDevice] = useState("myCarlos");
  const [person, setPerson] = useState("");
  const [copyState, setCopyState] = useTextState();
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    void bridge
      .platform()
      .then((platform) => {
        const os: Record<string, string> = {
          windows: "Windows",
          macos: "macOS",
          linux: "Linux",
          android: "Android",
          ios: "iOS",
        };
        if (shown.current && os[platform])
          setDevice((current) =>
            current === "myCarlos" ? `myCarlos on ${os[platform]}` : current,
          );
      })
      .catch(() => {});
    return () => {
      shown.current = false;
    };
  }, [bridge]);
  if (
    !snapshot.portalLinkingEnabled ||
    !bridge.linkPortal ||
    !bridge.checkDocuments
  )
    return null;
  const links = snapshot.portalLinks ?? [];
  const terminal = (link: PortalLinkSummary) =>
    ["refused", "expired", "cancelled", "accepted"].includes(
      link.approvalStatus ?? "",
    );
  const approvalMessage = (link: PortalLinkSummary) => {
    if (link.incomplete) return t("portal.incomplete");
    if (link.clinicApproved) return t("portal.approved");
    if (link.approvalRequestLimitReached) return t("portal.approvalContact");
    if (link.approvalStatus === "expired") return t("portal.approvalExpired");
    if (link.approvalStatus === "cancelled")
      return t("portal.approvalCancelled");
    if (
      link.approvalStatus === "accepted" ||
      ["staff_required", "no_accepted_approver"].includes(
        link.approvalReason ?? "",
      )
    )
      return t("portal.approvalContact");
    if (link.approvalStatus === "refused") return t("portal.approvalRefused");
    return t(
      link.approvalRequested ? "portal.awaiting" : "portal.notRequested",
    );
  };
  const disabled = busy || readOnly;
  const check = () =>
    void run(async () => {
      try {
        const result = await bridge.checkDocuments!();
        await refresh();
        if (shown.current)
          setNotice(
            deferredText(() =>
              [
                translateNow(
                  result.issues?.length
                    ? "portal.partialResult"
                    : "portal.result",
                  {
                    added: result.added,
                    refused: result.refused,
                  },
                ),
                ...(result.issues ?? []).map((issue) =>
                  translateNow("portal.clinicIssue", {
                    clinic: issue.clinicName,
                    detail: vaultErrorMessage({
                      code: issue.code,
                      message: translateNow("portal.errorIncomplete"),
                    }),
                  }),
                ),
                ...(result.receiptsPending > 0
                  ? [
                      translateNow("portal.confirmationsPending", {
                        count: result.receiptsPending,
                      }),
                    ]
                  : []),
              ].join(" "),
            ),
          );
      } catch (error) {
        await refresh();
        throw error;
      }
    });
  const checkButton = (
    <button
      className="button"
      type="button"
      disabled={disabled || !links.some((link) => !link.incomplete)}
      onClick={check}
    >
      {t("portal.check")}
    </button>
  );
  if (compact) return links.length > 0 ? checkButton : null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    void run(async () => {
      try {
        await bridge.linkPortal!({
          portalBase: address,
          code,
          deviceName: device,
          profileId: person || null,
        });
        // The one-use code is not retained after this attempt.
        if (shown.current) setCode("");
      } finally {
        if (shown.current) setCode("");
        await refresh();
      }
    });
  };
  return (
    <section className="portal-documents" aria-labelledby="portal-title">
      <h2 id="portal-title">{t("portal.title")}</h2>
      <p>{t("portal.intro")}</p>
      <form className="native-inline-form" onSubmit={submit}>
        <label>
          {t("portal.address")}
          <input
            type="url"
            required
            value={address}
            maxLength={1024}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          {t("portal.code")}
          <input
            type="text"
            required
            value={code}
            maxLength={64}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          {t("portal.deviceName")}
          <input
            required
            value={device}
            maxLength={64}
            onChange={(e) => setDevice(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label>
          {t("portal.person")}
          <select
            value={person}
            onChange={(e) => setPerson(e.target.value)}
            disabled={disabled}
          >
            <option value="">{t("portal.matchPerson")}</option>
            {snapshot.profiles
              .filter((p) => p.id !== snapshot.sharedProfileId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
          </select>
        </label>
        <p>{t("portal.routing")}</p>
        <button className="button" type="submit" disabled={disabled}>
          {t("portal.link")}
        </button>
      </form>
      {links.map((link) => (
        <div className="portal-link" key={link.id}>
          <h3>{link.clinicName ?? link.portalBase}</h3>
          <p className="portal-address">{link.portalBase}</p>
          <p>{approvalMessage(link)}</p>
          <label>
            {t("portal.deviceCode")}
            <input
              readOnly
              value={link.deviceKeyId}
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            className="button"
            type="button"
            disabled={disabled}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(link.deviceKeyId)
                .then(() => setCopyState(message("portal.copied")))
                .catch(() => setCopyState(message("portal.copyFailed")));
              if (!navigator.clipboard)
                setCopyState(message("portal.copyFailed"));
            }}
          >
            {t("portal.copy")}
          </button>
          <label>
            {t("portal.fingerprint")}
            <textarea
              readOnly
              value={link.deviceFingerprint}
              rows={4}
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </label>
          {!link.incomplete && !link.clinicApproved && (
            <>
              <p>{t("portal.compare")}</p>
              <button
                className="button"
                type="button"
                disabled={
                  disabled || terminal(link) || !bridge.requestDeviceApproval
                }
                onClick={() =>
                  void run(async () => {
                    try {
                      await bridge.requestDeviceApproval!(link.id);
                    } finally {
                      await refresh();
                    }
                  })
                }
              >
                {t("portal.requestApproval")}
              </button>
              {link.approvalCanRestart && (
                <button
                  className="button"
                  type="button"
                  disabled={disabled || !bridge.restartDeviceApproval}
                  onClick={() =>
                    void run(async () => {
                      try {
                        await bridge.restartDeviceApproval!(link.id);
                      } finally {
                        await refresh();
                      }
                    })
                  }
                >
                  {t("portal.restartApproval")}
                </button>
              )}
            </>
          )}
        </div>
      ))}
      <p role="status">{copyState}</p>
      {checkButton}
    </section>
  );
}
