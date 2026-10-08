import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
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
  zoomRequestOfKey,
  type Zoom,
  type ZoomRequest,
} from "./zoom";

const NativeZoomContext = createContext<NativeZoom | null>(null);

/** The native zoom for the screens below: at the first render, or later if
 * the platform answered after it; null where there is none (a browser, a
 * phone). Every change of size is told from here, on every screen. */
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
      {native && <ZoomAnnouncer zoom={native.zoom} />}
      {children}
    </NativeZoomContext.Provider>
  );
}

export const useNativeZoom = () => useContext(NativeZoomContext);

/** Tells a screen reader the new size, whatever changed it and wherever the
 * focus is: a key or the wheel works on every screen, not only Preferences. */
function ZoomAnnouncer({ zoom }: { zoom: Zoom }) {
  const level = useSyncExternalStore(zoom.subscribe, zoom.level);
  return (
    <p className="sr-only" role="status" aria-atomic="true">
      {`Text size ${zoomPercent(level)}`}
    </p>
  );
}

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
  // the size as it is.
  const [draft, setDraft] = useState<string | null>(null);
  // A refusal or a note about the size typed, shown under the box.
  const [message, setMessage] = useState<{ text: string; error: boolean }>({
    text: "",
    error: false,
  });
  // Whether the next change of size is this setting's own. Any other (a key,
  // the wheel) makes what was typed, and the note about it, out of date.
  const own = useRef(false);
  // Whether "Back to normal size" was pressed, had the focus when the size
  // changed, or is where the focus went from the box with 100 typed: it goes
  // at the ordinary size, and the focus must not be left on nothing, whatever
  // changed the size (the button, a key or the wheel).
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
    if (own.current) own.current = false;
    else {
      setDraft(null);
      setMessage({ text: "", error: false });
    }
    const wanted = refocus.current;
    refocus.current = false;
    if (!wanted || level !== 1) return;
    const lost =
      !document.activeElement || document.activeElement === document.body;
    if (lost && !modalOpen()) larger.current?.focus();
  }, [level]);

  const change = (act: () => void) => {
    const before = zoom.level();
    act();
    // Only a change that happened is waited for as this setting's own.
    if (zoom.level() !== before) own.current = true;
  };

  const step = (request: ZoomRequest) => {
    setDraft(null);
    setMessage({ text: "", error: false });
    change(() => zoom.request(request));
  };

  // Applies what is typed. A refusal keeps the text, to be corrected.
  const apply = (next: EventTarget | null = null) => {
    if (draft === null) return;
    const typed = readTypedZoom(draft);
    if ("error" in typed) {
      setMessage({ text: typed.error, error: true });
      return;
    }
    setDraft(null);
    setMessage({ text: typed.note, error: false });
    // Leaving the box for "Back to normal size" with 100 typed: the button
    // goes before its click lands, and the focus must not be lost with it.
    if (typed.level === 1 && next !== null && next === back.current)
      refocus.current = true;
    change(() => zoom.set(typed.level));
  };

  const leave = (event: FocusEvent<HTMLInputElement>) => {
    // The window lost the focus (another app), not the box: a size half typed
    // is not applied; it waits for the patient's return.
    if (document.activeElement === event.currentTarget) return;
    apply(event.relatedTarget);
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
                // A note about the last size typed is out of date too, and a
                // note dropped here is read out again if it comes back.
                if (message.text) setMessage({ text: "", error: false });
              }}
              onKeyDown={(event) => {
                if (zoomRequestOfKey(event.nativeEvent, mac)) {
                  // A zoom key goes on to change the size, or not (Ctrl+0 at
                  // 100%): either way what was typed is given up, so leaving
                  // the box cannot apply it after the key.
                  setDraft(null);
                  setMessage({ text: "", error: false });
                } else if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  apply();
                } else if (event.key === "Escape" && draft !== null) {
                  // Gives up what was typed. With nothing to give up, Escape
                  // is left to the page.
                  event.preventDefault();
                  setDraft(null);
                  setMessage({ text: "", error: false });
                }
              }}
              onBlur={leave}
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
                step("reset");
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
