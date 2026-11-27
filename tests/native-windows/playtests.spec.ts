// Playtest journeys for the INSTALLED Windows app: what the browser suite's fake vault cannot see
// (the real Rust, real files, the real Windows Save and Open dialogs). Each journey is a path a
// patient takes, from the playtest checklist (for-ben/playtest-checklist-windows-20261127.md).
//
// RUN: only on Windows, against an installed build and an EMPTY test account, with
//   MYCARLOS_WINDOWS_PLAYTESTS=1 MYCARLOS_WINDOWS_APP=<installed exe> npm run test:windows-playtests
// (the same CDP/policy variables as navigation.spec.ts). Without MYCARLOS_WINDOWS_PLAYTESTS=1 every
// test here is skipped, so the existing CI job is unchanged until its workflow line is added.
// These specs have NOT been run by their author: the machine that wrote them is Linux. They are
// type-checked and formatted there, and need a Windows run (the CI job once the line is added, or
// a Windows PC) before anyone relies on them.
//
// FAKE data only: dev-data/ (the FAKE PDFs and pictures). Nothing is written inside the vault
// folder except by the app itself; exports and backups go to a temp folder outside it.
import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openInstalledApp, type AppSession } from "./appSession";
import {
  createFakeVault,
  createPerson,
  eraseFakeVault,
  FAKE_PASSPHRASE,
  importSample,
  relock,
  snapshot,
  type FakeVault,
} from "./vault";

const ENABLED = process.env.MYCARLOS_WINDOWS_PLAYTESTS === "1";
const PASSPHRASE = FAKE_PASSPHRASE;
const BIRTH_DATE = "2016-11-04";
const FILE_PASSPHRASE = "marble heron cobalt thicket 5518 river";

test.describe.configure({ mode: "serial" });
test.skip(!ENABLED, "Set MYCARLOS_WINDOWS_PLAYTESTS=1 on a Windows runner");

let session: AppSession;
let work: string;
let vault: FakeVault;
let personId: string;

test.beforeAll(async ({ playwright }, testInfo) => {
  expect(process.platform, "Run this suite on Windows").toBe("win32");
  work = await mkdtemp(join(tmpdir(), "mycarlos-playtest-out-"));
  session = await openInstalledApp(playwright, testInfo);
  vault = await createFakeVault(session);
});

test.afterAll(async () => {
  try {
    if (session) await eraseFakeVault(session);
  } finally {
    await session?.stop();
    if (work) await rm(work, { recursive: true, force: true });
  }
});

test("a person with a birth date, FAKE PDFs and a picture", async () => {
  personId = await createPerson(session, "FAKE Playtest Person", BIRTH_DATE);
  for (const name of [
    "FAKE_Avery_Patient_Bloodwork.pdf",
    "FAKE_Avery_Patient_Cardiology_Letter.pdf",
    "FAKE_Picture_with_details.png",
  ])
    await test.step(`import ${name}`, () =>
      importSample(session, personId, name));
  const now = await snapshot(session);
  expect(now.records.filter((r) => r.profileId === personId)).toHaveLength(3);
});

