// A synthetic FAKE vault in the INSTALLED app, for native-windows journeys (kept apart from
// dialogs.ts, which only walks the confirmation dialogs). Usage:
//
//   const session = await openInstalledApp(playwright, testInfo);   // appSession.ts
//   const vault = await createFakeVault(session);                    // absent -> unlocked, one person
//   ... vault.passphrase, createPerson(session, ...), importSample(session, personId, "FAKE_...pdf") ...
//   // in afterAll, ONLY if createFakeVault returned (a `made` flag): it proves the vault is the
//   // helper's before erasing (see safety.ts), and refuses otherwise.
//   await eraseFakeVault(session, vault.firstPersonName);
//   await session.stop();
//
// Everything is FAKE. The account must have no vault (vault_status "absent"): the helper refuses
// otherwise, so a real vault is never touched.
import { expect } from "@playwright/test";
import { join, resolve } from "node:path";
import type { AppSession } from "./appSession";
import { provesFakeVault } from "./safety";

/** The FAKE first person `createFakeVault` makes unless told another name. */
export const DEFAULT_FIRST_PERSON = "FAKE Playtest Start";

/** The folder of FAKE samples (the PDFs, pictures and the clip). */
export const SAMPLES = resolve(
  process.env.MYCARLOS_PLAYTEST_SAMPLES ?? "dev-data",
);
/** The throw-away passphrase every playtest vault uses. */
export const FAKE_PASSPHRASE = "quartz otter lantern cactus velvet 729!";
/** The title of the native confirmation that sets a vault aside, and its button. */
export const SET_ASIDE_TITLE = "Set this myCarlos vault aside and start again?";
export const SET_ASIDE_BUTTON = "Set it aside";

export interface Profile {
  id: string;
  displayName: string;
}
export interface Snapshot {
  profiles: Profile[];
  records: { profileId: string; displayName: string }[];
}
export interface FakeVault {
  passphrase: string;
  /** The first person, made with the vault. */
  firstPersonName: string;
}

/** The library as the page sees it now. */
export const snapshot = (session: AppSession) =>
  session.call<Snapshot>("vault_snapshot");

/** Makes a vault in an empty account: passphrase, the first person, left UNLOCKED. */
export async function createFakeVault(
  session: AppSession,
  firstPersonName = DEFAULT_FIRST_PERSON,
): Promise<FakeVault> {
  expect(
    await session.call("vault_status"),
    "Requires an empty test account",
  ).toBe("absent");
  await session.call("vault_create", {
    request: {
      passphrase: FAKE_PASSPHRASE,
      initialProfileName: firstPersonName,
    },
  });
  expect(await session.call("vault_status")).toBe("unlocked");
  return { passphrase: FAKE_PASSPHRASE, firstPersonName };
}

/** Locks, then unlocks with the vault's passphrase. */
export async function relock(session: AppSession, vault: FakeVault) {
  await session.call("vault_lock");
  expect(await session.call("vault_status")).toBe("locked");
  await session.call("vault_unlock", {
    request: { passphrase: vault.passphrase },
  });
}

/** Makes a person (with a birth date when given) and returns the id. */
export function createPerson(
  session: AppSession,
  displayName: string,
  birthDate?: string,
): Promise<string> {
  return session.call<string>("vault_create_profile", {
    request: {
      displayName,
      details: birthDate ? { fullName: displayName, birthDate } : {},
      today: new Date().toISOString().slice(0, 10),
    },
  });
}

/** Adds one FAKE sample to a person through the real Open dialog and the real import. */
export async function importSample(
  session: AppSession,
  personId: string,
  name: string,
) {
  const picked = await session.withDialog<{
    kind: string;
    pickId: string;
  } | null>(
    "vault_import_any_pick",
    { locale: "en", request: { profileId: personId, folderIds: [] } },
    "FILE_OPEN",
    "file",
    join(SAMPLES, name),
  );
  expect("ok" in picked, JSON.stringify(picked)).toBe(true);
  const pick = (picked as { ok: { kind: string; pickId: string } | null }).ok;
  expect(pick, `${name}: the picker returned nothing`).not.toBeNull();
  await session.call("vault_import_picked", {
    request: { pickId: pick!.pickId, profileId: personId, folderIds: [] },
  });
}

/**
 * Leaves the account empty again (the native "set it aside" confirmation). Safe to call twice.
 *
 * It erases ONLY a vault it can prove is this run's own (`provesFakeVault`): a locked vault must
 * open with FAKE_PASSPHRASE (no real vault does), and the library must hold the FAKE first person.
 * Anything else throws and erases nothing. Call it only after `createFakeVault` returned.
 */
export async function eraseFakeVault(
  session: AppSession,
  firstPersonName = DEFAULT_FIRST_PERSON,
) {
  const status = await session.call<string>("vault_status");
  if (status === "absent") return;
  let opened = status === "unlocked";
  if (status === "locked") {
    opened = await session
      .call("vault_unlock", { request: { passphrase: FAKE_PASSPHRASE } })
      .then(
        () => true,
        () => false,
      );
  }
  const personNames = opened
    ? (await snapshot(session)).profiles.map((p) => p.displayName)
    : [];
  if (
    !provesFakeVault({
      openedWithFakePassphrase: opened,
      personNames,
      firstPersonName,
    })
  )
    throw new Error(
      "Refusing to erase: the vault in this account is not the one this run created " +
        "(it did not open with the FAKE passphrase, or lacks the FAKE first person). " +
        "Nothing was erased.",
    );
  await session.call("vault_lock").catch(() => {});
  await session.withDialog(
    "vault_reset",
    { request: { confirmation: "RESET MYCARLOS VAULT" } },
    SET_ASIDE_TITLE,
    "button",
    SET_ASIDE_BUTTON,
  );
}
