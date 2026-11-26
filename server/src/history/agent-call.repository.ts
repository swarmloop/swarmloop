import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AgentExchangeEntity } from './agent-exchange.entity';
import type {
  AgentCallRow,
  CallEnd,
  CallStart,
  CallTotals,
  ModelPrice,
  ModelUsage,
  OpenScope,
  PingDraft,
  PingStopReason,
  RequestUsage,
  Tie,
} from './agent-call';

type Values = Record<string, string | number | null>;

function parse<T>(text: string | null, fallback: T): T {
  return text ? (JSON.parse(text) as T) : fallback;
}

/** The one writer of the log, `agent_exchanges`: one row per call, helper, failover and ping. Its reads are plain sums over rows; nothing derived is stored. */
@Injectable()
export class AgentCallRepository {
  /** The last write queued for each row. Writes to one row run one after another; an entry goes when its queue drains. */
  private readonly queues = new Map<number, Promise<void>>();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Opens the row of a call that starts now. It is persisted at once, so a call that dies leaves it. */
  open(draft: CallStart): Promise<number> {
    return this.insert({
      kind: draft.kind,
      step_stat_id: 0,
      started_at: draft.startedAt,
      finished_at: '',
      duration_ms: 0,
      response_text: '',
      end_kind: 'running',
      parent_id: draft.parentId ?? null,
      previous_id: draft.previousId ?? null,
      replaces_id: draft.replacesId ?? null,
      run_key: draft.runKey ?? null,
      turn_key: draft.turnKey ?? null,
      backlog: draft.backlog ?? null,
      task_slug: draft.taskSlug ?? null,
      epic_key: draft.epicKey ?? null,
      step: draft.step ?? null,
      planner_level: draft.plannerLevel ?? null,
      purpose: draft.purpose ?? null,
      start_reason: draft.startReason ?? null,
      attempt_id: draft.attemptId ?? null,
      chat_id: draft.chatId ?? null,
      resumed: draft.resumed ? 1 : 0,
      chat_idle_min: draft.chatIdleMin ?? null,
      runtime: draft.runtime,
      model: draft.model,
      effort: draft.effort ?? null,
      request_text: draft.requestText,
    });
  }

  /** Adds one model request to the row's own sums and to its per-model usage, in the same write. */
  addRequest(id: number, request: RequestUsage): Promise<void> {
    return this.queued(id, async () => {
      const [row] = await this.dataSource.query<{ usage: string | null; prices: string | null }[]>(
        `SELECT usage, prices FROM agent_exchanges WHERE id = ?`,
        [id],
      );
      const usage = parse<ModelUsage[]>(row?.usage ?? null, []);
      const prices = parse<Record<string, ModelPrice>>(row?.prices ?? null, {});
      const { price, ...own } = request;
      const known = usage.find((entry) => entry.model === own.model);
      if (known) {
        known.input += own.input;
        known.cacheRead += own.cacheRead;
        known.cacheWrite += own.cacheWrite;
        known.output += own.output;
        known.usd += own.usd;
      } else {
        usage.push(own);
      }
      prices[own.model] = price;
      await this.dataSource.query(
        `UPDATE agent_exchanges SET
           input_tokens = input_tokens + ?, cache_read_tokens = cache_read_tokens + ?,
           cache_write_tokens = cache_write_tokens + ?, output_tokens = output_tokens + ?,
           own_usd = own_usd + ?, usage = ?, prices = ? WHERE id = ?`,
        [
          own.input,
          own.cacheRead,
          own.cacheWrite,
          own.output,
          own.usd,
          JSON.stringify(usage),
          JSON.stringify(prices),
          id,
        ],
      );
    });
  }

