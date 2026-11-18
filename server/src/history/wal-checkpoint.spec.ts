import { Logger } from '@nestjs/common';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { configureDatabase } from './history.module';
import { WalCheckpoint } from './wal-checkpoint';

describe('WalCheckpoint', () => {
  let directory: string;
  let dataSource: DataSource;
  let warnings: string[];
  let subject: WalCheckpoint;

  function statusInFile(): string {
    const scratch = join(directory, 'scratch.sqlite');
    copyFileSync(join(directory, 'swarmloop.sqlite'), scratch);
    const opened = new Database(scratch);
    try {
      return (opened.prepare('SELECT status FROM runs').get() as { status: string }).status;
    } finally {
      opened.close();
      rmSync(scratch, { force: true });
    }
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'swarmloop-wal-'));
    dataSource = await new DataSource({
      type: 'better-sqlite3',
      database: join(directory, 'swarmloop.sqlite'),
      prepareDatabase: configureDatabase,
      entities: [],
      migrations: [],
    }).initialize();
    await dataSource.query('CREATE TABLE runs (status TEXT)');
    await dataSource.query("INSERT INTO runs (status) VALUES ('running')");
    await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
    await dataSource.query("UPDATE runs SET status = 'done'");
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    warnings = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void warnings.push(String(message)));
    subject = new WalCheckpoint(dataSource);
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  it('checkpoints once a minute', async () => {
    subject.schedule();
    await jest.advanceTimersByTimeAsync(59_000);
    expect(statusInFile()).toBe('running');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(statusInFile()).toBe('done');
    await dataSource.query("UPDATE runs SET status = 'merged'");
    await jest.advanceTimersByTimeAsync(60_000);
    expect(statusInFile()).toBe('merged');
    await subject.onModuleDestroy();
  });

  it('checkpoints when the server stops', async () => {
    subject.schedule();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(statusInFile()).toBe('running');
    await subject.onModuleDestroy();
    expect(statusInFile()).toBe('done');
    await dataSource.query("UPDATE runs SET status = 'merged'");
    await jest.advanceTimersByTimeAsync(120_000);
    expect(statusInFile()).toBe('done');
  });

  it('checkpoints passively while another connection writes', async () => {
    const other = new Database(join(directory, 'swarmloop.sqlite'));
    try {
      other.exec('BEGIN IMMEDIATE');
      subject.schedule();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(statusInFile()).toBe('done');
      expect(warnings).toEqual([]);
      other.exec('ROLLBACK');
    } finally {
      other.close();
      await subject.onModuleDestroy();
    }
  });

  it('logs a failed checkpoint and keeps running', async () => {
    subject.schedule();
    await dataSource.destroy();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^WAL checkpoint failed:/);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(warnings).toHaveLength(2);
    await expect(subject.onModuleDestroy()).resolves.toBeUndefined();
  });
});