for (const kind of ["generated key", "passphrase"] as const) {
  test(`export one person with a ${kind}, save to a real folder, read it back as a new person`, async () => {
    const prepared = await session.call<{
      exportId: string;
      generatedKey: string | null;
      summary: { documents: number };
    }>("vault_profile_export_prepare", {
      request:
        kind === "generated key"
          ? { profileId: personId, includeHistory: true }
          : {
              profileId: personId,
              includeHistory: true,
              passphrase: FILE_PASSPHRASE,
            },
    });
    expect(prepared.summary.documents).toBe(3);
    expect(prepared.generatedKey === null).toBe(kind === "passphrase");
    const file = join(
      work,
      `FAKE-handover-${kind.replace(" ", "-")}.mycarlosprofile`,
    );
    const picked = await session.withDialog<string | null>(
      "vault_profile_export_pick",
      { request: { exportId: prepared.exportId } },
      "FILE_SAVE",
      "file",
      file,
    );
    expect("ok" in picked, JSON.stringify(picked)).toBe(true);
    await session.call("vault_profile_export_picked", {
      request: { pickId: (picked as { ok: string }).ok },
    });
    const bytes = await readFile(file);
    expect(bytes.length).toBeGreaterThan(1000);
    // The file never carries what unlocks it, nor a name or a date in clear.
    for (const secret of [
      PASSPHRASE,
      FILE_PASSPHRASE,
      prepared.generatedKey ?? "",
      "FAKE Playtest",
      BIRTH_DATE,
    ])
      if (secret) expect(bytes.includes(Buffer.from(secret))).toBe(false);

    // Read it back: the same person is "already here", and a copy is made only when asked.
    const open = await session.withDialog<string | null>(
      "vault_profile_import_pick",
      undefined,
      "FILE_OPEN",
      "file",
      file,
    );
    const pickId = (open as { ok: string }).ok;
    expect(
      await session.call("vault_profile_import_key_kind", {
        request: { pickId },
      }),
    ).toBe(kind === "generated key" ? "key" : "passphrase");
    const credential =
      kind === "generated key"
        ? { key: prepared.generatedKey! }
        : { passphrase: FILE_PASSPHRASE };
    const already = await session.call<{ status: string }>(
      "vault_profile_import",
      {
        request: { pickId, ...credential },
      },
    );
    expect(already.status).toBe("alreadyHere");
    const before = (await snapshot(session)).profiles.length;
    const copy = await session.call<{
      status: string;
      documents: number;
      profileId: string;
    }>("vault_profile_import", {
      request: {
        pickId,
        ...credential,
        displayName: `FAKE Copy from ${kind}`,
        allowDuplicate: true,
      },
    });
    expect(copy.status).toBe("imported");
    expect(copy.documents).toBe(3);
    const after = await snapshot(session);
    expect(after.profiles).toHaveLength(before + 1);
    expect(
      after.records.filter((r) => r.profileId === copy.profileId),
    ).toHaveLength(3);
  });
}

test("a short or reused passphrase for the file is refused, the key is never accepted as one", async () => {
  for (const passphrase of ["short one", PASSPHRASE]) {
    const answer = await session
      .call("vault_profile_export_prepare", {
        request: { profileId: personId, includeHistory: false, passphrase },
      })
      .then(
        () => "accepted",
        () => "refused",
      );
    expect(answer, `passphrase of ${passphrase.length} characters`).toBe(
      "refused",
    );
  }
});

test("a pasted tab in the file's passphrase says what to remove, not 'something you typed'", async () => {
  const failure = await session
    .call("vault_profile_export_prepare", {
      request: {
        profileId: personId,
        includeHistory: false,
        passphrase: "marble heron\tcobalt thicket 5518 river",
      },
    })
    .then(
      () => undefined,
      (error) => error as { code?: string; messageKey?: string },
    );
  expect(failure, "a tab inside a passphrase must be refused").toBeDefined();
  expect(failure).toMatchObject({ code: "passphrase_control_character" });
  expect(JSON.stringify(failure)).not.toContain("native.error.19");
});

test("saving an export inside the vault's own folder is refused, and says why", async () => {
  const prepared = await session.call<{ exportId: string }>(
    "vault_profile_export_prepare",
    {
      request: { profileId: personId, includeHistory: false },
    },
  );
  // The dialog opens in Documents now (this PR), so the journey TYPES the vault folder's path.
  const inside = join(
    process.env.LOCALAPPDATA ?? "",
    "ca.carlos.mycarlos",
    "vault-home",
    "inside-the-vault.mycarlosprofile",
  );
  const picked = await session.withDialog<string | null>(
    "vault_profile_export_pick",
    { request: { exportId: prepared.exportId } },
    "FILE_SAVE",
    "file",
    inside,
  );
  let failure: unknown = "error" in picked ? picked.error : undefined;
  if (failure === undefined && "ok" in picked && picked.ok)
    failure = await session
      .call("vault_profile_export_picked", {
        request: { pickId: (picked as { ok: string }).ok },
      })
      .then(
        () => undefined,
        (error) => error,
      );
  expect(failure, "saving into the vault folder must be refused").toBeDefined();
  // native.error.51 ("That folder belongs to myCarlos…"), never native.error.19.
  expect(failure).toMatchObject({ code: "save_location_inside_vault" });
  expect(JSON.stringify(failure)).not.toMatch(
    /native.error.19|Something you typed/,
  );
  await expect(stat(inside)).rejects.toThrow();
});

