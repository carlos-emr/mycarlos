import type { FakeAiModelRow, FakeCatalogEntry } from "./aiFake";

/** Accepted synthetic catalog only: no model file or real download address. */
export const FAKE_CATALOG: FakeCatalogEntry[] = [
  {
    name: "FAKE Qwen3.5 4B (Q4_K_M)",
    fileName: "FAKE-Qwen.gguf",
    sizeBytes: 3_013_000_000,
    sha256: "a".repeat(64),
    licence: "FAKE Apache-2.0",
    notices: [],
    sourceUrl: "https://example.invalid/FAKE-models/qwen/default.gguf",
  },
  {
    name: "FAKE Gemma 4 E2B (Q4_0)",
    fileName: "FAKE-Gemma.gguf",
    sizeBytes: 2_841_481_184,
    sha256: "b".repeat(64),
    licence: "FAKE Apache-2.0",
    notices: [],
    sourceUrl: "https://example.invalid/FAKE-models/gemma/offered.gguf",
  },
];
export function catalogRows(
  installed: number[] = [],
  inUse: number | null = installed[0] ?? null,
): FakeAiModelRow[] {
  return FAKE_CATALOG.map((model, index) => ({
    index,
    model: structuredClone(model),
    state: installed.includes(index) ? "installed" : "notDownloaded",
    inUse: index === inUse,
    addedByYou: false,
  }));
}
