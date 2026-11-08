import type { Clock } from './clock';

/** How often the agent process samples its child. A gap far above this is the host sleeping. */
export const SAMPLE_MS = 5_000;

const SUSPENSION_FACTOR = 3;

/**
 * Time the host was awake. A gap between two looks that is far longer than the polling interval is a suspension:
 * it is cut out of the elapsed and idle time, so a sleeping laptop does not count against a limit.
 */
export class AwakeTime {
  private started: number;
  private lastActivity: number;
  private lastSeen: number;

  constructor(
    private readonly clock: Clock,
    private readonly intervalMs: number,
    private readonly onSuspended?: (gapMs: number) => void,
  ) {
    this.started = this.lastActivity = this.lastSeen = clock.now();
  }

  /** Looks at the clock. Returns the length of the suspension since the last look, or 0. */
  observe(): number {
    const now = this.clock.now();
    const gap = now - this.lastSeen;
    this.lastSeen = now;
    if (gap <= SUSPENSION_FACTOR * this.intervalMs) {
      return 0;
    }
    this.started += gap;
    this.lastActivity += gap;
    this.onSuspended?.(gap);
    return gap;
  }

  /** Runs an operation that is awake while it runs. A sleep before it counts, but its own length is never taken for one. */
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.observe();
    try {
      return await operation();
    } finally {
      this.lastSeen = this.clock.now();
    }
  }

  /** Output arrived. */
  touch(): void {
    this.observe();
    this.lastActivity = this.clock.now();
  }

  elapsedMs(): number {
    this.observe();
    return this.clock.now() - this.started;
  }

  idleMs(): number {
    this.observe();
    return this.clock.now() - this.lastActivity;
  }
}