  finish(id: number, end: CallEnd): Promise<void> {
    return this.queued(id, async () => {
      await this.dataSource.query(
        `UPDATE agent_exchanges SET
           end_kind = ?, finished_at = ?, duration_ms = ?, response_text = ?, chat_id = COALESCE(?, chat_id),
           error_class = ?, error_text = ?, exit_code = ?, kill_reason = ?, limit_window = ?, limit_resets_at = ?,
           refused_reason = ?, stop_reason = ?, reported_usd = ?, reported_tokens_in = ?, reported_tokens_out = ?
         WHERE id = ?`,
        [
          end.endKind,
          end.finishedAt,
          end.durationMs,
          end.responseText,
          end.chatId ?? null,
          end.errorClass ?? null,
          end.errorText ?? null,
          end.exitCode ?? null,
          end.killReason ?? null,
          end.limitWindow ?? null,
          end.limitResetsAt ?? null,
          end.refusedReason ?? null,
          end.stopReason ?? null,
          end.reported?.usd ?? null,
          end.reported?.tokensIn ?? null,
          end.reported?.tokensOut ?? null,
          id,
        ],
      );
    });
  }

  setTies(id: number, ties: Tie[]): Promise<void> {
    return this.queued(id, async () => {
      await this.dataSource.query(`UPDATE agent_exchanges SET ties = ? WHERE id = ?`, [JSON.stringify(ties), id]);
    });
  }

