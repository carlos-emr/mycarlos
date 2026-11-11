import { useEffect, useState } from "react";

/**
 * A narrow or short window: under 700 px wide or under 600 px tall at the
 * browser's default text size. In em, so the browser's zoom counts: a
 * 1280 x 800 screen at 200% zoom is 640 x 400 to the page, and matches.
 */
export const SMALL_WINDOW = "(max-width: 43.75em), (max-height: 37.5em)";

/** Whether `query` matches the window now, and again each time that changes. */
export function useMediaMatch(query: string): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}
