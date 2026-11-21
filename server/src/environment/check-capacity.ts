import { checksAtOnce } from '../sandbox/core-slices';
import type { CpuSlice } from '../sandbox/sandbox-types';

/** Keeps admission and launch on one reading until all checks using it have left the line. */
export class CheckCapacity {
  private users = 0;
  private reading: Promise<void> | undefined;
  private capacity: { cores: number | undefined; places: number } | undefined;

  constructor(
    private readonly parallel: () => number,
    private readonly readCores?: () => Promise<{ cpus: number } | undefined>,
  ) {}

  enter(): Promise<void> {
    this.users += 1;
    this.reading ??= (this.readCores?.() ?? Promise.resolve(undefined)).then((machine) => {
      this.capacity = { cores: machine?.cpus, places: checksAtOnce(machine?.cpus, this.parallel()) };
    });
    return this.reading;
  }

  places(): number {
    return this.capacity?.places ?? this.parallel();
  }

  /** Null pins the unknown-core fallback; undefined leaves callers without a reader unchanged. */
  slice(place: number): CpuSlice | null | undefined {
    if (!this.capacity) return undefined;
    const { cores, places } = this.capacity;
    return cores === undefined ? null : { cores, places, index: place };
  }

  leave(): void {
    this.users -= 1;
    if (this.users === 0) {
      this.reading = undefined;
      this.capacity = undefined;
    }
  }
}
