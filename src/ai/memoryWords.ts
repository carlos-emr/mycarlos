// How much free memory an AI start needs and how much is free, for the "not enough memory"
// refusal (#305). The native side hands the numbers over (`PublicError.memory`); this only reads
// them and writes them in gigabytes, rounding the need up and the free amount down, so that the
// message never claims the computer is closer to enough than it is.

import { getLocale } from "../i18n";

/** What a refusal for memory knew, or null when it carried no numbers. */
export function memoryShortfall(
  error: unknown,
): { needed: number; available: number | null } | null {
  if (typeof error !== "object" || error === null) return null;
  const memory = (error as { memory?: unknown }).memory;
  if (typeof memory !== "object" || memory === null) return null;
  const { neededBytes, availableBytes } = memory as {
    neededBytes?: unknown;
    availableBytes?: unknown;
  };
  const plain = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!plain(neededBytes)) return null;
  return {
    needed: neededBytes,
    available: plain(availableBytes) ? availableBytes : null,
  };
}

/** "3.9 GB": decimal gigabytes (as the other messages say "about 4 GB"), one decimal, in the
 * language in use. `round` says which way: up for what is needed, down for what is free. */
export function gigabytes(bytes: number, round: "up" | "down"): string {
  const tenths = (bytes / 1e9) * 10;
  const rounded =
    (round === "up" ? Math.ceil(tenths) : Math.floor(tenths)) / 10;
  const locale = getLocale();
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rounded)} GB`;
}
