import { type Page } from "@playwright/test";
import { translate } from "./fluent";
import { FAKE_PAGE_COUNT, fakePageText, fakeUuid } from "./vaultFake";

// The AI helper's native side (#72), faked over vaultFake.ts for specs that
// follow the helper's whole path: a document's text for the preview and the
// reader, what the vault knows about its patient, the text export, and the
// model on this computer. Install it after fakeVaultWith: it wraps that
// fake's `invoke`, answers the commands below itself and passes every other
// command on, so the vault fake (and expectOnlyFakedCommands) see the rest.
//
// - A call can be held (holdAi): it stays pending until released
//   (releaseAi) or cancelled, as a long read or a slow model would.
// - Cancelling is native: vault_document_text_cancel settles a held text
//   read, ai_cancel a held model run, and vault_lock both, each with the
//   refusal the native side sends. A cancel that only logs a call while
//   leaving the read pending fails the specs that wait on it (aiHeld).
// - Nothing is kept across reloads: a reload ends what was held, as a reload
//   of the window ends the native work it was waiting for.
// FAKE data only.

/** The AI helper's native commands, in one place. The model's work commands
 * are the names agreed for the runtime (root-aa, 5 Nov 2026); the wiring
 * step switches the app to them. */
export const AI_COMMANDS = {
  modelStatus: "ai_model_status",
  summarize: "ai_summarize",
  explain: "ai_explain",
  cancel: "ai_cancel",
  // Adding and removing the model (root-4a's side of the agreement).
  catalog: "ai_model_catalog",
  addPicked: "ai_model_add_picked",
  download: "ai_model_download",
  addCancel: "ai_model_add_cancel",
  remove: "ai_model_remove",
  documentText: "vault_document_text",
  cancelText: "vault_document_text_cancel",
  knownDetails: "vault_record_known_details",
  exportPick: "vault_export_text_pick",
  exportPicked: "vault_export_text_picked",
} as const;

type AiCommand = (typeof AI_COMMANDS)[keyof typeof AI_COMMANDS];

/** The model the fake has, when one is installed. */
export const FAKE_MODEL = { name: "FAKE test model", sha256: "test-only" };

export type FakeModelStatus =
  | { state: "notInstalled" }
  | { state: "installed"; model: { name: string; sha256: string } }
  | { state: "unsupported"; reason: "ram" | "cpu" | "platform" }
  | { state: "damaged" };

/** The refusals the model's commands make (PublicError codes). */
export type FakeAiRefusal =
  /** ai_model_remove's own refusals. */
  | "busy"
  | "storage"
  | "aiNotInstalled"
  | "aiDamaged"
  | "aiMemory"
  | "aiBusy"
  | "aiCancelled"
  | "aiFailed";

export interface FakeAiSetup {
  /** What ai_model_status says. Default: not installed. */
  model?: FakeModelStatus;
  /** A document's pages, by its name. Others read as vaultFake's page text. */
  documents?: Record<string, string[]>;
  /** How the PDF helper read a document, by its name: pages it cut at its
   * limit, pages it could not read (left out of `pages`), and a text cut by
   * the reader's caps. Default: every page read in full. */
  readAs?: Record<string, FakeTextRead>;
  /** What vault_record_known_details says about every document's patient. */
  knownDetails?: {
    names?: string[];
    birthDates?: string[];
    doctorNames?: string[];
    clinicNames?: string[];
  };
  /** What the model says it explains a term as. */
  explanation?: string;
}

/** How the PDF helper read a document's text (see `FakeAiSetup.readAs`). */
export interface FakeTextRead {
  cutPages?: number[];
  failedPages?: number[];
  truncated?: boolean;
}

