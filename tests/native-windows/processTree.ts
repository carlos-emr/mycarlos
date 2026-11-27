/** taskkill's exit code when a process it was asked to end is already gone:
 * "There is no running instance of the task." */
export const TASKKILL_NOT_RUNNING = 128;

/** What `stopAppTree` may be told besides how to run taskkill and wait for the app's exit. */
export interface StopOptions {
  /** Whether the app's own process no longer exists (`process.kill(pid, 0)` throwing ESRCH, or
   * tasklist). The 'exit' event can be missed or late; the process table is the second witness. */
  rootGone?: () => Promise<boolean>;
  /** How the app looks now (its exit code and signal), for the message of a failed shutdown. */
  describeApp?: () => string;
  /** How long to watch for the root process to go, and how often to look. */
  waitMs?: number;
  pollMs?: number;
}

/** Ends the installed app and its WebView2 children with `taskkill /T /F`.
 * A child can end by itself while the tree is being killed, and taskkill then
 * fails with exit code 128 for it. A child that is already on its way out can
 * also be refused with "ERROR: The process with PID n (child process of PID m)
 * could not be terminated. Reason: The operation attempted is not supported."
 * (Windows run 45962064313): the same race, reported per child. Either is a
 * finished shutdown only if the app itself has gone: either `waitForExit`
 * answers true (false after its own time limit) or, as a second witness, the
 * root process is no longer in the process table within `waitMs` (15 s). If
 * neither shows it, the error says what taskkill reported and how the app
 * looks. Any other failure is thrown as it came, including a "not supported"
 * refusal for the app's own process (it is not a child that was leaving) and
 * one mixed with any other kind of refusal. */
export async function stopAppTree(
  pid: number,
  run: (file: string, args: string[]) => Promise<unknown>,
  waitForExit: () => Promise<boolean>,
  options: StopOptions = {},
): Promise<void> {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch (error) {
    const report =
      exitCodeOf(error) === TASKKILL_NOT_RUNNING
        ? `taskkill exit code ${TASKKILL_NOT_RUNNING}`
        : onlyChildrenLeavingRefused(error)
          ? "taskkill refused only children that were leaving (not supported)"
          : null;
    if (report === null) throw error;
    const watch = { stopped: false };
    const witnesses = [waitForExit()];
    if (options.rootGone)
      witnesses.push(
        pollUntil(
          options.rootGone,
          options.waitMs ?? 15_000,
          options.pollMs ?? 250,
          watch,
        ),
      );
    const gone = await anyTrue(witnesses);
    watch.stopped = true;
    if (gone) return;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} (${report}; the app, PID ${pid}, was not seen to exit: ${
        options.describeApp?.() ?? "its state is unknown"
      })`,
      { cause: error },
    );
  }
}

/** True once any of the checks is true; false only when all are false (or fail). */
function anyTrue(checks: Promise<boolean>[]): Promise<boolean> {
  return new Promise((resolve) => {
    let pending = checks.length;
    const settle = (value: boolean) => {
      if (value) resolve(true);
      else if (--pending === 0) resolve(false);
    };
    for (const check of checks) check.then(settle, () => settle(false));
  });
}

/** Asks `check` every `everyMs` until it says true, `limitMs` pass, or `watch` is stopped. */
async function pollUntil(
  check: () => Promise<boolean>,
  limitMs: number,
  everyMs: number,
  watch: { stopped: boolean },
): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (!watch.stopped) {
    if (await check().catch(() => false)) return true;
    if (Date.now() >= end) break;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return false;
}

/** True when everything taskkill complained about is a CHILD it could not end because "The
 * operation attempted is not supported" (the child was already exiting): at least one such
 * refusal, and no other "ERROR:" line (the app's own process, another reason). */
function onlyChildrenLeavingRefused(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  // One source, so a line is not counted twice: taskkill writes its errors to stderr, which
  // `execFile` also copies into the message; use stderr when it has text, else the message.
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  const text =
    stderr.trim() !== ""
      ? stderr
      : "message" in error
        ? String(error.message)
        : "";
  const errors = text.match(/ERROR:/g)?.length ?? 0;
  const childRefusals = [
    ...text.matchAll(
      /ERROR: The process with PID \d+ \(child process of PID \d+\) could not be terminated\.\s*Reason: The operation attempted is not supported\./g,
    ),
  ].length;
  return childRefusals > 0 && childRefusals === errors;
}

/** Node's `execFile` rejects with the exit code as `code`. */
function exitCodeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}
