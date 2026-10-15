import { describe, expect, it } from "vitest";
import type { VaultFolder } from "../vault";
import { folderPath, folderSubtree, recordPath } from "./folderTree";

const folder = (
  id: string,
  name: string,
  parentId: string | null,
): VaultFolder => ({
  id,
  profileId: "profile-1",
  parentId,
  name,
  createdAtMs: 1,
});

const folders = [
  folder("lab", "FAKE Lab results", null),
  folder("lab-2026", "FAKE 2026", "lab"),
  folder("lab-2026-june", "FAKE June", "lab-2026"),
  folder("letters", "FAKE Letters", null),
];
const byId = new Map(folders.map((item) => [item.id, item]));

describe("folderTree", () => {
  it("collects a folder and every folder beneath it", () => {
    expect([...folderSubtree(folders, "lab")].sort()).toEqual([
      "lab",
      "lab-2026",
      "lab-2026-june",
    ]);
    expect([...folderSubtree(folders, "letters")]).toEqual(["letters"]);
  });

  it("names a folder's path from the top", () => {
    expect(folderPath(byId, null)).toBe("My records");
    expect(folderPath(byId, "lab-2026-june")).toBe(
      "My records / FAKE Lab results / FAKE 2026 / FAKE June",
    );
  });

  it("ends a path at a parent that is not known, or met twice", () => {
    const damaged = new Map([
      ["orphan", folder("orphan", "FAKE Orphan", "gone")],
      ["a", folder("a", "FAKE A", "b")],
      ["b", folder("b", "FAKE B", "a")],
    ]);
    expect(folderPath(damaged, "orphan")).toBe("My records / FAKE Orphan");
    expect(folderPath(damaged, "a")).toBe("My records / FAKE B / FAKE A");
  });

  it("names every folder a document is filed in, or the top level", () => {
    const record = (folderIds: string[]) => ({
      id: "record-1",
      profileId: "profile-1",
      folderIds,
      displayName: "FAKE Blood count.pdf",
      sourceLabel: "Manual import — unverified",
      mediaType: "application/pdf",
      plaintextSize: 2048,
      importedAtMs: 1,
      available: true,
    });
    expect(recordPath(byId, record([]))).toBe("My records");
    expect(recordPath(byId, record(["letters", "lab-2026"]))).toBe(
      "My records / FAKE Lab results / FAKE 2026; My records / FAKE Letters",
    );
    // A folder that is not known is left out rather than named wrongly.
    expect(recordPath(byId, record(["gone"]))).toBe("My records");
  });
});
