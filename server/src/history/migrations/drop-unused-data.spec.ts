import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { compactAfterLogMigration } from '../compact-database';
import { GuardedDataSource } from '../guarded-data-source';
import { historyDatabaseOptions } from '../history.module';
import { DropUnusedData1796100000000 } from './1796100000000-drop-unused-data';
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

async function columnsOf(dataSource: DataSource, table: string): Promise<string[]> {
  return (await dataSource.query<Column[]>(`PRAGMA table_info("${table}")`)).map((column) => column.name);
}

async function tablesOf(dataSource: DataSource): Promise<string[]> {
  const rows = await dataSource.query<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type = 'table'`);
  return rows.map((row) => row.name);
}

async function seedOldDatabase(directory: string, deleteLogsByHand: boolean): Promise<void> {
  const old = new DataSource({
    ...historyDatabaseOptions(directory),
    migrations: migrations.slice(0, migrations.indexOf(DropUnusedData1796100000000)),
  });
  await old.initialize();
  try {
    await insert(old, 'runtime_cooldowns', { runtime: 'claude', until: 'later', reset_known: 1 });
    await insert(old, 'deny_paths', { pattern: '.env' });
    const outcomes = ['{"merged":true}', '{"closed":true}', null];
    for (const [index, outcome] of outcomes.entries()) {
      const id = index + 1;
      await insert(old, 'runs', {
        id,
        key: `run-${id}`,
        merge_outcome: outcome,
        attempts_qa: 2,
        requirements_via: 'agent',
        issue_tracker: 'jira',
      });
      if (!deleteLogsByHand || outcome === null) {
        await insert(old, 'documents', { run_id: id, kind: 'log', body: `log ${id}` });
      }
    }
    await insert(old, 'documents', { run_id: 1, kind: 'plan', body: 'plan' });
  } finally {
    await old.destroy();
  }
}

async function upgrade(directory: string): Promise<GuardedDataSource> {
  return new GuardedDataSource(historyDatabaseOptions(directory)).initialize();
}

describe('DropUnusedData', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'swarmloop-drop-unused-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['a database with all of them', false],
    ['a database whose log documents a person already deleted by hand', true],
  ])('drops the tables and columns and the finished runs logs on %s', async (_name, byHand) => {
    await seedOldDatabase(directory, byHand);
    const dataSource = await upgrade(directory);
    try {
      expect(await tablesOf(dataSource)).not.toContain('runtime_cooldowns');
      expect(await tablesOf(dataSource)).not.toContain('deny_paths');
      const columns = await columnsOf(dataSource, 'runs');
      for (const dropped of ['attempts_qa', 'requirements_via', 'issue_tracker']) {
        expect(columns).not.toContain(dropped);
      }
      const logs = await dataSource.query<{ run_id: number }[]>(`SELECT run_id FROM documents WHERE kind = 'log'`);
      expect(logs).toEqual([{ run_id: 3 }]);
      const kept = await dataSource.query<{ body: string }[]>(`SELECT body FROM documents WHERE kind = 'plan'`);
      expect(kept).toEqual([{ body: 'plan' }]);
      expect(await dataSource.query(`SELECT key FROM runs ORDER BY id`)).toEqual([
        { key: 'run-1' },
        { key: 'run-2' },
        { key: 'run-3' },
      ]);
    } finally {
      await dataSource.destroy();
    }
  });

  it('migrates an empty database', async () => {
    const dataSource = await upgrade(directory);
    try {
      expect(await tablesOf(dataSource)).not.toContain('deny_paths');
      expect(await columnsOf(dataSource, 'runs')).not.toContain('attempts_qa');
    } finally {
      await dataSource.destroy();
    }
  });

  it('compacts the database once after the upgrade and not on the next start', async () => {
    await seedOldDatabase(directory, false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const upgraded = await upgrade(directory);
    try {
      await compactAfterLogMigration(upgraded);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Database compacted: .* freed$/));
    } finally {
      await upgraded.destroy();
    }
    log.mockClear();
    const again = await upgrade(directory);
    try {
      expect(again.migrated).toEqual([]);
      await compactAfterLogMigration(again);
      expect(log).not.toHaveBeenCalled();
    } finally {
      await again.destroy();
    }
  });
});