/** Installs the fake over the vault fake already on `page`. */
export async function fakeAiWith(page: Page, setup: FakeAiSetup = {}) {
  const defaultPages = (name: string) =>
    Array.from({ length: FAKE_PAGE_COUNT }, (_, page) =>
      fakePageText(name, page + 1),
    );
  await page.addInitScript(
    (setup) => {
      type Args = { request?: Record<string, unknown> } & Record<
        string,
        unknown
      >;
      type Held = {
        command: string;
        /** A text read's screen (request.readId): its cancel ends only it. */
        readId?: unknown;
        /** Ends the wait: with `answer`, that is the call's answer. */
        resolve: (ended?: { answer: unknown }) => void;
        reject: (reason: unknown) => void;
      };
      const internals = Reflect.get(window, "__TAURI_INTERNALS__") as {
        invoke: (command: string, ...rest: unknown[]) => Promise<unknown>;
      };
      if (!internals) throw new Error("fakeAiWith needs fakeVaultWith first");
      const vault = Reflect.get(window, "__fakeVault") as {
        snapshot: () => { records: { id: string; displayName: string }[] };
      };
      const inner = internals.invoke.bind(internals);
      const ours = new Set<string>(Object.values(setup.commands));
      // What the model is now: adding or removing it changes it.
      let model = structuredClone(setup.model);
      const refusals: Record<string, string[]> = {};
      const calls: { command: string; args: Args }[] = [];
      const cancelled: { command: string; by: string }[] = [];
      const holds = new Set<string>();
      let held: Held[] = [];
      let tickets = 0;
      const refusal = (code: string, messageKey: string) => ({
        code,
        message: setup.messages[messageKey] ?? code,
        messageKey,
      });
      const settleHeld = (
        which: (command: string) => boolean,
        by: string,
        reason: unknown,
      ) => {
        const stopped = held.filter((entry) => which(entry.command));
        held = held.filter((entry) => !which(entry.command));
        for (const entry of stopped) {
          cancelled.push({ command: entry.command, by });
          entry.reject(reason);
        }
      };
      // An add or a download stopped with ai_model_add_cancel answers, as
      // the native side does: { outcome: "cancelled" }, not an error.
      const endHeld = (
        which: (command: string) => boolean,
        by: string,
        answer: unknown,
      ) => {
        const stopped = held.filter((entry) => which(entry.command));
        held = held.filter((entry) => !which(entry.command));
        for (const entry of stopped) {
          cancelled.push({ command: entry.command, by });
          entry.resolve({ answer: structuredClone(answer) });
        }
      };
      // Tauri's events (@tauri-apps/api/event): a listener is a callback
      // the page hands over, and the native side calls it with each event.
      const callbacks = new Map<number, (event: unknown) => void>();
      let nextCallback = 1;
      Reflect.set(
        internals,
        "transformCallback",
        (callback: (event: unknown) => void) => {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
      );
      let listeners: { event: string; eventId: number; handler: number }[] = [];
      let nextEventId = 1;
      const unlisten = (event: unknown, eventId: unknown) => {
        listeners = listeners.filter(
          (each) => !(each.event === event && each.eventId === eventId),
        );
      };
      Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
        unregisterListener: unlisten,
      });
      const emit = (event: string, payload: unknown) => {
        for (const each of listeners)
          if (each.event === event)
            callbacks.get(each.handler)?.({
              event,
              id: each.eventId,
              payload: structuredClone(payload),
            });
      };
      const answers: Record<string, unknown[]> = {};
      const installed = () =>
        (model = {
          state: "installed",
          model: {
            name: setup.catalogEntry.name,
            sha256: setup.catalogEntry.sha256,
          },
        });
      const nameOf = (recordId: unknown) =>
        vault.snapshot().records.find((record) => record.id === recordId)
          ?.displayName ?? "";
      const pagesOf = (recordId: unknown) => {
        const name = nameOf(recordId);
        return setup.documents[name] ?? setup.defaultPages[name] ?? [];
      };
      const documentText = (recordId: unknown) => {
        const texts = pagesOf(recordId);
        const read: FakeTextRead = setup.readAs[nameOf(recordId)] ?? {};
        const failed = read.failedPages ?? [];
        const pages = texts
          .map((text, index) => ({ index, text }))
          .filter((page) => !failed.includes(page.index));
        const pageStarts: number[] = [];
        let joined = "";
        pages.forEach((page, position) => {
          if (position > 0) joined += "\n\n";
          pageStarts.push(joined.length);
          joined += page.text;
        });
        tickets += 1;
        return {
          pageCount: texts.length,
          pages,
          joined,
          pageStarts,
          emptyPages: pages.flatMap((page) =>
            page.text.trim() ? [] : [page.index],
          ),
          cutPages: read.cutPages ?? [],
          failedPages: failed,
          truncated: read.truncated ?? false,
          ticket: `FAKE-ticket-${tickets}`,
        };
      };
      const answer = (command: string, args: Args): unknown => {
        const request = args.request ?? {};
        const c = setup.commands;
        switch (command) {
          case c.modelStatus:
            return structuredClone(model);
          case c.catalog:
            return [structuredClone(setup.catalogEntry)];
          case c.addPicked:
          case c.download:
            return { outcome: "added", status: structuredClone(installed()) };
          case c.addCancel:
            return null;
          case c.remove:
            model = { state: "notInstalled" };
            return structuredClone(model);
          case c.documentText:
            return documentText(request.recordId);
          case c.knownDetails:
            return {
              names: [],
              birthDates: [],
              doctorNames: [],
              clinicNames: [],
              ...structuredClone(setup.knownDetails),
            };
          case c.exportPick:
            return setup.pickId;
          case c.exportPicked:
            return { saved: true, hits: [] };
          case c.summarize: {
            if (model.state !== "installed")
              throw refusal("aiNotInstalled", "ai.failed");
            const pages = (request.pages ?? []) as {
              index: number;
              text: string;
            }[];
            // One sentence per page with text, quoting its first line.
            const sentences = pages
              .filter((page) => page.text.trim())
              .map((page) => {
                const line = page.text.trim().split("\n")[0].trim();
                return {
                  text: `FAKE: page ${page.index + 1} begins “${line}”.`,
                  quote: line,
                };
              });
            return {
              sentences,
              model: structuredClone(model.model),
              lastPage: pages.at(-1)?.index ?? 0,
              lastPageCut: false,
            };
          }
          case c.explain:
            if (model.state !== "installed")
              throw refusal("aiNotInstalled", "ai.failed");
            return {
              text: setup.explanation ?? `FAKE explanation of ${request.term}.`,
              model: structuredClone(model.model),
            };
        }
        throw new Error(`aiFake has no answer for ${command}`);
      };

      Reflect.set(window, "__fakeAi", {
        calls: () => structuredClone(calls),
        cancelled: () => structuredClone(cancelled),
        held: () => held.map((entry) => entry.command),
        hold: (command: string) => holds.add(command),
        refuse: (command: string, code: string) =>
          (refusals[command] ??= []).push(code),
        answer: (command: string, value: unknown) =>
          (answers[command] ??= []).push(value),
        listening: (event: string) =>
          listeners.filter((each) => each.event === event).length,
        release: (command: string) => {
          const entry = held.find((each) => each.command === command);
          if (!entry) throw new Error(`Nothing held for ${command}`);
          held = held.filter((each) => each !== entry);
          entry.resolve();
        },
      });
      internals.invoke = async (command: string, ...rest: unknown[]) => {
        const c = setup.commands;
        // The lock stops a text being read and the model with its answer
        // (vault_lock in src-tauri/src/lib.rs), then locks the vault.
        if (command === "vault_lock")
          settleHeld(
            (held) => held === c.documentText,
            command,
            refusal("cancelled", "native.error.36"),
          );
        if (command === "vault_lock")
          settleHeld(
            (held) => held === c.summarize || held === c.explain,
            command,
            refusal("aiCancelled", "ai.failed"),
          );
        if (command === "plugin:event|listen") {
          const { event, handler } = (rest[0] ?? {}) as {
            event: string;
            handler: number;
          };
          listeners.push({ event, eventId: nextEventId, handler });
          return nextEventId++;
        }
        if (command === "plugin:event|unlisten") {
          const { event, eventId } = (rest[0] ?? {}) as Record<string, unknown>;
          unlisten(event, eventId);
          return null;
        }
        if (!ours.has(command)) return inner(command, ...rest);
        const args = ((rest[0] as Args | undefined) ?? {}) as Args;
        calls.push({ command, args: structuredClone(args) });
        if (command === c.addCancel) {
          endHeld(
            (held) => held === c.addPicked || held === c.download,
            command,
            { outcome: "cancelled" },
          );
          return null;
        }
        // The file is checked (added) or fetched (downloaded) in steps: the
        // start and half way, then, once the call is let go, the end.
        const copying = command === c.addPicked || command === c.download;
        const total = setup.catalogEntry.sizeBytes;
        if (copying) {
          emit(setup.progressEvent, { done: 0, total });
          emit(setup.progressEvent, { done: Math.floor(total / 2), total });
        }
        if (command === c.cancelText) {
          // The screen's own read only, as the native side does.
          const readId = args.request?.readId;
          const mine = held.filter(
            (entry) =>
              entry.command === c.documentText && entry.readId === readId,
          );
          held = held.filter((entry) => !mine.includes(entry));
          for (const entry of mine) {
            cancelled.push({ command: entry.command, by: command });
            entry.reject(refusal("cancelled", "native.error.36"));
          }
          return null;
        }
        if (command === c.cancel) {
          settleHeld(
            (held) => held === c.summarize || held === c.explain,
            command,
            refusal("aiCancelled", "ai.failed"),
          );
          return null;
        }
        if (holds.delete(command)) {
          const ended = await new Promise<{ answer: unknown } | undefined>(
            (resolve, reject) =>
              held.push({
                command,
                readId: args.request?.readId,
                resolve,
                reject,
              }),
          );
          if (ended) return ended.answer;
        }
        const scripted = answers[command]?.shift();
        if (scripted !== undefined) return scripted;
        if (copying) emit(setup.progressEvent, { done: total, total });
        const refused = refusals[command]?.shift();
        if (refused) {
          // A failed check at load: the status says so from then on.
          if (refused === "aiDamaged") model = { state: "damaged" };
          throw refusal(refused, "ai.failed");
        }
        return answer(command, args);
      };
    },
    {
      commands: AI_COMMANDS,
      model: setup.model ?? { state: "notInstalled" },
      documents: setup.documents ?? {},
      readAs: setup.readAs ?? {},
      defaultPages: Object.fromEntries(
        ["FAKE Bloodwork.pdf", "FAKE Letter.pdf", "FAKE Clinic letter.pdf"].map(
          (name) => [name, defaultPages(name)],
        ),
      ),
      knownDetails: setup.knownDetails ?? {},
      explanation: setup.explanation ?? null,
      pickId: fakeUuid(1100),
      progressEvent: "ai-model-add-progress",
      // As ai_model_catalog lists the one accepted model. FAKE: no file.
      catalogEntry: {
        name: FAKE_MODEL.name,
        fileName: "FAKE-test-model.gguf",
        // About the size of the accepted model; no file is ever read.
        sizeBytes: 2_500_000_000,
        sha256: FAKE_MODEL.sha256,
        licence: "FAKE licence",
        notices: [],
        sourceUrl: "https://example.invalid/FAKE-test-model.gguf",
      },
      // The refusals the fake makes, in English as the native side sends them.
      messages: {
        "native.error.36": translate("en", "native.error.36"),
        "ai.failed": translate("en", "ai.failed"),
      } as Record<string, string>,
    },
  );
}

