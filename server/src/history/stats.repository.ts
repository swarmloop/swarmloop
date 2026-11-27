import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { PLAN_CHAT_KIND } from '../contract/plan-chat';
import { BacklogMessageEntity } from './backlog-planner.entities';
import { CommandEntity, DocumentEntity, LoopEventEntity, RunEntity, StepStatEntity } from './entities';
import type { DurationRows } from './run-durations';
import { ServerStallEntity } from './server-stall.entities';
import { placeholders } from './sql-placeholders';
import { statsDocuments, type StatsDocument, type WantedDocuments } from './stats-documents';
import { TITLE_MARK_CHARACTERS } from './title-marks';

/** How much of a prompt is read for the name and the title: both use only its first lines. */
const PROMPT_PREFIX = 4096;

/**
 * The prompt a name and a title need: its first 4096 characters when the first line that has text besides markdown
 * marks ends inside them (a newline follows the first character that is no mark), else the whole text.
 */
const PROMPT_FOR_TITLE = `CASE WHEN instr(ltrim(substr(run.prompt, 1, ${PROMPT_PREFIX}), ?), char(10)) > 0
  THEN substr(run.prompt, 1, ${PROMPT_PREFIX}) ELSE run.prompt END`;

const RUN_COLUMNS = `run.id AS id, run.key AS key, run.title AS title, run.parent_run_id AS parentRunId,
  run.status AS status, run.runtime AS runtime, run.created_at AS createdAt, run.state AS state,
  run.merge_outcome AS mergeOutcome, run.done_at AS doneAt, run.started_by AS startedBy`;

export type StatsRunRow = Pick<RunEntity, 'id' | 'key' | 'prompt' | 'status' | 'runtime' | 'createdAt'> &
  Partial<Pick<RunEntity, 'title' | 'parentRunId' | 'state' | 'mergeOutcome' | 'doneAt' | 'startedBy'>>;
/** What a step read carries besides the step row: what tells a visit from a ping, and the times durations need. */
interface StepRowExtras {
  ping: 0 | 1;
  statId: number;
  callId: number;
  stepStartedAt: string | null;
  startedAt: string;
  reportMs: number | null;
}

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
> & {
  /** A keep-warm ping of the run: its cost counts, it is no visit and has no agent time. */
  ping?: true;
};

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

