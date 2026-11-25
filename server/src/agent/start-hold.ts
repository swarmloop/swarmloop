/**
 * What a launch knows of its start while the start waits before its first output, for the server's pause or for a free
 * agent place. Each change of the wait is told to `onStartWait`, and every call is awaited before the launch goes on.
 */
export class StartHold {
  private held = false;
  private readonly told: Promise<void>[] = [];

  constructor(private readonly onStartWait?: () => Promise<void>) {}

  /** True once the start waited for the pause or for a place. */
  get wasHeld(): boolean {
    return this.held;
  }

  /** The start waits now. */
  waits(): void {
    this.held = true;
    this.tell();
  }

  /** The spawn is over, started or thrown: what the start waits for is now nothing. Resolves when every call is done. */
  async spawned(): Promise<void> {
    this.tell();
    await Promise.all(this.told);
  }

  private tell(): void {
    if (this.onStartWait) {
      this.told.push(this.onStartWait());
    }
  }
}
