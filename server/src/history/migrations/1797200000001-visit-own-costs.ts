import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { Logger } from '@nestjs/common';
import type { MigrationInterface, QueryRunner } from 'typeorm';

interface Totals {
  usd: number;
  tokensIn: number;
  tokensOut: number;
}

interface StoredVisit extends Totals {
  id: number;
  runId: number;
  key: string;
  step: string;
  attemptId: string | null;
  exchangeId: number;
  chatId: string;
  resumed: number;
  startedAt: string;
}

/** A visit's session total when its old row and its events settle it, null otherwise. A new row has none. */
interface Settled {
  total: Totals | null;
}

const KEYS = ['usd', 'tokensIn', 'tokensOut'] as const;
const ZERO: Totals = { usd: 0, tokensIn: 0, tokensOut: 0 };
const EPSILON = 1e-9;

/** A total at least the previous reported total is that and this visit; a smaller one is a new session, whole. */
function since(total: number, previous: number): number {
  return total >= previous ? total - previous : total;
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= EPSILON;
}

function sameTotals(left: Totals, right: Totals): boolean {
  return KEYS.every((key) => sameNumber(left[key], right[key]));
}

function stored(visit: StoredVisit): Totals {
  return { usd: visit.usd, tokensIn: visit.tokensIn, tokensOut: visit.tokensOut };
}

function plus(left: Totals, right: Totals): Totals {
  return {
    usd: left.usd + right.usd,
    tokensIn: left.tokensIn + right.tokensIn,
    tokensOut: left.tokensOut + right.tokensOut,
  };
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The session total of one component: the stored value plus the sum before it, when the stored value is not below that sum. A smaller one is told by the events. */
function settleComponent(storedValue: number, sum: number, event: number | undefined): number | null {
  if (storedValue >= sum - EPSILON) {
    return storedValue + sum;
  }
  if (event === undefined) {
    return null;
  }
  if (sameNumber(event, storedValue)) {
    return storedValue;
  }
  return sameNumber(event, storedValue + sum) ? storedValue + sum : null;
}

/** The session total of a visit, null when the row cannot be told from a row an older migration rewrote. */
function settleTotals(visit: StoredVisit, sum: Totals, events: Totals | undefined): Totals | null {
  if (!visit.resumed) {
    return stored(visit);
  }
  const total = { ...ZERO };
  for (const key of KEYS) {
    const value = settleComponent(visit[key], sum[key], events?.[key]);
    if (value === null) {
      return null;
    }
    total[key] = value;
  }
  return total;
}

/** What the visit's output file says: its own part, and the session totals of its last result line. */
interface FromFile {
  part: Totals;
  reported: Totals | null;
}

function resultLines(path: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const parsed = record(JSON.parse(line));
      if (parsed?.type === 'result') {
        lines.push(parsed);
      }
    } catch {
      // A line that is no JSON is not a result line.
    }
  }
  return lines;
}

function ownPartOf(line: Record<string, unknown>): Totals | null {
  const entries = Object.values(record(line.model_usage_since_last_result) ?? {})
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (!entries.some((entry) => number(entry.costUSD) !== null)) {
    return null;
  }
  const sum = (key: string): number => entries.reduce((total, entry) => total + (number(entry[key]) ?? 0), 0);
  return {
    usd: sum('costUSD'),
    tokensIn: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'),
    tokensOut: sum('outputTokens'),
  };
}

function reportedOf(line: Record<string, unknown>): Totals | null {
  const usd = number(line.total_cost_usd);
  const usage = record(line.usage);
  const output = number(usage?.output_tokens);
  if (usd === null || usage === null || output === null) {
    return null;
  }
  const prompt = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce(
    (total, key) => total + (number(usage[key]) ?? 0),
    0,
  );
  return { usd, tokensIn: prompt, tokensOut: output };
}

/** The part of a result line: as it is when it reports its own, else its session total against `previous`. Null when there is nothing to take it against. */
function partOfLine(line: Record<string, unknown>, previous: Totals | null): Totals | null {
  const own = ownPartOf(line);
  if (own) {
    return own;
  }
  const reported = reportedOf(line);
  if (!reported || !previous) {
    return null;
  }
  return {
    usd: since(reported.usd, previous.usd),
    tokensIn: since(reported.tokensIn, previous.tokensIn),
    tokensOut: since(reported.tokensOut, previous.tokensOut),
  };
}

