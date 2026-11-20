import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { hasTitleText } from '../contract/requirements-view';
import { LoopEventEntity, RunEntity, StepStatEntity } from './entities';
import { ServerStallEntity } from './server-stall.entities';

/** How much of a prompt is read for the name and the title: both use only its first lines. */
const PROMPT_PREFIX = 4096;

/** True when the first line of the text that has text besides markdown marks ends inside `prefix`, so a cut `prefix` gives the same name and title. */
function promptPrefixIsEnough(prefix: string): boolean {
  return prefix.split('\n').slice(0, -1).some(hasTitleText);
}

const STEP_COLUMNS = [
  'runId',
  'step',
  'runtime',
  'model',
  'effort',
  'status',
  'killReason',
  'usd',
  'tokensIn',
  'tokensOut',
  'durationMs',
  'finishedAt',
  'shellEdits',
] as const satisfies readonly (keyof StatsStepRow)[];

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
    const runs = await this.runs.find({
      select: {
        id: true,
        key: true,
        title: true,
        parentRunId: true,
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
    await this.readPrompts(runs);
    const first = await this.runs.find({ select: { createdAt: true }, order: { createdAt: 'ASC' }, take: 1 });
    const firstRunAt = first[0]?.createdAt ?? null;
    const stalls = await this.stalls.find({
      select: { startedAt: true, durationMs: true, kind: true },
      where: since === null ? {} : { startedAt: MoreThanOrEqual(since) },
      order: { id: 'ASC' },
    });
    if (runs.length === 0) {
      return { firstRunAt, runs, steps: [], loops: [], stalls };
    }
    const scope = since === null ? {} : { runId: In(runs.map((run) => run.id)) };
    const steps = await this.stepRows(since === null ? null : runs.map((run) => run.id));
    const loops = await this.loops.find({
      select: { runId: true, counter: true, reason: true, detail: true, createdAt: true },
      where: scope,
    });
    return { firstRunAt, runs, steps, loops, stalls };
  }

  /** Fills `prompt` of each run: its first 4096 characters, or the whole text when the prefix is not enough. */
  private async readPrompts(runs: StatsRunRow[]): Promise<void> {
    if (runs.length === 0) {
      return;
    }
    const ids = runs.map((run) => run.id);
    const prefixes: { id: number; prompt: string | null }[] = await this.runs
      .createQueryBuilder('run')
      .select('run.id', 'id')
      .addSelect(`substr(run.prompt, 1, ${PROMPT_PREFIX})`, 'prompt')
      .where('run.id IN (:...ids)', { ids })
      .getRawMany();
    const byId = new Map(runs.map((run) => [run.id, run]));
    const short: number[] = [];
    for (const { id, prompt } of prefixes) {
      const run = byId.get(id);
      if (!run) {
        continue;
      }
      run.prompt = prompt;
      if (prompt !== null && prompt.length >= PROMPT_PREFIX && !promptPrefixIsEnough(prompt)) {
        short.push(id);
      }
    }
    if (short.length === 0) {
      return;
    }
    const full = await this.runs.find({ select: { id: true, prompt: true }, where: { id: In(short) } });
    for (const { id, prompt } of full) {
      const run = byId.get(id);
      if (run) {
        run.prompt = prompt;
      }
    }
  }

  /** The step rows of the runs with these ids (of every run for null), as plain rows: no entity is built for each of thousands. */
  private async stepRows(runIds: number[] | null): Promise<StatsStepRow[]> {
    const query = this.steps.createQueryBuilder('step');
    for (const column of STEP_COLUMNS) {
      query.addSelect(`step.${column}`, column);
    }
    if (runIds !== null) {
      query.where('step.runId IN (:...runIds)', { runIds });
    }
    return query.getRawMany();
  }
}
