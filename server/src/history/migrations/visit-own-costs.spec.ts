import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { GuardedDataSource } from '../guarded-data-source';
import { historyDatabaseOptions } from '../history.module';
import { VisitCostDeltas1797000000001 } from './1797000000001-visit-cost-deltas';
import { VisitOwnCosts1797200000001 } from './1797200000001-visit-own-costs';
import { migrations } from './index';

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

type Row = Record<string, string | number | null>;

const OLD = '2026-11-20T10:00:00.000Z';
const BOUNDARY = '2026-11-22T09:38:00.000Z';
const NEW = '2026-11-22T10:00:00.000Z';

async function insert(dataSource: DataSource, table: string, values: Row): Promise<void> {
  const columns = await dataSource.query<Column[]>(`PRAGMA table_info("${table}")`);
  const row: Row = { ...values };
  for (const column of columns) {
    if (column.name === 'id' || column.name in row || column.notnull === 0 || column.dflt_value !== null) {
      continue;
    }
    row[column.name] = /int/i.test(column.type) ? 0 : '';
  }
  const names = Object.keys(row);
  await dataSource.query(
    `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((name) => row[name]),
  );
}

interface Seed {
  id: number;
  run: number;
  chat: string;
  resumed: boolean;
  /** The total the visit reported, stored as it was before any rewrite. */
  totals: [number, number, number];
  /** The agent.finished event of the visit, absent for none. */
  event?: boolean;
  startedAt?: string;
}

async function visit(dataSource: DataSource, seed: Seed): Promise<void> {
  const [usd, tokensIn, tokensOut] = seed.totals;
  const attempt = `attempt-${seed.id}`;
  await insert(dataSource, 'step_stats', {
    id: seed.id,
    run_id: seed.run,
    step: 'implement',
    attempt_id: attempt,
    usd,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  });
  await insert(dataSource, 'agent_exchanges', {
    step_stat_id: seed.id,
    chat_id: seed.chat,
    resumed: seed.resumed ? 1 : 0,
    started_at: seed.startedAt ?? OLD,
  });
  if (seed.event !== false) {
    await insert(dataSource, 'step_events', {
      run_id: seed.run,
      attempt_id: attempt,
      step: 'implement',
      seq: seed.id,
      kind: 'agent.finished',
      payload: JSON.stringify({ usd, tokensIn, tokensOut }),
    });
  }
}

/** A result line that reports its own part apart from the session total. */
function resultLine(own: number, total: number): string {
  return JSON.stringify({
    type: 'result',
    total_cost_usd: total,
    usage: { input_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 4 },
    model_usage_since_last_result: {
      m: {
        costUSD: own,
        inputTokens: 20,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        outputTokens: 3,
      },
    },
  });
}

async function seedOldDatabase(directory: string): Promise<void> {
  const old = new DataSource({
    ...historyDatabaseOptions(directory),
    migrations: migrations.slice(0, migrations.indexOf(VisitCostDeltas1797000000001)),
  });
  await old.initialize();
  try {
    for (const id of [1, 2, 3, 4, 5, 6, 7]) {
      await insert(old, 'runs', { id, key: `run-${id}`, spent_usd: 100 + id });
    }
    await insert(old, 'visit_starts', {
      run_id: 1,
      step: 'implement',
      attempt_id: 'started',
      started_by: 'test',
      created_at: BOUNDARY,
    });
    // Chat 1: the totals restart at the first resume, so the older migration left every resumed row.
    const restart: [number, number, number][] = [
      [1.37, 1370, 137],
      [0.1, 100, 10],
      [0.18, 180, 18],
      [0.26, 260, 26],
      [0.33, 330, 33],
    ];
    for (const [index, totals] of restart.entries()) {
      await visit(old, { id: 1 + index, run: 1, chat: 'restart', resumed: index > 0, totals });
    }
    // Chat 2: the older migration rewrote the last row, 8 / 500 / 50 stored as 2 / 100 / 5.
    await visit(old, { id: 6, run: 2, chat: 'rewritten', resumed: false, totals: [1, 100, 10] });
    await visit(old, { id: 7, run: 2, chat: 'rewritten', resumed: true, totals: [3, 250, 30] });
    await visit(old, { id: 8, run: 2, chat: 'rewritten', resumed: true, totals: [6, 400, 45] });
    await visit(old, { id: 9, run: 2, chat: 'rewritten', resumed: true, totals: [8, 500, 50] });
    // Chat 3: a left row of 2 / 100 / 5 between a total of 8 / 500 / 50 and one of 2.5 / 150 / 9.
    await visit(old, { id: 10, run: 3, chat: 'left', resumed: false, totals: [8, 500, 50] });
    await visit(old, { id: 11, run: 3, chat: 'left', resumed: true, totals: [2, 100, 5] });
    await visit(old, { id: 12, run: 3, chat: 'left', resumed: true, totals: [2.5, 150, 9] });
    // Chat 4: a resumed row with no events, whose output file reports its own part. Chat 5: one with neither.
    await visit(old, { id: 13, run: 4, chat: 'file', resumed: false, totals: [1, 100, 10] });
    await visit(old, { id: 14, run: 4, chat: 'file', resumed: true, totals: [0.4, 40, 4], event: false });
    await visit(old, { id: 15, run: 4, chat: 'none', resumed: false, totals: [1, 100, 10] });
    await visit(old, { id: 16, run: 4, chat: 'none', resumed: true, totals: [0.4, 40, 4], event: false });
    // Chat 6: a resumed visit stored after the first visit start holds its own part already.
    await visit(old, { id: 17, run: 5, chat: 'after', resumed: false, totals: [1, 1000, 100] });
    await visit(old, { id: 18, run: 5, chat: 'after', resumed: true, totals: [0.26, 260, 26] });
    await visit(old, { id: 19, run: 5, chat: 'after', resumed: true, totals: [0.3, 300, 30], startedAt: NEW });
    // A run whose visit does not change.
    await visit(old, { id: 20, run: 6, chat: 'alone', resumed: false, totals: [4, 400, 40] });
    // A chat after the first visit start: a visit that starts it, then a visit of three tries that end on an API error.
    // The older migration turns the second total of 5.28 / 5280 / 528 into the part 3.96 / 3960 / 396.
    await visit(old, {
      id: 21,
      run: 7,
      chat: 'outage',
      resumed: false,
      totals: [1.32, 1320, 132],
      event: false,
      startedAt: NEW,
    });
    await visit(old, {
      id: 22,
      run: 7,
      chat: 'outage',
      resumed: true,
      totals: [5.28, 5280, 528],
      event: false,
      startedAt: NEW,
    });
  } finally {
    await old.destroy();
  }
}

interface Snapshot {
  visits: { id: number; usd: number; tokens_in: number; tokens_out: number }[];
  runs: { id: number; spent_usd: number }[];
}

async function snapshot(options: ReturnType<typeof historyDatabaseOptions>): Promise<Snapshot> {
  const dataSource = await new GuardedDataSource(options).initialize();
  try {
    return {
      visits: await dataSource.query(`SELECT id, usd, tokens_in, tokens_out FROM step_stats ORDER BY id`),
      runs: await dataSource.query(`SELECT id, spent_usd FROM runs ORDER BY id`),
    };
  } finally {
    await dataSource.destroy();
  }
}

describe('VisitOwnCosts', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'swarmloop-visit-own-'));
    mkdirSync(join(directory, 'data'), { recursive: true });
    const file = join(directory, 'data', 'run-4-implement-attempt-14-output.txt');
    writeFileSync(file, `process started\n${resultLine(0.2, 0.6)}\n${resultLine(0.1, 0.7)}\n`);
    const session = { type: 'result', total_cost_usd: 1.32, usage: { input_tokens: 1320, output_tokens: 132 } };
    writeFileSync(join(directory, 'data', 'run-7-implement-attempt-21-output.txt'), `${JSON.stringify(session)}\n`);
    const failed = JSON.stringify({
      type: 'result',
      is_error: true,
      terminal_reason: 'api_error',
      total_cost_usd: 1.32,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    writeFileSync(
      join(directory, 'data', 'run-7-implement-attempt-22-output.txt'),
      `${failed}\n${failed}\n${failed}\n`,
    );
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function migrate(): Promise<{ before: Snapshot; after: Snapshot }> {
    await seedOldDatabase(directory);
    const before = await snapshot({
      ...historyDatabaseOptions(directory),
      migrations: migrations.slice(0, migrations.indexOf(VisitOwnCosts1797200000001)),
    });
    return { before, after: await snapshot(historyDatabaseOptions(directory)) };
  }

  it('writes every visit of a resumed chat as its own part', async () => {
    const { after } = await migrate();
    const parts = after.visits.map((row) => [row.id, row.usd, row.tokens_in, row.tokens_out]);
    const near = (id: number): number[] => parts.find((part) => part[0] === id) as number[];
    expect(parts.map((part) => part[1]).slice(0, 5)).toEqual([
      expect.closeTo(1.37, 9),
      expect.closeTo(0.1, 9),
      expect.closeTo(0.08, 9),
      expect.closeTo(0.08, 9),
      expect.closeTo(0.07, 9),
    ]);
    expect(parts.slice(0, 5).map((part) => part[2])).toEqual([1370, 100, 80, 80, 70]);
    expect(parts.slice(0, 5).map((part) => part[3])).toEqual([137, 10, 8, 8, 7]);
    // The rewritten chat keeps its parts, and the left row after a total of 8 gives 0.5 / 50 / 4.
    expect(parts.slice(5, 9)).toEqual([
      [6, 1, 100, 10],
      [7, 2, 150, 20],
      [8, 3, 150, 15],
      [9, 2, 100, 5],
    ]);
    expect(near(10)).toEqual([10, 8, 500, 50]);
    expect(near(11)).toEqual([11, 2, 100, 5]);
    expect(near(12)[1]).toBeCloseTo(0.5, 9);
    expect(near(12).slice(2)).toEqual([50, 4]);
  });

  it('takes the part of a row no event settles from its output file, and keeps a row with neither', async () => {
    const { after } = await migrate();
    const row = (id: number) => after.visits.find((visit) => visit.id === id);
    expect(row(14)?.usd).toBeCloseTo(0.3, 9);
    expect(row(14)?.tokens_in).toBe(70);
    expect(row(14)?.tokens_out).toBe(6);
    expect(row(16)).toMatchObject({ usd: 0.4, tokens_in: 40, tokens_out: 4 });
  });

  it('keeps a resumed visit stored after the first visit start', async () => {
    const { after } = await migrate();
    const row = (id: number) => after.visits.find((visit) => visit.id === id);
    expect(row(18)).toMatchObject({ usd: 0.26, tokens_in: 260, tokens_out: 26 });
    expect(row(19)).toMatchObject({ usd: 0.3, tokens_in: 300, tokens_out: 30 });
  });

  it('gives the tries of a visit that end on an API error only their own cost, from its output file', async () => {
    const { before, after } = await migrate();
    const row = (snapshotOf: Snapshot, id: number) => snapshotOf.visits.find((visit) => visit.id === id);
    expect(row(before, 22)?.usd).toBeCloseTo(3.96, 9);
    expect(row(after, 21)).toMatchObject({ usd: 1.32, tokens_in: 1320, tokens_out: 132 });
    expect(row(after, 22)).toMatchObject({ usd: 0, tokens_in: 0, tokens_out: 0 });
    const spent = (snapshotOf: Snapshot) => snapshotOf.runs.find((run) => run.id === 7)?.spent_usd as number;
    expect(spent(after)).toBeCloseTo(spent(before) - 3.96, 9);
  });

  it('fills the reported totals of the rows whose totals are known and leaves a kept row without', async () => {
    await migrate();
    const dataSource = await new GuardedDataSource(historyDatabaseOptions(directory)).initialize();
    try {
      const rows = await dataSource.query<
        {
          step_stat_id: number;
          reported_usd: number | null;
          reported_tokens_in: number | null;
          reported_tokens_out: number | null;
        }[]
      >(`SELECT step_stat_id, reported_usd, reported_tokens_in, reported_tokens_out FROM agent_exchanges ORDER BY id`);
      const reported = (id: number) => rows.find((row) => row.step_stat_id === id);
      expect(reported(5)).toMatchObject({ reported_usd: 0.33, reported_tokens_in: 330, reported_tokens_out: 33 });
      expect(reported(14)).toMatchObject({ reported_usd: 0.7, reported_tokens_in: 45, reported_tokens_out: 4 });
      expect(reported(16)).toMatchObject({ reported_usd: null, reported_tokens_in: null, reported_tokens_out: null });
      expect(reported(19)).toMatchObject({ reported_usd: null });
    } finally {
      await dataSource.destroy();
    }
  });

  it('moves the spent_usd of a run by what its visits changed and leaves the other runs', async () => {
    const { before, after } = await migrate();
    for (const run of after.runs) {
      const change = (snapshotOf: Snapshot, id: number): number =>
        snapshotOf.visits
          .filter(
            (row) =>
              (row.id <= 5
                ? 1
                : row.id <= 9
                  ? 2
                  : row.id <= 12
                    ? 3
                    : row.id <= 16
                      ? 4
                      : row.id <= 19
                        ? 5
                        : row.id <= 20
                          ? 6
                          : 7) === id,
          )
          .reduce((sum, row) => sum + row.usd, 0);
      const moved = change(after, run.id) - change(before, run.id);
      const spentBefore = before.runs.find((item) => item.id === run.id)?.spent_usd as number;
      expect(run.spent_usd).toBeCloseTo(spentBefore + moved, 9);
    }
    expect(after.runs.find((run) => run.id === 6)?.spent_usd).toBe(before.runs.find((run) => run.id === 6)?.spent_usd);
    expect(after.runs.find((run) => run.id === 5)?.spent_usd).toBe(before.runs.find((run) => run.id === 5)?.spent_usd);
  });
});
