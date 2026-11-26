import { useEffect, useId, useRef } from "react";
import { Icon } from "../Icon";
import { useI18n } from "../i18n";
import type { VideoRefusal } from "../vault";
import {
  useAddVideo,
  type AddVideoApi,
  type AddVideoBridge,
} from "./useAddVideo";

export { canAddVideo, useAddVideo } from "./useAddVideo";
export type { AddVideoApi, AddVideoBridge } from "./useAddVideo";

/** The words for each reason a video is refused. */
const REFUSAL_TEXT = {
  notVideo: "interface.AddVideo.notVideo",
  hevc: "interface.AddVideo.hevc",
  videoCodec: "interface.AddVideo.videoCodec",
  audioCodec: "interface.AddVideo.audioCodec",
  noVideo: "interface.AddVideo.noVideo",
  tooManyTracks: "interface.AddVideo.tooManyTracks",
  external: "interface.AddVideo.external",
  fragmented: "interface.AddVideo.fragmented",
  tooBig: "interface.AddVideo.tooBig",
  tooLarge: "interface.AddVideo.tooLarge",
  damaged: "interface.AddVideo.damaged",
} as const satisfies Record<VideoRefusal, string>;

/** True once `working` goes from true to false while the caller is on screen. */
function useFinished(working: boolean): boolean {
  const was = useRef(working);
  const done = was.current && !working;
  useEffect(() => {
    was.current = working;
  }, [working]);
  return done;
}

/**
 * The "Add a video" button. It can be on screen more than once (the library's row, a menu): each
 * has its own id for its description. While an import runs it waits; when it ends the focus comes
 * back to it, if it is the one on screen.
 */
export function AddVideoButton({
  add,
  profileId,
  folderIds,
  disabled = false,
}: {
  add: AddVideoApi;
  profileId: string;
  folderIds: string[];
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const hint = useId();
  const button = useRef<HTMLButtonElement | null>(null);
  const finished = useFinished(add.working);
  useEffect(() => {
    if (finished) button.current?.focus();
  }, [finished]);
  return (
    <>
      <button
        ref={button}
        className="button"
        type="button"
        disabled={disabled || add.working}
        onClick={() => void add.start(profileId, folderIds)}
        aria-describedby={hint}
      >
        <Icon name="video" />
        <span>{t("interface.AddVideo.add")}</span>
      </button>
      <span id={hint} hidden>
        {t("interface.AddVideo.hint")}
      </span>
    </>
  );
}

/**
 * Where an import is: render it ONCE (the same state serves every Add button). The two lines that
 * speak are always on screen, empty, and get their words later (a live region that arrives with its
 * text is often not read): the status line changes only when the stage does (Checking, Adding,
 * Cancelling, and the answer), never with the percentage, which sits beside the bar for the eye (the
 * bar itself carries its value for a screen reader); refusals and failures are the alert line.
 */
export function AddVideoStatus({ add }: { add: AddVideoApi }) {
  const { t } = useI18n();
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  // Focus moves to Cancel when the bar appears while this is on screen (the Add button, where the
  // focus was, is disabled then); coming back to a running import takes no focus.
  const was = useRef(add.working);
  useEffect(() => {
    if (add.working && !was.current) cancelButton.current?.focus();
    was.current = add.working;
  }, [add.working]);

  const storing =
    add.progress?.stage === "storing" && add.progress.totalBytes > 0
      ? add.progress
      : null;
  const percent = storing
    ? Math.min(100, Math.floor((storing.doneBytes / storing.totalBytes) * 100))
    : null;
  const outcome = add.outcome;
  const problem = !add.working && outcome ? outcome : null;
  const said = add.working
    ? add.cancelling
      ? t("interface.AddVideo.cancelling")
      : percent === null
        ? t("interface.AddVideo.checking")
        : t("interface.AddVideo.adding")
    : outcome && outcome.kind !== "refused" && outcome.kind !== "failed"
      ? t(`interface.AddVideo.${outcome.kind}` as const)
      : "";
  const alert =
    problem?.kind === "failed"
      ? problem.text
      : problem?.kind === "refused"
        ? t(REFUSAL_TEXT[problem.reason])
        : "";
  return (
    <div className="add-video-status">
      {add.working && (
        <div
          className="add-video-progress"
          role="group"
          aria-label={t("interface.AddVideo.progressLabel")}
        >
          <progress
            aria-label={t("interface.AddVideo.progressLabel")}
            max={percent === null ? undefined : 100}
            value={percent === null ? undefined : percent}
          />
          {percent !== null && <span aria-hidden="true">{percent}%</span>}
          <button
            ref={cancelButton}
            className="button"
            type="button"
            disabled={add.cancelling}
            onClick={add.cancel}
          >
            {t("interface.AddVideo.cancel")}
          </button>
        </div>
      )}
      <p className="add-video-result" role="status">
        {said}
      </p>
      <p className="add-video-result add-video-problem" role="alert">
        {alert}
      </p>
    </div>
  );
}

/** The button and its status, with the state kept here: for a screen that has no use for sharing
 * it (and for tests). */
export function AddVideo({
  bridge,
  profileId,
  folderIds,
  disabled = false,
  onAdded,
}: {
  bridge: AddVideoBridge;
  profileId: string;
  folderIds: string[];
  disabled?: boolean;
  onAdded?: (recordId: string) => void;
}) {
  const add = useAddVideo({ bridge, onAdded });
  return (
    <span className="add-video">
      <AddVideoButton
        add={add}
        profileId={profileId}
        folderIds={folderIds}
        disabled={disabled}
      />
      <AddVideoStatus add={add} />
    </span>
  );
}