/** What `read` gives besides the rows: the step rows' times for the working time, and the documents the report counts. */
interface StatsReading extends StatsRows {
  durationRows: DurationRows;
  /** The latest document of each kind asked for, of each run asked for, oldest first. No plan chat is among them. */
  documents: StatsDocument[];
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
    const { firstRunAt, runs, steps, loops, stalls, person } = await this.read(since);
    return { firstRunAt, runs, steps, loops, stalls, person };
  }

  /**
   * What `rows` gives, and with it the step rows' times for the working time and the documents. `wanted` names, from
   * the runs read, the documents to read besides the plan chats: all of them come in one statement.
   */
  async read(
    since: string | null,
    wanted: (runs: StatsRunRow[]) => WantedDocuments[] = () => [],
  ): Promise<StatsReading> {
    const { firstRunAt, runs } = await this.runRows(since);
    const stalls = await this.stalls.find({
      select: { startedAt: true, durationMs: true, kind: true },
      where: since === null ? {} : { startedAt: MoreThanOrEqual(since) },
      order: { id: 'ASC' },
    });
    const person = await this.personRows(since);
    const read = await statsDocuments(this.documents, since, wanted(runs));
    const planChats = read.filter(({ kind }) => kind === PLAN_CHAT_KIND).map(({ body }) => body);
    const documents = read.filter(({ kind }) => kind !== PLAN_CHAT_KIND);
    const withPeople = { ...person, planChats };
    if (runs.length === 0) {
      const durationRows = { stats: [], reportMs: new Map<number, number>() };
      return { firstRunAt, runs, steps: [], loops: [], stalls, person: withPeople, durationRows, documents };
    }
    const scope = since === null ? {} : { runId: In(runs.map((run) => run.id)) };
    const { steps, durationRows } = await this.stepRows(since === null ? null : runs.map((run) => run.id));
    const loops = await this.loops.find({
      select: { runId: true, counter: true, reason: true, detail: true, createdAt: true },
      where: scope,
    });
    return { firstRunAt, runs, steps, loops, stalls, person: withPeople, durationRows, documents };
  }

  /**
   * The runs created at `since` or later, each with the prompt its name and title need, and when the first run of all
   * started, in one statement. The first run's time rides on a row of its own when no run is in the range.
   */
  private async runRows(since: string | null): Promise<{ firstRunAt: string | null; runs: StatsRunRow[] }> {
    const found: ({ firstRunAt: string | null; id: number | null } & Omit<StatsRunRow, 'id'>)[] =
      await this.runs.manager.query(
        `SELECT earliest.at AS firstRunAt, ${RUN_COLUMNS}, ${PROMPT_FOR_TITLE} AS prompt
         FROM (SELECT MIN(created_at) AS at FROM runs) earliest
         LEFT JOIN runs run ON ${since === null ? '1' : 'run.created_at >= ?'} ORDER BY run.id`,
        since === null ? [TITLE_MARK_CHARACTERS] : [TITLE_MARK_CHARACTERS, since],
      );
    const runs = found.flatMap(({ firstRunAt: _firstRunAt, ...run }) =>
      run.id === null ? [] : [{ ...run, id: run.id }],
    );
    return { firstRunAt: found[0]?.firstRunAt ?? null, runs };
  }

  /** What people wrote at `since` or later (ever when null): answers and backlog messages. The plan chats come with the documents. */
  private async personRows(since: string | null): Promise<Omit<StatsPersonRows, 'planChats'>> {
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
    return { answers, backlogMessages };
  }

  /**
   * The step rows of the runs with these ids (of every run for null), in one statement, as plain rows: no entity is
   * built for each of thousands. A visit's cost and tokens are the sums of the log rows linked to it, and its
   * code-review report time the sum of the exchanges that are no helper's. The run's pings follow the visits, one row
   * each. The visits also come as the rows the working time is summed from.
   */
  private async stepRows(runIds: number[] | null): Promise<{ steps: StatsStepRow[]; durationRows: DurationRows }> {
    const logScope =
      runIds === null
        ? ''
        : ` AND step_stat_id IN (SELECT id FROM step_stats WHERE run_id IN (${placeholders(runIds)}))`;
    const visitScope = runIds === null ? '' : ` WHERE step.run_id IN (${placeholders(runIds)})`;
    const pingScope = runIds === null ? '' : ` AND run.id IN (${placeholders(runIds)})`;
    const rows: (Omit<StatsStepRow, 'ping'> & StepRowExtras)[] = await this.steps.manager.query(
      `SELECT 0 AS ping, step.id AS statId, 0 AS callId, step.run_id AS runId, step.step AS step, step.runtime AS runtime,
         step.model AS model, step.effort AS effort, step.status AS status, step.kill_reason AS killReason,
         COALESCE(log.usd, 0) AS usd, COALESCE(log.tokensIn, 0) AS tokensIn, COALESCE(log.tokensOut, 0) AS tokensOut,
         step.duration_ms AS durationMs, step.finished_at AS finishedAt, step.shell_edits AS shellEdits,
         step.step_started_at AS stepStartedAt, step.started_at AS startedAt, log.reportMs AS reportMs
       FROM step_stats step
       LEFT JOIN (
         SELECT step_stat_id, SUM(own_usd) AS usd,
           SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS tokensIn, SUM(output_tokens) AS tokensOut,
           SUM(CASE WHEN kind <> 'helper' THEN duration_ms END) AS reportMs
         FROM agent_exchanges WHERE step_stat_id > 0${logScope} GROUP BY step_stat_id
       ) log ON log.step_stat_id = step.id${visitScope}
       UNION ALL
       SELECT 1, 0, call.id, run.id, COALESCE(call.step, ''), call.runtime, call.model, call.effort, 'done', NULL,
         call.own_usd, call.input_tokens + call.cache_read_tokens + call.cache_write_tokens, call.output_tokens,
         0, CASE WHEN call.finished_at = '' THEN call.started_at ELSE call.finished_at END, 0, NULL, NULL, NULL
       FROM agent_exchanges call JOIN runs run ON run.key = call.run_key
       WHERE call.kind = 'ping'${pingScope}
       ORDER BY ping, statId, callId`,
      runIds === null ? [] : [...runIds, ...runIds, ...runIds],
    );
    const steps: StatsStepRow[] = [];
    const stats: DurationRows['stats'] = [];
    const reportMs = new Map<number, number>();
    for (const row of rows) {
      // Plain assignments: this loop runs once for every step row of the range.
      const step: StatsStepRow = {
        runId: row.runId,
        step: row.step,
        runtime: row.runtime,
        model: row.model,
        effort: row.effort,
        status: row.status,
        killReason: row.killReason,
        usd: row.usd,
        tokensIn: row.tokensIn,
        tokensOut: row.tokensOut,
        durationMs: row.durationMs,
        finishedAt: row.finishedAt,
        shellEdits: row.shellEdits,
      };
      if (row.ping) {
        steps.push({ ...step, ping: true });
        continue;
      }
      steps.push(step);
      stats.push({
        id: row.statId,
        runId: row.runId,
        step: row.step,
        durationMs: row.durationMs,
        stepStartedAt: row.stepStartedAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      });
      if (row.reportMs !== null) {
        reportMs.set(row.statId, Number(row.reportMs) || 0);
      }
    }
    return { steps, durationRows: { stats, reportMs } };
  }
}
