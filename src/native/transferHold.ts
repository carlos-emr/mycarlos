/**
 * Tracks the operations under way and whether one of them ran a transfer, so
 * that an automatic or background lock can wait for the transfer's operation
 * to finish and show its outcome. Read synchronously from callbacks, so it is
 * a plain object rather than React state. Every transfer runs inside an
 * operation, which only ends once its transfer has settled.
 */
export class TransferHold {
  private operations = 0;
  private transferRan = false;
  private transferBeganAt = 0;

  operationStarted() {
    this.operations += 1;
  }

  /** Returns true when no operation is under way any more. */
  operationEnded(): boolean {
    this.operations -= 1;
    if (this.operations > 0) return false;
    this.transferRan = false;
    return true;
  }

  transferStarted(now: number) {
    if (!this.transferRan) this.transferBeganAt = now;
    this.transferRan = true;
  }

  /** Whether an operation that ran a transfer is still under way. */
  get active(): boolean {
    return this.transferRan;
  }

  /**
   * Whether an automatic lock should wait for it at `now`. The native deadline
   * counts a transfer for at most its first 15 minutes and then the delay, and
   * locks; `maxHoldMs` keeps a hold from outlasting that.
   */
  shouldWait(now: number, maxHoldMs: number): boolean {
    return this.transferRan && now - this.transferBeganAt < maxHoldMs;
  }
}
