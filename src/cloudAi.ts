// The patient's own cloud AI key and the per-document send (#72, THREAT_MODEL AI-11 and NET-05,
// proposed). Page side only, against a bridge the native side will provide later. The build flag
// is off unless VITE_CLOUD_AI=1, so a normal build shows none of it; this code holds no key after
// it is typed, makes no request, and never knows a provider address.

/** True only in a build made with VITE_CLOUD_AI=1. Read when asked, so a test can set it. */
export const cloudAiBuild = (): boolean =>
  import.meta.env.VITE_CLOUD_AI === "1";

/** A stored key as the page may know it: masked, never the secret. */
export interface CloudKeyInfo {
  id: string;
  provider: "anthropic";
  label: string;
  keyLast4: string;
  addedAtMs: number;
}

/** Why a key was not stored (the native side names one of these). */
export type CloudKeyRefusal =
  | "badShape"
  | "adminKey"
  | "duplicate"
  | "tooMany"
  | "badLabel";

/** What the native side prepared for one send, after it re-checked the text. The size and the
 * cost are its numbers, not the page's. */
export interface CloudSendPrepared {
  exchangeId: string;
  characters: number;
  estimatedTokens: number;
  /** In US dollars, or null when the model has no price in the app's table. */
  estimatedCostUsd: number | null;
  modelLabel: string;
}

/** The answer, already checked and restored by the native side. */
export interface CloudSendAnswer {
  text: string;
}

export interface CloudAiBridge {
  enabled: () => Promise<boolean>;
  setEnabled: (on: boolean) => Promise<void>;
  listKeys: () => Promise<CloudKeyInfo[]>;
  /** Rejects with `{ code: CloudKeyRefusal }` when the key is refused. */
  addKey: (request: {
    provider: "anthropic";
    label: string;
    key: string;
  }) => Promise<CloudKeyInfo>;
  removeKey: (id: string) => Promise<void>;
  /** The native re-check and the size and cost, before anything is asked. A hit in the re-check
   * rejects with `{ code: "recheck" }`. */
  prepare: (request: {
    keyId: string;
    text: string;
  }) => Promise<CloudSendPrepared>;
  /** Sends one prepared text. Only the native side makes the request. */
  send: (exchangeId: string) => Promise<CloudSendAnswer>;
  /** Drops a prepared or running send. */
  cancel: (exchangeId: string) => Promise<void>;
}

const REFUSALS: readonly CloudKeyRefusal[] = [
  "badShape",
  "adminKey",
  "duplicate",
  "tooMany",
  "badLabel",
];

/** The refusal an error carries, or null for any other failure. */
export function cloudKeyRefusal(error: unknown): CloudKeyRefusal | null {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return REFUSALS.find((refusal) => refusal === code) ?? null;
}
