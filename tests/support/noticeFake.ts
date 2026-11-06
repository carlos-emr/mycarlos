import type { Page } from "@playwright/test";

// The Windows document-arrival notices (Settings > Preferences > Notices
// after document checks), faked over the vault fake (support/vaultFake.ts,
// which says they are unsupported): what vault_notification_status says, and
// what the two switches do. Native owns the consent and the OS permission;
// this fake only answers as the commands do. FAKE data only.

export interface FakeNoticeStatus {
  supported: boolean;
  available: boolean;
  enabled: boolean;
  permission: "unavailable" | "unknown" | "allowed" | "blocked";
  automaticChecksSupported: boolean;
  automaticChecksEnabled: boolean;
  automaticChecksPaused: boolean;
}

export const NOTICE_COMMANDS = {
  status: "vault_notification_status",
  setNotices: "vault_set_notifications",
  setChecks: "vault_set_automatic_document_checks",
} as const;

/** Installs the fake over the vault fake already on `page`. */
export async function fakeNoticesWith(
  page: Page,
  status: Partial<FakeNoticeStatus> = {},
) {
  await page.addInitScript(
    ({ start, commands }) => {
      const internals = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (command: string, ...rest: unknown[]) => Promise<unknown>;
      };
      if (!internals)
        throw new Error("fakeNoticesWith needs fakeVaultWith first");
      const inner = internals.invoke.bind(internals);
      let status = structuredClone(start);
      const calls: { command: string; args: unknown }[] = [];
      let failNext = false;
      internals.invoke = async (command: string, ...rest: unknown[]) => {
        const ours = Object.values(commands) as string[];
        if (!ours.includes(command)) return inner(command, ...rest);
        const args = (rest[0] ?? {}) as { enabled?: boolean; locale?: string };
        calls.push({ command, args: structuredClone(args) });
        if (command === commands.status) return structuredClone(status);
        if (failNext) {
          failNext = false;
          // As native does on a failed save: the switches are off.
          status = {
            ...status,
            enabled: false,
            automaticChecksEnabled: false,
          };
          throw {
            code: "storage",
            message: "FAKE: the notice settings could not be saved",
            messageKey: "native.error.35",
          };
        }
        if (command === commands.setNotices) {
          status = {
            ...status,
            enabled: args.enabled === true,
            // Turning notices off turns the automatic checks off too.
            automaticChecksEnabled:
              args.enabled === true ? status.automaticChecksEnabled : false,
          };
        } else {
          status = { ...status, automaticChecksEnabled: args.enabled === true };
        }
        return structuredClone(status);
      };
      Reflect.set(window, "__fakeNotices", {
        calls: () => structuredClone(calls),
        failNext: () => {
          failNext = true;
        },
      });
    },
    {
      start: {
        supported: true,
        available: true,
        enabled: false,
        permission: "allowed",
        automaticChecksSupported: true,
        automaticChecksEnabled: false,
        automaticChecksPaused: false,
        ...status,
      } satisfies FakeNoticeStatus,
      commands: NOTICE_COMMANDS,
    },
  );
}

/** The notice commands called, with their arguments, in order. */
export async function noticeCalls(page: Page) {
  return page.evaluate(() =>
    (
      Reflect.get(window, "__fakeNotices") as {
        calls: () => { command: string; args: Record<string, unknown> }[];
      }
    ).calls(),
  );
}

/** The next switch fails to save, as a storage failure would. */
export async function failNextNoticeSave(page: Page) {
  await page.evaluate(() =>
    (
      Reflect.get(window, "__fakeNotices") as { failNext: () => void }
    ).failNext(),
  );
}
