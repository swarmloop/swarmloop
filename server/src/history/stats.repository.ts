import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { hasTitleText } from '../contract/requirements-view';
import { PLAN_CHAT_KIND } from '../contract/plan-chat';
import { BacklogMessageEntity } from './backlog-planner.entities';
import { CommandEntity, DocumentEntity, LoopEventEntity, RunEntity, StepStatEntity } from './entities';
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
  Partial<Pick<RunEntity, 'title' | 'parentRunId' | 'state' | 'mergeOutcome' | 'doneAt' | 'startedBy'>>;
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

/** What people wrote since a time, as raw rows: the counting is the caller's. */
export interface StatsPersonRows {
  /** Answer commands with a person. `id` is the key suffix (`message-<id>`) of the plan chat entry the same answer wrote. */
  answers: { id: string; createdAt: string }[];
  /** The latest plan chat of each run that changed since, when written since. */
  planChats: string[];
  /** Messages a person wrote to a backlog's planner. */
  backlogMessages: { createdAt: string }[];
}

export interface StatsRows {
  /** When the first run of all started, or null before any. A range never reaches back past it. */
  firstRunAt: string | null;
  runs: StatsRunRow[];
  steps: StatsStepRow[];
  loops: StatsLoopRow[];
  stalls: StatsStallRow[];
  person: StatsPersonRows;
}

/** The rows the statistics are counted from. Reads only; the counting is the caller's. */
@Injectable()
export class StatsRepository {
  constructor(
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(StepStatEntity) private readonly steps: Repository<StepStatEntity>,
    @InjectRepository(LoopEventEntity) private readonly loops: Repository<LoopEventEntity>,
    @InjectRepository(ServerStallEntity) private readonly stalls: Repository<ServerStallEntity>,
    @InjectRepository(CommandEntity) private readonly commands: Repository<CommandEntity>,
    @InjectRepository(DocumentEntity) private readonly documents: Repository<DocumentEntity>,
    @InjectRepository(BacklogMessageEntity) private readonly backlogMessages: Repository<BacklogMessageEntity>,
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
        startedBy: true,
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
    const person = await this.personRows(since);
    if (runs.length === 0) {
      return { firstRunAt, runs, steps: [], loops: [], stalls, person };
    }
    const scope = since === null ? {} : { runId: In(runs.map((run) => run.id)) };
    const steps = await this.stepRows(since === null ? null : runs.map((run) => run.id));
    const loops = await this.loops.find({
      select: { runId: true, counter: true, reason: true, detail: true, createdAt: true },
      where: scope,
    });
    return { firstRunAt, runs, steps, loops, stalls, person };
  }

  /** What people wrote at `since` or later (ever when null): answers, plan chats and backlog messages. */
  private async personRows(since: string | null): Promise<StatsPersonRows> {
    const recent = since === null ? {} : { createdAt: MoreThanOrEqual(since) };
    const answers = await this.commands.find({
      select: { id: true, createdAt: true },
      where: { type: 'answer', actor: Not(IsNull()), ...recent },
      order: { createdAt: 'ASC' },
    });
    const backlogMessages = await this.backlogMessages.find({
      select: { createdAt: true },
      where: { author: 'person', kind: 'message', ...recent },
      order: { id: 'ASC' },
    });
    // Each run's latest plan chat is found through the (run_id, kind, id) index, for the runs that changed since.
    const changed =
      since === null
        ? ''
        : ' WHERE run.updated_at >= :since OR run.id IN (SELECT command.run_id FROM commands command WHERE command.created_at >= :since)';
    const chats = this.documents
      .createQueryBuilder('document')
      .select('document.body', 'body')
      .where(
        `document.id IN (SELECT (SELECT MAX(latest.id) FROM documents latest WHERE latest.run_id = run.id AND latest.kind = :kind) FROM runs run${changed})`,
        { kind: PLAN_CHAT_KIND, since },
      );
    if (since !== null) {
      chats.andWhere('document.createdAt >= :since', { since });
    }
    const planChats: { body: string }[] = await chats.orderBy('document.id', 'ASC').getRawMany();
    return { answers, planChats: planChats.map(({ body }) => body), backlogMessages };
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