  /** Links exactly the given rows to a stored visit. */
  async linkVisit(ids: number[], statId: number): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.dataSource.query(
      `UPDATE agent_exchanges SET step_stat_id = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
      [statId, ...ids],
    );
  }

  /** Ends the rows of a scope that a dead process left open, as failed. Their cost stays as it was streamed. */
  async closeLeftOpen(scope: OpenScope, finishedAt: string): Promise<void> {
    const [where, value] =
      'attemptId' in scope
        ? [`attempt_id = ?`, scope.attemptId]
        : 'turnKey' in scope
          ? [`turn_key = ?`, scope.turnKey]
          : [`kind = 'ping'`, null];
    await this.dataSource.query(
      `UPDATE agent_exchanges SET end_kind = 'failed', error_text = 'process died', finished_at = ?
       WHERE end_kind = 'running' AND ${where}`,
      value === null ? [finishedAt] : [finishedAt, value],
    );
  }

  /** The ping's row, or null when its chat already has a row for that due time. */
  async insertPing(draft: PingDraft): Promise<number | null> {
    return this.insert(
      {
        kind: 'ping',
        step_stat_id: 0,
        started_at: draft.startedAt,
        finished_at: '',
        duration_ms: 0,
        response_text: '',
        end_kind: 'running',
        previous_id: draft.previousId,
        run_key: draft.runKey,
        step: draft.step ?? null,
        backlog: draft.backlog ?? null,
        task_slug: draft.taskSlug ?? null,
        epic_key: draft.epicKey ?? null,
        start_reason: 'ping',
        chat_id: draft.chatId,
        resumed: 1,
        chat_idle_min: draft.chatIdleMin ?? null,
        runtime: draft.runtime,
        model: draft.model,
        effort: draft.effort ?? null,
        request_text: draft.requestText,
        due_at: draft.dueAt,
      },
      true,
    );
  }

  /** Marks where a chat's pings stopped, on the identity of the chat's last row. Null when the chat has no row. */
  async addStop(chatId: string, reason: PingStopReason, at: string): Promise<number | null> {
    const [last] = await this.dataSource.query<{ id: number }[]>(
      `SELECT id FROM agent_exchanges WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
      [chatId],
    );
    if (!last) {
      return null;
    }
    const rows = await this.dataSource.query<{ id: number }[]>(
      `INSERT INTO agent_exchanges (
         kind, step_stat_id, started_at, finished_at, duration_ms, request_text, response_text, end_kind, stop_reason,
         previous_id, chat_id, resumed, run_key, step, backlog, task_slug, epic_key, runtime, model, effort
       )
       SELECT 'ping-stop', 0, ?, ?, 0, '', '', 'done', ?, id, chat_id, 1, run_key, step, backlog, task_slug, epic_key,
         runtime, model, effort
       FROM agent_exchanges WHERE id = ? RETURNING id`,
      [at, at, reason, last.id],
    );
    return rows[0]?.id ?? null;
  }

  async spendOfRun(runKey: string): Promise<number> {
    return (await this.totals('run_key', runKey)).usd;
  }

  async tokensOfRun(runKey: string): Promise<number> {
    return (await this.totals('run_key', runKey)).tokens;
  }

  async spendOfTurn(turnKey: string): Promise<number> {
    return (await this.totals('turn_key', turnKey)).usd;
  }

  async tokensOfTurn(turnKey: string): Promise<number> {
    return (await this.totals('turn_key', turnKey)).tokens;
  }

  async spendOfChat(chatId: string): Promise<number> {
    return (await this.totals('chat_id', chatId)).usd;
  }

  /** What an attempt's rows cost that no stored visit holds yet. */
  async spendOfAttempt(attemptId: string): Promise<number> {
    return (await this.totals('attempt_id', attemptId, true)).usd;
  }

  /** The rows of an attempt that no stored visit holds yet, in order. */
  rowsOfAttempt(attemptId: string): Promise<AgentCallRow[]> {
    return this.dataSource.getRepository(AgentExchangeEntity).find({
      where: { attemptId, stepStatId: 0 },
      order: { id: 'ASC' },
    });
  }

  /** The cost of each of these runs, in one query. A run with no row is absent. */
  async spendOfRuns(runKeys: string[]): Promise<Map<string, number>> {
    if (runKeys.length === 0) return new Map();
    const rows: { runKey: string; usd: number | null }[] = await this.dataSource.query(
      `SELECT run_key AS runKey, SUM(own_usd) AS usd FROM agent_exchanges
       WHERE run_key IN (${runKeys.map(() => '?').join(', ')}) GROUP BY run_key`,
      runKeys,
    );
    return new Map(rows.map((row) => [row.runKey, Number(row.usd) || 0]));
  }

  /** The rows linked to a stored visit, in order. */
  rowsOfVisit(statId: number): Promise<AgentCallRow[]> {
    return this.dataSource
      .getRepository(AgentExchangeEntity)
      .find({ where: { stepStatId: statId }, order: { id: 'ASC' } });
  }

  async lastRowOfChat(chatId: string): Promise<AgentCallRow | null> {
    return this.dataSource.getRepository(AgentExchangeEntity).findOne({ where: { chatId }, order: { id: 'DESC' } });
  }

  private async totals(
    column: 'run_key' | 'turn_key' | 'chat_id' | 'attempt_id',
    value: string,
    unlinked = false,
  ): Promise<CallTotals> {
    const [row] = await this.dataSource.query<{ usd: number | null; tokens: number | null }[]>(
      `SELECT SUM(own_usd) AS usd, SUM(input_tokens + cache_read_tokens + cache_write_tokens + output_tokens) AS tokens
       FROM agent_exchanges WHERE ${column} = ?${unlinked ? ' AND step_stat_id = 0' : ''}`,
      [value],
    );
    return { usd: Number(row?.usd) || 0, tokens: Number(row?.tokens) || 0 };
  }

  /** Inserts a row from its columns. With `ignoreDuplicate` a row the unique index refuses gives null. */
  private async insert(values: Values, ignoreDuplicate: true): Promise<number | null>;
  private async insert(values: Values): Promise<number>;
  private async insert(values: Values, ignoreDuplicate = false): Promise<number | null> {
    const names = Object.keys(values);
    const rows = await this.dataSource.query<{ id: number }[]>(
      `INSERT ${ignoreDuplicate ? 'OR IGNORE ' : ''}INTO agent_exchanges (${names.join(', ')})
       VALUES (${names.map(() => '?').join(', ')}) RETURNING id`,
      names.map((name) => values[name]),
    );
    return rows[0]?.id ?? null;
  }

  /** Runs a write after the writes already queued for the row. The failure of one write does not stop the next. */
  private queued(id: number, write: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(write);
    const tail = run.catch(() => undefined);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) {
        this.queues.delete(id);
      }
    });
    return run;
  }
}