/** The arguments of each call of an AI command, in order. */
export async function aiCalls(
  page: Page,
  command: AiCommand,
): Promise<{ request?: Record<string, unknown> }[]> {
  const calls = await page.evaluate(() =>
    (
      Reflect.get(window, "__fakeAi") as {
        calls: () => { command: string; args: unknown }[];
      }
    ).calls(),
  );
  return calls
    .filter((call) => call.command === command)
    .map((call) => call.args as { request?: Record<string, unknown> });
}

/** The next call of `command` stays pending until released or cancelled. */
export async function holdAi(page: Page, command: AiCommand) {
  await page.evaluate(
    (command) =>
      (Reflect.get(window, "__fakeAi") as { hold: (c: string) => void }).hold(
        command,
      ),
    command,
  );
}

/** Answers the oldest held call of `command`, as the native side finishing. */
export async function releaseAi(page: Page, command: AiCommand) {
  await page.evaluate(
    (command) =>
      (
        Reflect.get(window, "__fakeAi") as { release: (c: string) => void }
      ).release(command),
    command,
  );
}

/** The commands still held, in the order they were called. */
export async function aiHeld(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (Reflect.get(window, "__fakeAi") as { held: () => string[] }).held(),
  );
}

/** What was cancelled, and by which command. */
export async function aiCancelled(
  page: Page,
): Promise<{ command: string; by: string }[]> {
  return page.evaluate(() =>
    (
      Reflect.get(window, "__fakeAi") as {
        cancelled: () => { command: string; by: string }[];
      }
    ).cancelled(),
  );
}

/** The next call of `command` is refused with `code`, as the native side
 * refuses (an aiDamaged refusal also turns the status to damaged). */
export async function refuseAi(
  page: Page,
  command: AiCommand,
  code: FakeAiRefusal,
) {
  await page.evaluate(
    ({ command, code }) =>
      (
        Reflect.get(window, "__fakeAi") as {
          refuse: (command: string, code: string) => void;
        }
      ).refuse(command, code),
    { command, code },
  );
}

/** The next call of `command` answers `value` (an add or a download that
 * ends in a refusal, such as { outcome: "network" }). */
export async function answerAi(page: Page, command: AiCommand, value: unknown) {
  await page.evaluate(
    ({ command, value }) =>
      (
        Reflect.get(window, "__fakeAi") as {
          answer: (command: string, value: unknown) => void;
        }
      ).answer(command, value),
    { command, value },
  );
}

/** How many listeners the page has for a Tauri event. */
export async function aiListeners(page: Page, event: string): Promise<number> {
  return page.evaluate(
    (event) =>
      (
        Reflect.get(window, "__fakeAi") as {
          listening: (event: string) => number;
        }
      ).listening(event),
    event,
  );
}
