export interface DurationPart {
  step: string;
  durationMs: number;
  stepStartedAt: string | null;
  startedAt: string;
  finishedAt: string;
  reportMs: number;
}

export function toDurationParts(
  stats: { id: number; step: string; durationMs: number; stepStartedAt: string | null; startedAt: string; finishedAt: string }[],
  reportMs: ReadonlyMap<number, number>,
): DurationPart[] {
  return stats.map((stat) => ({
    step: stat.step,
    durationMs: stat.durationMs,
    stepStartedAt: stat.stepStartedAt,
    startedAt: stat.startedAt,
    finishedAt: stat.finishedAt,
    reportMs: stat.step === 'code-review' ? (reportMs.get(stat.id) ?? 0) : 0,
  }));
}

/**
 * Wall-clock time the steps ran. A code-review visit counts as its slowest reviewer plus the report,
 * or its own row when that is longer. Reviewers with no closed visit are left to the live clock.
 */
export function activeDurationMs(parts: DurationPart[]): number {
  const reviewers = parts.filter((part) => isReviewer(part.step));
  const claimed = new Set<DurationPart>();
  let total = 0;
  for (const part of parts) {
    if (isReviewer(part.step)) {
      continue;
    }
    if (part.step !== 'code-review') {
      total += part.durationMs;
      continue;
    }
    const wave = reviewers.filter((reviewer) => !claimed.has(reviewer) && sameWave(reviewer, part));
    for (const reviewer of wave) {
      claimed.add(reviewer);
    }
    const slowest = wave.reduce((max, reviewer) => Math.max(max, reviewer.durationMs), 0);
    total += Math.max(part.durationMs, slowest + part.reportMs);
  }
  return total;
}

function isReviewer(step: string): boolean {
  return step.startsWith('code-review-');
}

function sameWave(reviewer: DurationPart, visit: DurationPart): boolean {
  if (visit.stepStartedAt || reviewer.stepStartedAt) {
    return reviewer.stepStartedAt === visit.stepStartedAt;
  }
  return reviewer.startedAt >= visit.startedAt && reviewer.startedAt <= visit.finishedAt;
}
