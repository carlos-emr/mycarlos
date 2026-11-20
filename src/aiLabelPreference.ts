/**
 * "Don't show this again" on the AI warning (#351). The full sentence above an AI answer, "Written
 * by AI and may be wrong. Check with your doctor.", can be shortened to an "AI draft" tag by a
 * person who has read it. The tag itself is never removed: this module only decides which of the
 * two is shown.
 *
 * It is a device preference, kept in the webview's storage like the other three (VAULT_FORMAT.md,
 * "Settings kept outside the vault"). It names no vault, patient or document. The choice is made
 * for one tool and one model: it is the identity `tool:revision:model-sha256`. A different model,
 * or a tool whose revision here was raised because its behaviour changed, has no choice made, so
 * the full sentence returns. Settings → AI helper clears every choice.
 */
export const AI_LABEL_STORAGE_KEY = "mycarlos.aiLabelShort.v1";

export type AiLabelTool = "summary" | "explain";

/** Raised when a tool's behaviour changes enough that its answers deserve the full warning again.
 * The summary's prompt is in Rust (`summary_prompt` in src-tauri/src/model_helper.rs): change that
 * prompt's meaning, raise this. */
export const AI_TOOL_REVISION: Record<AiLabelTool, string> = {
  summary: "1",
  explain: "1",
};

/** At most this many choices are kept (the oldest drop first). */
const MAX_CHOICES = 16;

const identity = (tool: AiLabelTool, modelSha256: string) =>
  `${tool}:${AI_TOOL_REVISION[tool]}:${modelSha256}`;

const listeners = new Set<() => void>();
// The storage can be blocked or unreadable (a private window, cleared data): the choice then lasts
// for this session only, and the full sentence is shown otherwise.
let memory: string[] = [];
// Whether the last write could not be stored, so that `memory` is the truth and not the storage.
let memoryOnly = false;

function read(): string[] {
  // A write that could not be stored: what is in memory is the truth, not a stale stored list.
  if (memoryOnly) return memory;
  try {
    const raw = window.localStorage.getItem(AI_LABEL_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return memory;
  }
}

function write(choices: string[]) {
  memory = choices;
  memoryOnly = false;
  try {
    if (choices.length === 0)
      window.localStorage.removeItem(AI_LABEL_STORAGE_KEY);
    else
      window.localStorage.setItem(
        AI_LABEL_STORAGE_KEY,
        JSON.stringify(choices),
      );
  } catch {
    // Kept in memory for this session.
    memoryOnly = true;
  }
  for (const listener of listeners) listener();
}

/** Whether the short tag stands in for the full sentence on this tool's answers from this model. */
export function aiLabelIsShort(
  tool: AiLabelTool,
  modelSha256: string,
): boolean {
  return read().includes(identity(tool, modelSha256));
}

/** "Don't show this again", for this tool and this model. */
export function rememberShortAiLabel(
  tool: AiLabelTool,
  modelSha256: string,
): void {
  const mine = identity(tool, modelSha256);
  write([...read().filter((item) => item !== mine), mine].slice(-MAX_CHOICES));
}

/** Settings → AI helper: the full sentence is shown again everywhere. */
export function showFullAiLabelAgain(): void {
  write([]);
}

/** Whether any choice is in force (for the Settings row). */
export function anyShortAiLabel(): boolean {
  return read().length > 0;
}

export function subscribeAiLabel(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** A snapshot string for useSyncExternalStore: it changes when any choice does. */
export function aiLabelSnapshot(): string {
  return read().join("|");
}
