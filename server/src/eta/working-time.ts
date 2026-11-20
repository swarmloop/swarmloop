import type { RunKind } from '../contract/eta';
import type { Wait } from './eta.types';

/** A parent run id means a subtask, an epic time means an epic parent, anything else does not split. */
export function runKind(facts: { parentRunId?: string | null; epicAt?: string | null }): RunKind {
  if (facts.parentRunId) {
    return 'subtask';
  }
  return facts.epicAt ? 'epic' : 'plain';
}

/** The span from `from` to `to` minus the time it overlaps any wait; an open wait ends at `to`. */
export function workingMs(from: string, to: string, waits: readonly Wait[]): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!(end > start)) {
    return 0;
  }
  const spans = waits
    .map((wait) => ({
      from: Math.max(start, Date.parse(wait.from)),
      to: Math.min(end, wait.to === null ? end : Date.parse(wait.to)),
    }))
    .filter((span) => span.to > span.from)
    .sort((a, b) => a.from - b.from);
  let waiting = 0;
  let reached = start;
  for (const span of spans) {
    const spanFrom = Math.max(span.from, reached);
    if (span.to > spanFrom) {
      waiting += span.to - spanFrom;
      reached = span.to;
    }
  }
  return end - start - waiting;
}
