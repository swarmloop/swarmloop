import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { configureDatabase } from './history.module';

describe('configureDatabase', () => {
  it('keeps a committed status in the database file when the wal is left behind', () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarmloop-db-'));
    const path = join(directory, 'swarmloop.sqlite');
    const db = new Database(path);
    try {
      configureDatabase(db);
      db.exec('CREATE TABLE runs (status TEXT)');
      db.prepare('INSERT INTO runs (status) VALUES (?)').run('running');
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.prepare('UPDATE runs SET status = ?').run('done');
      const copy = join(directory, 'copy.sqlite');
      copyFileSync(path, copy);
      const opened = new Database(copy);
      try {
        const row = opened.prepare('SELECT status FROM runs').get() as { status: string };
        expect(row.status).toBe('done');
      } finally {
        opened.close();
      }
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