/** The visit's part from all its result lines, each against the one before it, the first against `previous` when the visit resumes. */
function readOutput(root: string | null, visit: StoredVisit, previous: Totals | null): FromFile | null {
  if (root === null || !visit.attemptId) {
    return null;
  }
  const path = join(root, 'data', `${visit.key}-${visit.step}-${visit.attemptId}-output.txt`);
  if (!existsSync(path)) {
    return null;
  }
  const lines = resultLines(path);
  let reference = visit.resumed ? previous : ZERO;
  let part = ZERO;
  let reported: Totals | null = null;
  for (const line of lines) {
    const next = partOfLine(line, reference);
    if (!next) {
      return null;
    }
    part = plus(part, next);
    reported = reportedOf(line);
    reference = reported ?? reference;
  }
  return lines.length > 0 ? { part, reported } : null;
}

/** The agent.finished events of every launch of an attempt, summed by run and attempt. */
async function readEvents(queryRunner: QueryRunner): Promise<Map<string, Totals>> {
  const rows = (await queryRunner.query(
    `SELECT run_id AS runId, attempt_id AS attemptId, payload FROM step_events WHERE kind = 'agent.finished'`,
  )) as { runId: number; attemptId: string; payload: string }[];
  const events = new Map<string, Totals>();
  for (const row of rows) {
    try {
      const payload = record(JSON.parse(row.payload));
      const name = `${row.runId}/${row.attemptId}`;
      events.set(
        name,
        plus(events.get(name) ?? ZERO, {
          usd: number(payload?.usd) ?? 0,
          tokensIn: number(payload?.tokensIn) ?? 0,
          tokensOut: number(payload?.tokensOut) ?? 0,
        }),
      );
    } catch {
      // An event with no readable payload tells nothing.
    }
  }
  return events;
}

async function readVisits(queryRunner: QueryRunner): Promise<StoredVisit[]> {
  return (await queryRunner.query(
    `SELECT s.id AS id, s.run_id AS runId, r.key AS key, s.step AS step, s.attempt_id AS attemptId,
            s.usd AS usd, s.tokens_in AS tokensIn, s.tokens_out AS tokensOut,
            e.id AS exchangeId, e.chat_id AS chatId, e.resumed AS resumed, e.started_at AS startedAt
     FROM step_stats s
     JOIN runs r ON r.id = s.run_id
     JOIN agent_exchanges e ON e.id = (
       SELECT MAX(id) FROM agent_exchanges WHERE step_stat_id = s.id AND chat_id IS NOT NULL
     )
     ORDER BY s.id`,
  )) as StoredVisit[];
}

/** The running sum of a chat's stored parts before each old visit, by the rule the older migration used. */
function sumsBefore(visits: StoredVisit[]): Map<number, Totals> {
  const running = new Map<string, Totals>();
  const before = new Map<number, Totals>();
  for (const visit of visits) {
    const sum = (visit.resumed ? running.get(visit.chatId) : undefined) ?? ZERO;
    before.set(visit.id, sum);
    running.set(visit.chatId, plus(sum, stored(visit)));
  }
  return before;
}

function settle(visit: StoredVisit, context: { old: boolean; sum: Totals; events: Totals | undefined }): Settled {
  return { total: context.old ? settleTotals(visit, context.sum, context.events) : null };
}

interface Change {
  visit: StoredVisit;
  part: Totals;
  reported: Totals | null;
  source: 'events' | 'file' | 'kept';
}

/** A visit's part and reported totals: from its events, else from its output file, else kept as stored with none. */
function partOf(visit: StoredVisit, settled: Settled, previous: Totals | null, root: string | null): Change {
  if (settled.total) {
    const before = visit.resumed ? previous : null;
    const part = {
      usd: since(settled.total.usd, before?.usd ?? 0),
      tokensIn: since(settled.total.tokensIn, before?.tokensIn ?? 0),
      tokensOut: since(settled.total.tokensOut, before?.tokensOut ?? 0),
    };
    return { visit, part, reported: settled.total, source: 'events' };
  }
  const file = readOutput(root, visit, previous);
  if (file) {
    return { visit, part: file.part, reported: file.reported, source: 'file' };
  }
  return { visit, part: stored(visit), reported: null, source: 'kept' };
}

