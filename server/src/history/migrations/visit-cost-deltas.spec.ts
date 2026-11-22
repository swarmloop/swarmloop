import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { GuardedDataSource } from '../guarded-data-source';
import { historyDatabaseOptions } from '../history.module';
import { VisitCostDeltas1797000000001 } from './1797000000001-visit-cost-deltas';
import { migrations } from './index';

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

type Row = Record<string, string | number | null>;

/** Insert a row into the old schema, filling every required column the caller left out. */
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

/** One stored visit and the exchange that names its chat. Visits are numbered in the order they are stored. */
async function visit(
  dataSource: DataSource,
  seed: {
    id: number;
    run: number;
    chat: string | null;
    resumed: boolean;
    usd: number;
    tokensIn: number;
    tokensOut: number;
  },
): Promise<void> {
  await insert(dataSource, 'step_stats', {
    id: seed.id,
    run_id: seed.run,
    usd: seed.usd,
    tokens_in: seed.tokensIn,
    tokens_out: seed.tokensOut,
  });
  await insert(dataSource, 'agent_exchanges', {
    step_stat_id: seed.id,
    chat_id: seed.chat,
    resumed: seed.resumed ? 1 : 0,
  });
}

async function seedOldDatabase(directory: string): Promise<void> {
  const old = new DataSource({
    ...historyDatabaseOptions(directory),
    migrations: migrations.slice(0, migrations.indexOf(VisitCostDeltas1797000000001)),
  });
  await old.initialize();
  try {
    for (const id of [1, 2, 3]) {
      await insert(old, 'runs', { id, key: `run-${id}`, spent_usd: 0 });
    }
    // Chat A over runs 1 and 2: three visits stored as session totals, a fourth that starts a new session.
    await visit(old, { id: 1, run: 1, chat: 'a', resumed: false, usd: 1, tokensIn: 100, tokensOut: 10 });
    await visit(old, { id: 2, run: 1, chat: 'a', resumed: true, usd: 3, tokensIn: 250, tokensOut: 30 });
    await visit(old, { id: 3, run: 2, chat: 'b', resumed: false, usd: 5, tokensIn: 500, tokensOut: 50 });
    await visit(old, { id: 4, run: 2, chat: 'a', resumed: true, usd: 6, tokensIn: 400, tokensOut: 45 });
    // A resumed visit whose total is below the recorded one is its own.
    await visit(old, { id: 5, run: 2, chat: 'a', resumed: true, usd: 2, tokensIn: 100, tokensOut: 5 });
    await visit(old, { id: 6, run: 2, chat: 'a', resumed: false, usd: 7, tokensIn: 70, tokensOut: 7 });
    await visit(old, { id: 7, run: 3, chat: null, resumed: false, usd: 9, tokensIn: 90, tokensOut: 9 });
  } finally {
    await old.destroy();
  }
}

describe('VisitCostDeltas', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'swarmloop-visit-cost-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('rewrites the visits of a resumed chat as deltas in id order and leaves the others', async () => {
    await seedOldDatabase(directory);
    const dataSource = await new GuardedDataSource(historyDatabaseOptions(directory)).initialize();
    try {
      const rows = await dataSource.query<{ id: number; usd: number; tokens_in: number; tokens_out: number }[]>(
        `SELECT id, usd, tokens_in, tokens_out FROM step_stats ORDER BY id`,
      );
      expect(rows.map((row) => [row.id, row.usd, row.tokens_in, row.tokens_out])).toEqual([
        [1, 1, 100, 10],
        [2, 2, 150, 20],
        [3, 5, 500, 50],
        [4, 3, 150, 15],
        [5, 2, 100, 5],
        [6, 7, 70, 7],
        [7, 9, 90, 9],
      ]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('sets spent_usd of a run with a rewritten visit to the sum of its visits and leaves the other runs', async () => {
    await seedOldDatabase(directory);
    const dataSource = await new GuardedDataSource(historyDatabaseOptions(directory)).initialize();
    try {
      const runs = await dataSource.query<{ id: number; spent_usd: number }[]>(
        `SELECT id, spent_usd FROM runs ORDER BY id`,
      );
      expect(runs).toEqual([
        { id: 1, spent_usd: 3 },
        { id: 2, spent_usd: 17 },
        { id: 3, spent_usd: 0 },
      ]);
    } finally {
      await dataSource.destroy();
    }
  });
});
