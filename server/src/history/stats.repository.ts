import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LoopEventEntity, RunEntity, StepStatEntity } from './entities';
import { hasCompleteTitleLine } from '../contract/requirements-view';
import { ServerStallEntity } from './server-stall.entities';

/** How much of each prompt the runs query reads. A run whose prompt this does not settle is read in full. */
const PROMPT_PREFIX = 4096;

type PrefixedRun = StatsRunRow & { promptLength: number | null };

export type StatsRunRow = Pick<RunEntity, 'id' | 'key' | 'prompt' | 'status' | 'runtime' | 'createdAt'> &
  Partial<Pick<RunEntity, 'title' | 'parentRunId' | 'state' | 'mergeOutcome' | 'doneAt'>>;
export type StatsStepRow = Pick<
  StepStatEntity,
  | 'runId'
  | 'step'
  | 'runtime'
  | 'model'
  | 'effort'
  | 'status'
  | 'killReason'
  | 'usd'
  | 'tokensIn'
  | 'tokensOut'
  | 'durationMs'
  | 'finishedAt'
  | 'shellEdits'
  | 'id'
  | 'stepStartedAt'
  | 'startedAt'
>;
export type StatsLoopRow = Pick<LoopEventEntity, 'runId' | 'counter' | 'reason' | 'createdAt'> &
  Partial<Pick<LoopEventEntity, 'detail'>>;

export type StatsStallRow = Pick<ServerStallEntity, 'startedAt' | 'durationMs' | 'kind'>;

export interface StatsRows {
  /** When the first run of all started, or null before any. A range never reaches back past it. */
  firstRunAt: string | null;
  runs: StatsRunRow[];
  steps: StatsStepRow[];
  loops: StatsLoopRow[];
  stalls: StatsStallRow[];
}

/**
 * The name of a run is the first line of its trimmed prompt and its title the first line with text, so a prefix that holds
 * the whole of both lines gives what the whole prompt gives.
 */
function prefixSettlesPrompt(prefix: string): boolean {
  return prefix.trim().includes('\n') && hasCompleteTitleLine(prefix);
}

function earliest(runs: StatsRunRow[]): string | null {
  return runs.reduce<string | null>(
    (first, run) => (first === null || run.createdAt < first ? run.createdAt : first),
    null,
  );
}

/** The rows the statistics are counted from. Reads only; the counting is the caller's. */
@Injectable()
export class StatsRepository {
  constructor(
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(StepStatEntity) private readonly steps: Repository<StepStatEntity>,
    @InjectRepository(LoopEventEntity) private readonly loops: Repository<LoopEventEntity>,
    @InjectRepository(ServerStallEntity) private readonly stalls: Repository<ServerStallEntity>,
  ) {}

  /** The runs created at `since` or later (every run when null), with their steps and their returns. */
  async rows(since: string | null): Promise<StatsRows> {
    const runQuery = this.runs
      .createQueryBuilder('run')
      .select([
        'run.id AS id',
        'run.key AS key',
        `substr(run.prompt, 1, ${PROMPT_PREFIX}) AS prompt`,
        'length(run.prompt) AS promptLength',
        'run.title AS title',
        'run.parent_run_id AS parentRunId',
        'run.status AS status',
        'run.runtime AS runtime',
        'run.created_at AS createdAt',
        'run.state AS state',
        'run.merge_outcome AS mergeOutcome',
        'run.done_at AS doneAt',
      ])
      .orderBy('run.id', 'ASC');
    if (since !== null) {
      runQuery.where('run.created_at >= :since', { since });
    }
    const runs = await this.withFullPrompts(await runQuery.getRawMany<PrefixedRun>());
    const firstRunAt = since === null ? earliest(runs) : await this.firstRunAt();
    const stallQuery = this.stalls
      .createQueryBuilder('stall')
      .select(['stall.started_at AS startedAt', 'stall.duration_ms AS durationMs', 'stall.kind AS kind'])
      .orderBy('stall.id', 'ASC');
    if (since !== null) {
      stallQuery.where('stall.started_at >= :since', { since });
    }
    const stalls = await stallQuery.getRawMany<StatsStallRow>();
    if (runs.length === 0) {
      return { firstRunAt, runs, steps: [], loops: [], stalls };
    }
    const ids = runs.map((run) => run.id);
    const stepQuery = this.steps
      .createQueryBuilder('step')
      .select([
        'step.id AS id',
        'step.run_id AS runId',
        'step.step AS step',
        'step.runtime AS runtime',
        'step.model AS model',
        'step.effort AS effort',
        'step.status AS status',
        'step.kill_reason AS killReason',
        'step.usd AS usd',
        'step.tokens_in AS tokensIn',
        'step.tokens_out AS tokensOut',
        'step.duration_ms AS durationMs',
        'step.finished_at AS finishedAt',
        'step.step_started_at AS stepStartedAt',
        'step.started_at AS startedAt',
        'step.shell_edits AS shellEdits',
      ]);
    const loopQuery = this.loops
      .createQueryBuilder('loop')
      .select([
        'loop.run_id AS runId',
        'loop.counter AS counter',
        'loop.reason AS reason',
        'loop.detail AS detail',
        'loop.created_at AS createdAt',
      ]);
    if (since !== null) {
      stepQuery.where('step.run_id IN (:...ids)', { ids });
      loopQuery.where('loop.run_id IN (:...ids)', { ids });
    }
    const steps = await stepQuery.getRawMany<StatsStepRow>();
    const loops = await loopQuery.getRawMany<StatsLoopRow>();
    return { firstRunAt, runs, steps, loops, stalls };
  }

  private async firstRunAt(): Promise<string | null> {
    const first = await this.runs
      .createQueryBuilder('run')
      .select('MIN(run.created_at)', 'createdAt')
      .getRawOne<{ createdAt: string | null }>();
    return first?.createdAt ?? null;
  }

  /** The runs without their length, each with its full prompt where the prefix read does not settle name and title. */
  private async withFullPrompts(rows: PrefixedRun[]): Promise<StatsRunRow[]> {
    const longer = rows
      .filter((row) => (row.promptLength ?? 0) > PROMPT_PREFIX && !prefixSettlesPrompt(row.prompt ?? ''))
      .map((row) => row.id);
    const full = new Map<number, string | null>();
    if (longer.length > 0) {
      const found = await this.runs
        .createQueryBuilder('run')
        .select(['run.id AS id', 'run.prompt AS prompt'])
        .where('run.id IN (:...longer)', { longer })
        .getRawMany<{ id: number; prompt: string | null }>();
      found.forEach((row) => full.set(row.id, row.prompt));
    }
    return rows.map(({ promptLength: _length, ...run }) =>
      full.has(run.id) ? { ...run, prompt: full.get(run.id) ?? null } : run,
    );
  }
}