/** Each visit's own part, by the rule: its reported total minus the previous reported total of its chat when not smaller, else the whole. */
function walk(visits: StoredVisit[], settled: Map<number, Settled>, root: string | null): Change[] {
  const previous = new Map<string, Totals | null>();
  const changes: Change[] = [];
  for (const visit of visits) {
    const change = partOf(visit, settled.get(visit.id) as Settled, previous.get(visit.chatId) ?? null, root);
    previous.set(visit.chatId, change.reported);
    changes.push(change);
  }
  return changes;
}

async function write(queryRunner: QueryRunner, changes: Change[]): Promise<Map<number, number>> {
  const moved = new Map<number, number>();
  for (const { visit, part, reported } of changes) {
    if (!sameTotals(part, stored(visit))) {
      await queryRunner.query(`UPDATE step_stats SET usd = ?, tokens_in = ?, tokens_out = ? WHERE id = ?`, [
        part.usd,
        part.tokensIn,
        part.tokensOut,
        visit.id,
      ]);
      moved.set(visit.runId, (moved.get(visit.runId) ?? 0) + part.usd - visit.usd);
    }
    if (reported) {
      await queryRunner.query(
        `UPDATE agent_exchanges SET reported_usd = ?, reported_tokens_in = ?, reported_tokens_out = ? WHERE id = ?`,
        [reported.usd, reported.tokensIn, reported.tokensOut, visit.exchangeId],
      );
    }
  }
  return moved;
}

function report(changes: Change[]): string {
  const line = (source: Change['source'], changed: boolean): string => {
    const rows = changes.filter(
      (change) => change.source === source && !sameTotals(change.part, stored(change.visit)) === changed,
    );
    const dollars = rows.reduce((sum, change) => sum + Math.abs(change.part.usd - change.visit.usd), 0);
    return `${rows.length} rows $${dollars.toFixed(2)}`;
  };
  const kept = changes.filter((change) => change.source === 'kept');
  const keptDollars = kept.reduce((sum, change) => sum + change.visit.usd, 0);
  return `rewrote ${line('events', true)} from events, ${line('file', true)} from output files; kept ${kept.length} rows $${keptDollars.toFixed(2)} unchanged for lack of an event or a usable file`;
}

/**
 * A resumed session's reported total can restart at its first resume, so the older migration's running sum left
 * visits that still hold a session total. This writes each visit of a resumed chat as its own part: its reported
 * total minus the previous reported total of its chat when not smaller, else the whole. Rows the older migration
 * rewrote are told from the ones it left by their agent.finished events, then by the visit's output file, which also settles a newer row; a row
 * neither settles is kept. The rule is written here and not shared with the app, because a migration must not
 * change when the app code later does.
 */
export class VisitOwnCosts1797200000001 implements MigrationInterface {
  private readonly logger = new Logger(VisitOwnCosts1797200000001.name);

  async up(queryRunner: QueryRunner): Promise<void> {
    const visits = await readVisits(queryRunner);
    const boundary = (
      (await queryRunner.query(`SELECT MIN(created_at) AS at FROM visit_starts`)) as { at: string | null }[]
    )[0]?.at;
    const old = visits.filter((visit) => !boundary || visit.startedAt < boundary);
    const sums = sumsBefore(old);
    const events = await readEvents(queryRunner);
    const database = queryRunner.connection.options.database;
    const root = typeof database === 'string' && database !== ':memory:' ? dirname(dirname(database)) : null;
    const settled = new Map<number, Settled>();
    for (const visit of visits) {
      const sum = sums.get(visit.id);
      settled.set(
        visit.id,
        settle(visit, {
          old: sum !== undefined,
          sum: sum ?? ZERO,
          events: events.get(`${visit.runId}/${visit.attemptId}`),
        }),
      );
    }
    const changes = walk(visits, settled, root);
    const moved = await write(queryRunner, changes);
    for (const [runId, delta] of moved) {
      await queryRunner.query(`UPDATE runs SET spent_usd = spent_usd + ? WHERE id = ?`, [delta, runId]);
    }
    this.logger.log(`Visit costs: ${report(changes)}`);
  }

  async down(): Promise<void> {
    // The session totals the old rows held cannot be told from the parts now, so there is nothing to restore.
  }
}
