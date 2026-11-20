import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import { RunEntity } from './run.entity';
import { readOutcome } from './run-state';
import { RunWaitEntity } from './run-wait.entity';
import { RunWaitLog } from './run-wait.log';
import { StepStatEntity } from './step-stat.entity';

/** One visit of a finished run, as far as the estimate needs it. */
interface FinishedStep {
  step: string;
  enteredAt: string;
  lastFinishedAt: string;
}

/** A finished run with its visits and wait stretches. */
interface FinishedRun {
  id: number;
  kind: 'plain' | 'epic' | 'subtask';
  createdAt: string;
  /** When the run's merge into its parent happened; null for a run that is not a subtask. */
  mergedAt: string | null;
  steps: FinishedStep[];
  waits: RunWaitEntity[];
}

type RunRow = Pick<RunEntity, 'id' | 'createdAt' | 'mergeOutcome'>;

const KINDS: { kind: FinishedRun['kind']; where: FindOptionsWhere<RunEntity> }[] = [
  { kind: 'subtask', where: { parentRunId: Not(IsNull()) } },
  { kind: 'epic', where: { parentRunId: IsNull(), epicAt: Not(IsNull()) } },
  { kind: 'plain', where: { parentRunId: IsNull(), epicAt: IsNull() } },
];

/** Reads the finished runs an estimate is learned from. Reads only. */
@Injectable()
export class EtaHistoryRepository {
  constructor(
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(StepStatEntity) private readonly stepStats: Repository<StepStatEntity>,
    private readonly waitLog: RunWaitLog,
  ) {}

  /** For each kind of run, the newest `perKind` runs that are done and were not closed unmerged. */
  async finishedRuns(perKind: number): Promise<FinishedRun[]> {
    const picked: { kind: FinishedRun['kind']; row: RunRow; mergedAt: string | null }[] = [];
    for (const { kind, where } of KINDS) {
      const rows = await this.newest(kind, where, perKind);
      for (const row of rows) {
        picked.push({ kind, row, mergedAt: kind === 'subtask' ? mergedAt(row.mergeOutcome) : null });
      }
    }
    const ids = picked.map(({ row }) => row.id);
    const steps = await this.stepsOf(ids);
    const waits = await this.waitLog.waitsOf(ids);
    return picked.map(({ kind, row, mergedAt: merged }) => ({
      id: row.id,
      kind,
      createdAt: row.createdAt,
      mergedAt: merged,
      steps: steps.get(row.id) ?? [],
      waits: waits.get(row.id) ?? [],
    }));
  }

  private async newest(
    kind: FinishedRun['kind'],
    where: FindOptionsWhere<RunEntity>,
    limit: number,
  ): Promise<RunRow[]> {
    const rows: RunRow[] = [];
    for (let skip = 0; rows.length < limit; skip += limit) {
      const page = await this.runs.find({
        select: { id: true, createdAt: true, mergeOutcome: true },
        where: { ...where, status: 'done' },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip,
        take: limit,
      });
      for (const row of page) {
        const outcome = readOutcome(row.mergeOutcome);
        const counts = kind === 'subtask' ? outcome !== null && 'merged' in outcome : !outcome || 'merged' in outcome;
        if (counts && rows.length < limit) rows.push(row);
      }
      if (page.length < limit) break;
    }
    return rows;
  }

  private async stepsOf(runIds: number[]): Promise<Map<number, FinishedStep[]>> {
    const byRun = new Map<number, FinishedStep[]>();
    if (runIds.length === 0) return byRun;
    const stats = await this.stepStats.find({
      select: { runId: true, step: true, stepStartedAt: true, startedAt: true, finishedAt: true },
      where: { runId: In(runIds) },
      order: { id: 'ASC' },
    });
    const latest = new Map<string, FinishedStep>();
    for (const stat of stats) {
      const enteredAt = stat.stepStartedAt ?? stat.startedAt;
      const id = `${stat.runId}\n${stat.step}\n${enteredAt}`;
      const seen = latest.get(id);
      if (seen) {
        if (stat.finishedAt > seen.lastFinishedAt) seen.lastFinishedAt = stat.finishedAt;
        continue;
      }
      const entry = { step: stat.step, enteredAt, lastFinishedAt: stat.finishedAt };
      latest.set(id, entry);
      byRun.set(stat.runId, [...(byRun.get(stat.runId) ?? []), entry]);
    }
    return byRun;
  }
}

function mergedAt(stored: string | null): string | null {
  const outcome = readOutcome(stored);
  if (!outcome || !('merged' in outcome)) return null;
  return Object.values(outcome.merged).reduce<string | null>(
    (latest, merge) => (latest && latest > merge.at ? latest : merge.at),
    null,
  );
}
