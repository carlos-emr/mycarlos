/**
 * Tracks the operations under way and whether one of them ran a transfer, so
 * that an automatic or background lock can wait for the transfer's operation
 * to finish and report its outcome. Read synchronously from callbacks, so it is
 * a plain object rather than React state. Every transfer runs inside an
 * operation, which only ends once its transfer has settled.
 */
export class TransferHold {
  // Operations under way, by the session they started in. A lock ends the session: what the one
  // before left under way (a picker whose answer never came) must not make the next session look
  // busy, so only the session now shown counts as running.
  private operations = new Map<number, number>();
  private session = 0;
  private transferRan = false;

  operationStarted(session = this.session) {
    this.operations.set(session, (this.operations.get(session) ?? 0) + 1);
  }

  /** Returns true when no operation is under way any more, in the session it belonged to and in
   * the session now shown. One a lock left behind that never ends (a picker nobody answered)
   * therefore frees nothing, and never holds the next session's end back. */
  operationEnded(session = this.session): boolean {
    const left = (this.operations.get(session) ?? 1) - 1;
    if (left > 0) this.operations.set(session, left);
    else this.operations.delete(session);
    if (left > 0 || this.running) return false;
    this.transferRan = false;
    return true;
  }

  /** The vault locked and a new session is shown: only its own operations count as running. A
   * transfer that ran before stays known until its operation ends, so that its late failure is
   * still held for the next unlock. */
  moveTo(session: number) {
    this.session = session;
  }

  transferStarted() {
    this.transferRan = true;
  }

  /**
   * Whether an operation that ran a transfer is still under way. An automatic
   * lock waits for it however long it takes: a slow connection must not cut
   * off a large transfer. The native deadline still locks one that stalls.
   */
  get active(): boolean {
    return this.transferRan;
  }

  /** Whether any operation of this session is under way, picker included: its own result
   * is written first. */
  get running(): boolean {
    return (this.operations.get(this.session) ?? 0) > 0;
  }
}
