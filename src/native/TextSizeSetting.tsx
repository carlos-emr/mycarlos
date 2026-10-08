import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Icon } from "../Icon";
import type { NativeZoom } from "./nativeZoom";
import {
  ZOOM_LEVELS,
  ZOOM_MAX_PERCENT,
  ZOOM_MIN_PERCENT,
  readTypedZoom,
  zoomPercent,
  type Zoom,
} from "./zoom";

const NativeZoomContext = createContext<NativeZoom | null>(null);

/** The native zoom for the screens below: at the first render, or later if
 * the platform answered after it; null where there is none (a browser). */
export function NativeZoomProvider({
  initial,
  installed,
  children,
}: {
  initial: NativeZoom | null;
  installed: Promise<NativeZoom | null>;
  children: ReactNode;
}) {
  const [native, setNative] = useState(initial);
  useEffect(() => {
    if (native) return;
    let current = true;
    void installed.then((late) => {
      if (current && late) setNative(late);
    });
    return () => {
      current = false;
    };
  }, [installed, native]);
  return (
    <NativeZoomContext.Provider value={native}>
      {children}
    </NativeZoomContext.Provider>
  );
}

export const useNativeZoom = () => useContext(NativeZoomContext);

// A dialog over the page traps the focus: if the size changes behind it (with
// Ctrl+0), the focus stays in the dialog.
const modalOpen = () => Boolean(document.querySelector('[aria-modal="true"]'));

const percentOf = (level: number) => String(Math.round(level * 100));

/**
 * The size of the interface, under Settings > Preferences: smaller and larger
 * buttons, and a box to type a size. The size is kept between launches, so
 * one set by a slip of the wheel must be easy to see and to undo, without
 * knowing the keys. And the buttons are the only way to zoom without a
 * keyboard: handling the keys in the page turns off the platform's own zoom,
 * pinching included.
 */
export function TextSizeSetting({ zoom, mac }: { zoom: Zoom; mac: boolean }) {
  const level = useSyncExternalStore(zoom.subscribe, zoom.level);
  const modifier = mac ? "Command" : "Ctrl";
  const smallest = level === ZOOM_LEVELS[0];
  const largest = level === ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  const id = useId();
  const helpId = `${id}-help`;
  const messageId = `${id}-message`;
  const larger = useRef<HTMLButtonElement | null>(null);
  const back = useRef<HTMLButtonElement | null>(null);
  // What is typed in the box, until it is applied or given up; null shows
  // the size as it is, whatever changed it.
  const [draft, setDraft] = useState<string | null>(null);
  // A refusal or a note about the size typed, shown under the box.
  const [message, setMessage] = useState<{ text: string; error: boolean }>({
    text: "",
    error: false,
  });
  // Whether "Back to normal size" was pressed, or had the focus when the size
  // changed: it goes at the ordinary size, and the focus must not be left on
  // nothing, whatever changed the size (the button, a key or the wheel).
  const refocus = useRef(false);
  useEffect(
    () =>
      // Told before the button goes, while it may still have the focus.
      zoom.subscribe(() => {
        if (
          zoom.level() === 1 &&
          back.current &&
          document.activeElement === back.current
        )
          refocus.current = true;
      }),
    [zoom],
  );

  useEffect(() => {
    const wanted = refocus.current;
    refocus.current = false;
    if (!wanted || level !== 1) return;
    const lost =
      !document.activeElement || document.activeElement === document.body;
    if (lost && !modalOpen()) larger.current?.focus();
  }, [level]);

  const step = (request: "in" | "out") => {
    setDraft(null);
    setMessage({ text: "", error: false });
    zoom.request(request);
  };

  // Applies what is typed. A refusal keeps the text, to be corrected.
  const apply = () => {
    if (draft === null) return;
    const typed = readTypedZoom(draft);
    if ("error" in typed) {
      setMessage({ text: typed.error, error: true });
      return;
    }
    setDraft(null);
    setMessage({ text: typed.note, error: false });
    zoom.set(typed.level);
  };

  return (
    <section className="setting-row native-setting-form text-size-setting">
      <div>
        <h2>
          <Icon name="text-size" /> Text size{" "}
          <span className="state-pill">{zoomPercent(level)}</span>
        </h2>
        <p id={helpId}>
          Makes everything in myCarlos larger or smaller, from{" "}
          {ZOOM_MIN_PERCENT}% to {ZOOM_MAX_PERCENT}%. myCarlos remembers the
          size on this computer. You can also hold {modifier} and press plus,
          minus or 0.
        </p>
      </div>
      <div>
        {/* Told once per change, whatever made it. */}
        <p className="sr-only" role="status" aria-atomic="true">
          {`Text size ${zoomPercent(level)}`}
        </p>
        <div className="text-size-control">
          {/* Not disabled at either end, which would drop the focus on it. */}
          <button
            className="button text-size-step"
            type="button"
            aria-label="Smaller text"
            aria-disabled={smallest}
            onClick={() => {
              if (!smallest) step("out");
            }}
          >
            <span aria-hidden="true">−</span>
          </button>
          <label className="text-size-box">
            <span className="sr-only">Text size in percent</span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={draft ?? percentOf(level)}
              aria-describedby={`${messageId} ${helpId}`}
              aria-invalid={message.error || undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                if (message.error) setMessage({ text: "", error: false });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  apply();
                } else if (event.key === "Escape" && draft !== null) {
                  // Gives up what was typed; a dialog's own Escape still works
                  // when there is nothing to give up.
                  event.preventDefault();
                  setDraft(null);
                  setMessage({ text: "", error: false });
                }
              }}
              onBlur={apply}
            />
            <span aria-hidden="true">%</span>
          </label>
          <button
            ref={larger}
            className="button text-size-step"
            type="button"
            aria-label="Larger text"
            aria-disabled={largest}
            onClick={() => {
              if (!largest) step("in");
            }}
          >
            <span aria-hidden="true">+</span>
          </button>
          {level !== 1 && (
            <button
              ref={back}
              className="button"
              type="button"
              onClick={() => {
                refocus.current = true;
                setDraft(null);
                setMessage({ text: "", error: false });
                zoom.request("reset");
              }}
            >
              Back to normal size
            </button>
          )}
        </div>
        <p
          id={messageId}
          className={
            message.error ? "text-size-message error" : "text-size-message"
          }
          aria-live="polite"
        >
          {message.text}
        </p>
      </div>
    </section>
  );
}
