import type { Repository } from 'typeorm';
import { activeDurationMs, toDurationParts } from './active-duration';
import type { StepStatEntity } from './entities';
import type { VisitRepository } from './visit.repository';

/** The step rows the durations are summed from, in id order, and the code-review report time of each visit. */
export interface DurationRows {
  stats: Pick<StepStatEntity, 'id' | 'runId' | 'step' | 'durationMs' | 'stepStartedAt' | 'startedAt' | 'finishedAt'>[];
  reportMs: ReadonlyMap<number, number>;
}

/** The active time of each run in `rows`. */
function durationsOf({ stats, reportMs }: DurationRows): Map<number, number> {
  const byRun = new Map<number, DurationRows['stats']>();
  for (const stat of stats) {
    const rows = byRun.get(stat.runId) ?? [];
    rows.push(stat);
    byRun.set(stat.runId, rows);
  }
  const totals = new Map<number, number>();
  for (const [runId, rows] of byRun) {
    totals.set(runId, activeDurationMs(toDurationParts(rows, reportMs)));
  }
  return totals;
}

/** The active time of every run, or only of the runs with these ids. Reads nothing when given the step `rows`. */
export async function durationByRun(
  stepStats: Repository<StepStatEntity>,
  visitRepository: VisitRepository,
  runIds?: number[],
  rows?: DurationRows,
): Promise<Map<number, number>> {
  if (rows) {
    return durationsOf(rows);
  }
  const query = stepStats.createQueryBuilder('stat');
  for (const column of ['id', 'runId', 'step', 'durationMs', 'stepStartedAt', 'startedAt', 'finishedAt']) {
    query.addSelect(`stat.${column}`, column);
  }
  if (runIds) {
    query.where('stat.runId IN (:...runIds)', { runIds });
  }
  // Plain rows: an entity per step row of the whole history is what held the main thread.
  const stats: StepStatEntity[] = await query.orderBy('stat.id', 'ASC').getRawMany();
  const reports = await visitRepository.codeReviewReportMs(...(runIds ?? []));
  return durationsOf({ stats, reportMs: reports });
}
