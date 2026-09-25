/**
 * Tracks the operations under way and whether one of them ran a transfer, so
 * that an automatic or background lock can wait for the transfer's operation
 * to finish and report its outcome. Read synchronously from callbacks, so it is
 * a plain object rather than React state. Every transfer runs inside an
 * operation, which only ends once its transfer has settled.
 */
export class TransferHold {
  private operations = 0;
  private transferRan = false;

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
}
