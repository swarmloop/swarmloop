import type { Footprint, FootprintPeak, HeavyKind } from '../core/heavy-work';

const GB = 1024 ** 3;
/** Fewer samples than this say too little: the seed stands in. */
const MIN_PEAKS = 5;
const SEEDS: Record<HeavyKind, Footprint> = {
  check: { memoryBytes: 4 * GB },
  setup: { memoryBytes: 4 * GB },
  agent: { memoryBytes: 2 * GB },
};
const HEADROOM = 1.5;

/** Below the default weight of 1024 that the server and the dashboard keep, so they win a fight for the CPU. */
export const SANDBOX_CPU_SHARES = 512;

function p80(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.8) - 1] ?? 0;
}

/** The p80 of the peaks of the finished pieces of work of that kind, or the seed while there are fewer than five. */
export function footprintOf(kind: HeavyKind, peaks: readonly FootprintPeak[]): Footprint {
  if (peaks.length < MIN_PEAKS) {
    return SEEDS[kind];
  }
  return { memoryBytes: p80(peaks.map((peak) => peak.rssBytes)) };
}

/** The memory a container may take: its footprint with headroom, and never less than the seed. */
export function memoryCap(kind: HeavyKind, footprint: Footprint): number {
  return Math.max(SEEDS[kind].memoryBytes, Math.ceil(footprint.memoryBytes * HEADROOM));
}
