import type { StatsDay } from '../contract/api';
import type { StatsRows } from '../history/stats.repository';
import { localDay } from './local-day';

/** Adds each server stall to the local day it started: its count by kind and its time. */
export function stallsOf(stalls: StatsRows['stalls'], days: Map<string, StatsDay>, tzOffset: number): void {
  for (const stall of stalls) {
    const day = days.get(localDay(stall.startedAt, tzOffset));
    if (day) {
      day.stalls[stall.kind] += 1;
      day.stalledMs += stall.durationMs;
    }
  }
}
