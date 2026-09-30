// A status line (a live region) is read out only when its text changes while
// it is in the accessibility tree. One that has just appeared, with a new
// screen or as a dialog closes, needs a moment to get there, so a message meant
// to be read out in it is written this long after it appears.
export const ANNOUNCE_DELAY_MS = 250;
