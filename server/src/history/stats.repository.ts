import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { LoopEventEntity, RunEntity, StepStatEntity } from './entities';

export type StatsRunRow = Pick<RunEntity, 'id' | 'key' | 'prompt' | 'status' | 'runtime' | 'createdAt'> &
  Partial<Pick<RunEntity, 'state' | 'mergeOutcome' | 'doneAt'>>;
export type StatsStepRow = Pick<
  StepStatEntity,
  | 'runId'
  | 'step'
  | 'runtime'
  | 'model'
  | 'status'
  | 'killReason'
  | 'usd'
  | 'tokensIn'
  | 'tokensOut'
  | 'durationMs'
  | 'finishedAt'
>;
export type StatsLoopRow = Pick<LoopEventEntity, 'runId' | 'counter' | 'reason' | 'createdAt'>;

export interface StatsRows {
  /** When the first run of all started, or null before any. A range never reaches back past it. */
  firstRunAt: string | null;
  runs: StatsRunRow[];
  steps: StatsStepRow[];
  loops: StatsLoopRow[];
}

/** The rows the statistics are counted from. Reads only; the counting is the caller's. */
@Injectable()
export class StatsRepository {
  constructor(
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(StepStatEntity) private readonly steps: Repository<StepStatEntity>,
    @InjectRepository(LoopEventEntity) private readonly loops: Repository<LoopEventEntity>,
  ) {}

  /** The runs created at `since` or later (every run when null), with their steps and their returns. */
  async rows(since: string | null): Promise<StatsRows> {
    const runs = await this.runs.find({
      select: {
        id: true,
        key: true,
        prompt: true,
        status: true,
        runtime: true,
        createdAt: true,
        state: true,
        mergeOutcome: true,
        doneAt: true,
      },
      where: since === null ? {} : { createdAt: MoreThanOrEqual(since) },
      order: { id: 'ASC' },
    });
    const first = await this.runs.find({ select: { createdAt: true }, order: { createdAt: 'ASC' }, take: 1 });
    const firstRunAt = first[0]?.createdAt ?? null;
    if (runs.length === 0) {
      return { firstRunAt, runs, steps: [], loops: [] };
    }
    const scope = since === null ? {} : { runId: In(runs.map((run) => run.id)) };
    const steps = await this.steps.find({
      select: {
        runId: true,
        step: true,
        runtime: true,
        model: true,
        status: true,
        killReason: true,
        usd: true,
        tokensIn: true,
        tokensOut: true,
        durationMs: true,
        finishedAt: true,
      },
      where: scope,
    });
    const loops = await this.loops.find({
      select: { runId: true, counter: true, reason: true, createdAt: true },
      where: scope,
    });
    return { firstRunAt, runs, steps, loops };
  }
}
