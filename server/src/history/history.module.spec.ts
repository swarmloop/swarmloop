import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { configureDatabase } from './history.module';

function statusIn(path: string): string {
  const opened = new Database(path);
  try {
    return (opened.prepare('SELECT status FROM runs').get() as { status: string }).status;
  } finally {
    opened.close();
  }
}

/** Opens a configured database whose last commit ('done') sits only in the WAL, and runs the body with it. */
async function withWalHoldingDone(
  body: (db: Database.Database, directory: string) => Promise<void> | void,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'swarmloop-db-'));
  const db = new Database(join(directory, 'swarmloop.sqlite'));
  try {
    configureDatabase(db);
    db.exec('CREATE TABLE runs (status TEXT)');
    db.prepare('INSERT INTO runs (status) VALUES (?)').run('running');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.prepare('UPDATE runs SET status = ?').run('done');
    await body(db, directory);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('configureDatabase', () => {
  it('commits in WAL with synchronous NORMAL and the default autocheckpoint', async () => {
    await withWalHoldingDone((db) => {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1);
      expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000);
    });
  });

  it('keeps a committed status when the database is reopened after the process ended without a checkpoint', async () => {
    await withWalHoldingDone((_db, directory) => {
      const crashed = join(directory, 'crashed');
      mkdirSync(crashed);
      copyFileSync(join(directory, 'swarmloop.sqlite'), join(crashed, 'swarmloop.sqlite'));
      expect(statusIn(join(crashed, 'swarmloop.sqlite'))).toBe('running');
      copyFileSync(join(directory, 'swarmloop.sqlite-wal'), join(crashed, 'swarmloop.sqlite-wal'));
      expect(statusIn(join(crashed, 'swarmloop.sqlite'))).toBe('done');
    });
  });

  it('keeps a committed status in a backup made through the API while the wal holds it', async () => {
    await withWalHoldingDone(async (db, directory) => {
      const backup = join(directory, 'backup.sqlite');
      await db.backup(backup);
      expect(statusIn(backup)).toBe('done');
    });
  });
});