test("lock, a wrong passphrase, then unlock: the documents are all still there", async () => {
  const before = (await snapshot(session)).records.length;
  await session.call("vault_lock");
  expect(await session.call("vault_status")).toBe("locked");
  await expect(
    session.call("vault_unlock", {
      request: { passphrase: "not the passphrase 123" },
    }),
  ).rejects.toBeDefined();
  expect(await session.call("vault_status")).toBe("locked");
  await session.call("vault_unlock", { request: { passphrase: PASSPHRASE } });
  expect((await snapshot(session)).records).toHaveLength(before);
});

test("backup to a real folder and restore it: the contents come back", async () => {
  const backup = join(work, "FAKE-playtest.mycarlosbackup");
  const picked = await session.withDialog<string | null>(
    "vault_backup_pick",
    { request: {} },
    "FILE_SAVE",
    "file",
    backup,
  );
  const saved = await session.call<{ name: string; bytes: number }>(
    "vault_backup_picked",
    {
      request: { pickId: (picked as { ok: string }).ok },
    },
  );
  expect(saved.bytes).toBeGreaterThan(1000);
  const documents = (await snapshot(session)).records.length;
  await session.call("vault_create_profile", {
    request: {
      displayName: "FAKE Added after backup",
      details: {},
      today: "2026-11-27",
    },
  });
  await session.call("vault_lock");
  const open = await session.withDialog<string | null>(
    "vault_restore_pick",
    { locale: "en" },
    "FILE_OPEN",
    "file",
    backup,
  );
  const pickId = (open as { ok: string }).ok;
  const credential = { passphrase: PASSPHRASE };
  await session.call("vault_restore_inspect", {
    request: { pickId, ...credential },
  });
  const restored = await session.withDialog<boolean>(
    "vault_restore",
    { locale: "en", request: { pickId, ...credential, replace: true } },
    "Replace the vault on this device?",
    "button",
    "Replace with backup",
  );
  expect(restored).toEqual({ ok: true });
  await session.call("vault_unlock", { request: { passphrase: PASSPHRASE } });
  const back = await snapshot(session);
  expect(back.records).toHaveLength(documents);
  expect(
    back.profiles.some((p) => p.displayName === "FAKE Added after backup"),
  ).toBe(false);
});

test.describe("a camera and a microphone", () => {
  // Needs a fake device in WebView2: MYCARLOS_WINDOWS_FAKE_MEDIA=1 adds Chromium's
  // --use-fake-device-for-media-stream. On the elevated CI host the same flags must be in the
  // HKLM AdditionalBrowserArguments policy (see the PR's workflow diff). This proves the plumbing
  // (the app's page can open a device); the camera and recording dialogs themselves, and the
  // "Test microphone" meter, are native windows a headless runner cannot see: manual-gated
  // (step 6 of the playtest checklist).
  test.skip(
    process.env.MYCARLOS_WINDOWS_FAKE_MEDIA !== "1",
    "Set MYCARLOS_WINDOWS_FAKE_MEDIA=1 (and the policy flags on an elevated host)",
  );
  test("the page can open a fake camera and microphone and lists them", async () => {
    const result = await session.page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      const tracks = stream.getTracks().map((track) => track.kind);
      stream.getTracks().forEach((track) => track.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      return { tracks, kinds: devices.map((device) => device.kind) };
    });
    expect(result.tracks.sort()).toEqual(["audio", "video"]);
    expect(result.kinds).toContain("videoinput");
    expect(result.kinds).toContain("audioinput");
  });
});

test.describe("not yet runnable: waiting for the features", () => {
  test.fixme(
    true,
    "A second vault from the lock screen: needs #562 (Set up a new vault on the lock screen) to be merged",
  );
  test("a second vault from the lock screen", () => {});
  test.fixme(
    true,
    "A file shared while locked is sealed, and offered by name after unlock: needs #420 (the sealed inbox) to be wired",
  );
  test("a file shared while locked", () => {});
});
