/** Whether the reader offers "Explain a term" (#72). Switched off on
 * 11 November 2026 (Ben): patients look terms up themselves. With it off,
 * the reader shows Summary only and nothing opens Explain. The native command,
 * its prompt, the panel's Explain code and the Fluent keys all stay, so tests
 * turn this on to keep them covered, and turning it back on is this line. */
export const AI_EXPLAIN_ENABLED: boolean = false;
