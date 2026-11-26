import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type {
  CallTimelineEntry,
  CallTimelineKind,
  CallTimelineScope,
  CallTotalsBy,
  CallTotalsLine,
  KeepWarmChat,
  KeepWarmView,
} from '../contract/agent-calls';
import type { ModelPrice } from './agent-call';

const SUMS = `SUM(own_usd) AS usd, COUNT(*) AS calls, SUM(input_tokens) AS inputTokens,
  SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_tokens) AS cacheWriteTokens,
  SUM(output_tokens) AS outputTokens`;

/** The condition that keeps one step's rows, or nothing when no step is asked for. It binds one value. */
function stepIs(asked: boolean, prefix = ''): string {
  return asked ? ` AND ${prefix}step = ?` : '';
}

/** The rows of backlog turns, once for each key their ties name. */
function tiedTo(field: 'task' | 'epic', asked: boolean): string {
  return `WITH tied AS (
    SELECT DISTINCT e.id AS id, json_extract(j.value, '$.${field}') AS k
    FROM agent_exchanges e, json_each(CASE WHEN json_valid(e.ties) THEN e.ties ELSE '[]' END) j
    WHERE e.turn_key IS NOT NULL${stepIs(asked, 'e.')})
  SELECT k AS key, NULL AS part, 1 AS backlogTurns, ${SUMS}
  FROM tied JOIN agent_exchanges ON agent_exchanges.id = tied.id WHERE k IS NOT NULL GROUP BY k`;
}

function groupedBy(column: string, asked: boolean, extra = ''): string {
  return `SELECT ${column} AS key, NULL AS part, 0 AS backlogTurns, ${SUMS}
    FROM agent_exchanges WHERE ${column} IS NOT NULL AND kind != 'ping-stop'${extra}${stepIs(asked)} GROUP BY ${column}`;
}

/** The queries of each grouping. Each holds the step condition once, so a step narrows every line of the grouping. */
const TOTALS: Record<CallTotalsBy, (asked: boolean) => string[]> = {
  task: (asked) => [groupedBy('task_slug', asked, ' AND turn_key IS NULL'), tiedTo('task', asked)],
  epic: (asked) => [
    groupedBy('epic_key', asked, ' AND turn_key IS NULL'),
    `SELECT epic_key AS key, run_key AS part, 0 AS backlogTurns, ${SUMS} FROM agent_exchanges
     WHERE epic_key IS NOT NULL AND run_key IS NOT NULL AND run_key != epic_key AND turn_key IS NULL AND kind != 'ping-stop'${stepIs(asked)}
     GROUP BY epic_key, run_key`,
    tiedTo('epic', asked),
  ],
  step: (asked) => [groupedBy('step', asked)],
  level: (asked) => [groupedBy('planner_level', asked)],
  backlog: (asked) => [groupedBy('backlog', asked)],
};

const TIMELINE_COLUMN: Record<CallTimelineScope, string> = { task: 'task_slug', step: 'step', epic: 'epic_key' };

/** A scope of the keep-warm figures: the calls and pings of one task, epic or step, or all of them. */
interface KeepWarmScope {
  task?: string;
  epic?: string;
  step?: string;
}

interface PingSums {
  chatId: string;
  pings: number;
  hits: number;
  misses: number;
  cost: number;
}

interface ResumedCall {
  chatId: string;
  model: string;
  cacheRead: number;
  prices: string | null;
  pings: number;
  pingCost: number;
}

function number(value: unknown): number {
  return Number(value) || 0;
}

/** Read-only SQL over the log. Totals, timelines and keep-warm figures are worked out when asked and stored nowhere. */
@Injectable()
export class AgentCallQueries {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** The sums of each key of a grouping; with `step`, only the rows of that step, e.g. what implement cost on each epic. */
  async totals(by: CallTotalsBy, step?: string): Promise<CallTotalsLine[]> {
    const lines: CallTotalsLine[] = [];
    for (const sql of TOTALS[by](step !== undefined)) {
      const rows = await this.dataSource.query<Record<string, unknown>[]>(sql, step === undefined ? [] : [step]);
      for (const row of rows) {
        lines.push({
          key: row.key as string,
          part: row.part as string | null,
          backlogTurns: row.backlogTurns === 1,
          usd: number(row.usd),
          calls: number(row.calls),
          inputTokens: number(row.inputTokens),
          cacheReadTokens: number(row.cacheReadTokens),
          cacheWriteTokens: number(row.cacheWriteTokens),
          outputTokens: number(row.outputTokens),
        });
      }
    }
    return lines;
  }

