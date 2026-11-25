import type { Repository } from 'typeorm';
import { activeDurationMs, toDurationParts } from './active-duration';
import type { StepStatEntity } from './entities';
import type { VisitRepository } from './visit.repository';

/** The active time of every run, or only of the runs with these ids. */
export async function durationByRun(
  stepStats: Repository<StepStatEntity>,
  visitRepository: VisitRepository,
  runIds?: number[],
): Promise<Map<number, number>> {
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
  const byRun = new Map<number, StepStatEntity[]>();
  for (const stat of stats) {
    const rows = byRun.get(stat.runId) ?? [];
    rows.push(stat);
    byRun.set(stat.runId, rows);
  }
  const totals = new Map<number, number>();
  for (const [runId, rows] of byRun) {
    totals.set(runId, activeDurationMs(toDurationParts(rows, reports)));
  }
  return totals;
}
