/** taskkill's exit code when a process it was asked to end is already gone:
 * "There is no running instance of the task." */
export const TASKKILL_NOT_RUNNING = 128;

/** Ends the installed app and its WebView2 children with `taskkill /T /F`.
 * A child can end by itself while the tree is being killed, and taskkill then
 * fails with exit code 128 for it. That is a finished shutdown only if the
 * app itself has exited too, which `waitForExit` answers (false after its own
 * time limit). Any other failure, or 128 while the app still runs, is
 * thrown. */
export async function stopAppTree(
  pid: number,
  run: (file: string, args: string[]) => Promise<unknown>,
  waitForExit: () => Promise<boolean>,
): Promise<void> {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } catch (error) {
    if (exitCodeOf(error) === TASKKILL_NOT_RUNNING && (await waitForExit()))
      return;
    throw error;
  }
}

/** Node's `execFile` rejects with the exit code as `code`. */
function exitCodeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}