  /** Every row of a task, step or epic, in the order the calls started. */
  async timeline(scope: CallTimelineScope, key: string): Promise<CallTimelineEntry[]> {
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT id, started_at AS startedAt, step, runtime, model, effort, chat_id AS chatId, end_kind AS end,
         own_usd AS usd, parent_id AS parentId, previous_id AS previousId, replaces_id AS replacesId,
         CASE
           WHEN kind IN ('ping', 'ping-stop', 'helper') THEN kind
           WHEN replaces_id IS NOT NULL THEN 'failover'
           WHEN resumed = 1 THEN 'resume'
           ELSE 'new-chat'
         END AS kind
       FROM agent_exchanges WHERE ${TIMELINE_COLUMN[scope]} = ? ORDER BY started_at, id`,
      [key],
    );
    return rows.map((row) => ({
      id: number(row.id),
      startedAt: String(row.startedAt),
      kind: row.kind as CallTimelineKind,
      step: (row.step as string | null) ?? null,
      runtime: (row.runtime as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      effort: (row.effort as string | null) ?? null,
      chatId: (row.chatId as string | null) ?? null,
      end: String(row.end),
      usd: number(row.usd),
      parentId: (row.parentId as number | null) ?? null,
      previousId: (row.previousId as number | null) ?? null,
      replacesId: (row.replacesId as number | null) ?? null,
    }));
  }

  /**
   * Pings, hits (a ping that wrote at most a tenth of what it read), misses, their cost and the saving.
   * The saving of a call that resumed a chat after a pause above `ttlMinutes` with pings in between is what its
   * first request read from the cache, priced at write minus read, less what those pings cost. A row keeps its first
   * request's cache read apart from the sum of its requests. Pings of a chat with no later call are cost only.
   */
  async keepWarm(ttlMinutes: number, scope: KeepWarmScope = {}): Promise<KeepWarmView> {
    const [where, params] = scopeWhere(scope, 'e');
    const pings = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT e.chat_id AS chatId, COUNT(*) AS pings,
         SUM(e.end_kind = 'done' AND e.cache_write_tokens * 10 <= e.cache_read_tokens) AS hits,
         SUM(e.end_kind = 'done' AND e.cache_write_tokens * 10 > e.cache_read_tokens) AS misses,
         SUM(e.own_usd) AS cost
       FROM agent_exchanges e WHERE e.kind = 'ping' AND e.chat_id IS NOT NULL${where} GROUP BY e.chat_id`,
      params,
    );
    const calls = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT e.chat_id AS chatId, e.model AS model, COALESCE(e.first_cache_read_tokens, 0) AS cacheRead, e.prices AS prices,
         (SELECT COUNT(*) FROM agent_exchanges g WHERE g.kind = 'ping' AND g.chat_id = e.chat_id
            AND g.started_at > p.started_at AND g.started_at < e.started_at) AS pings,
         (SELECT COALESCE(SUM(g.own_usd), 0) FROM agent_exchanges g WHERE g.kind = 'ping' AND g.chat_id = e.chat_id
            AND g.started_at > p.started_at AND g.started_at < e.started_at) AS pingCost
       FROM agent_exchanges e
       JOIN agent_exchanges p ON p.id = (
         SELECT q.id FROM agent_exchanges q WHERE q.kind = 'call' AND q.chat_id = e.chat_id AND q.started_at < e.started_at
         ORDER BY q.started_at DESC, q.id DESC LIMIT 1)
       WHERE e.kind = 'call' AND e.resumed = 1 AND e.chat_id IS NOT NULL
         AND (julianday(e.started_at) - julianday(p.finished_at)) * 1440 > ?${where}`,
      [ttlMinutes, ...params],
    );
    const chats = new Map<string, KeepWarmChat>();
    for (const row of pings as unknown as PingSums[]) {
      chats.set(row.chatId, {
        chatId: row.chatId,
        pings: number(row.pings),
        hits: number(row.hits),
        misses: number(row.misses),
        cost: number(row.cost),
        saving: 0,
      });
    }
    for (const call of calls as unknown as ResumedCall[]) {
      const saved = savingOf(call);
      const chat = chats.get(call.chatId);
      if (chat && saved !== null && number(call.pings) > 0) {
        chat.saving += saved - number(call.pingCost);
      }
    }
    const all = [...chats.values()];
    const sum = (field: 'pings' | 'hits' | 'misses' | 'cost' | 'saving') =>
      all.reduce((total, chat) => total + chat[field], 0);
    return {
      ttlMinutes,
      pings: sum('pings'),
      hits: sum('hits'),
      misses: sum('misses'),
      cost: sum('cost'),
      saving: sum('saving'),
      chats: all,
    };
  }
}

/** The cache read of the call's first request at the price of a write less a read; null when its prices are unknown. */
function savingOf(call: ResumedCall): number | null {
  const prices = call.prices ? (JSON.parse(call.prices) as Record<string, ModelPrice>)[call.model] : undefined;
  const read = prices?.cacheReadPerMillion;
  const write = prices?.cacheWritePerMillion;
  if (typeof read !== 'number' || typeof write !== 'number') {
    return null;
  }
  return (number(call.cacheRead) * (write - read)) / 1_000_000;
}

function scopeWhere(scope: KeepWarmScope, alias: string): [string, string[]] {
  const columns: [string | undefined, string][] = [
    [scope.task, 'task_slug'],
    [scope.epic, 'epic_key'],
    [scope.step, 'step'],
  ];
  const used = columns.filter((entry): entry is [string, string] => entry[0] !== undefined);
  return [used.map(([, column]) => ` AND ${alias}.${column} = ?`).join(''), used.map(([value]) => value)];
}
