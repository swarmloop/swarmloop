import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { readFileSync } from 'fs';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { GuardedDataSource } from './guarded-data-source';
import { historyDatabaseOptions } from './history.module';
import { migrations } from './migrations';

/** A newer version: `count` more migrations than the current list. */
function release(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = 1799000000000 + index;
    return class implements MigrationInterface {
      name = `Later${timestamp}`;
      async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "later_${timestamp}" ("id" integer)`);
      }
      async down(): Promise<void> {}
    };
  });
}

async function start(directory: string, later = 0): Promise<void> {
  const options = { ...historyDatabaseOptions(directory), migrations: [...migrations, ...release(later)] };
  const dataSource = new GuardedDataSource(options);
  try {
    await dataSource.initialize();
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

function tables(directory: string): string[] {
  const db = new Database(join(directory, 'data', 'swarmloop.sqlite'), { readonly: true });
  try {
    return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

function backups(directory: string): string[] {
  return readdirSync(join(directory, 'data', 'backups')).filter((name) => /\.sqlite(\.gz)?$/.test(name));
}

/** Gunzips a backup next to itself and opens it, the way `gunzip -c` restores it. */
function openBackup(directory: string, file: string): Database.Database {
  const restored = join(directory, 'restored.sqlite');
  writeFileSync(restored, gunzipSync(readFileSync(join(directory, 'data', 'backups', file))));
  return new Database(restored, { readonly: true });
}

/** A plain backup of an older version, with its time in the name. */
function oldBackup(directory: string, time: string): string {
  const name = `swarmloop-${time}.sqlite`;
  mkdirSync(join(directory, 'data', 'backups'), { recursive: true });
  writeFileSync(join(directory, 'data', 'backups', name), 'plain database');
  return name;
}

describe('migration guard', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'swarmloop-guard-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('makes no backup for a fresh database', async () => {
    await start(directory);

    expect(existsSync(join(directory, 'data', 'backups'))).toBe(false);
    expect(tables(directory)).not.toContain('release_meta');
  });

  it('backs up an existing database before a pending migration, with the session files', async () => {
    await start(directory);
    const db = new Database(join(directory, 'data', 'swarmloop.sqlite'));
    db.exec(`INSERT INTO checkouts (name, path) VALUES ('main', '/work/main')`);
    db.close();
    writeFileSync(join(directory, 'data', 'PROJ-1-plan-session.json'), '{}');

    await start(directory, 1);

    const [file] = backups(directory);
    expect(file).toMatch(/^swarmloop-\d{4}-\d\d-\d\dT.+\.sqlite\.gz$/);
    const backup = openBackup(directory, file);
    expect(backup.prepare('SELECT name FROM checkouts').all()).toEqual([{ name: 'main' }]);
    backup.close();
    expect(readdirSync(join(directory, 'data', 'backups', file.replace('.sqlite.gz', '.sessions')))).toEqual([
      'PROJ-1-plan-session.json',
    ]);
    expect(tables(directory)).toContain('later_1799000000000');
  });

  it('does not migrate when the backup fails', async () => {
    await start(directory);
    writeFileSync(join(directory, 'data', 'backups'), 'a file where the directory should be');

    await expect(start(directory, 1)).rejects.toThrow('was not migrated');

    expect(tables(directory)).not.toContain('later_1799000000000');
  });

  it('refuses an older server on a newer database and names the backup', async () => {
    await start(directory);
    await start(directory, 1);
    const [file] = backups(directory);

    const refused = start(directory);

    await expect(refused).rejects.toThrow(file);
    await expect(refused).rejects.toThrow(
      `gunzip -c ${join(directory, 'data', 'backups', file)} > ${join(directory, 'data', 'swarmloop.sqlite')}`,
    );
    await expect(refused).rejects.toThrow('Later1799000000000');
  });

  it('starts the same version again without a backup', async () => {
    await start(directory, 1);

    await expect(start(directory, 1)).resolves.toBeUndefined();
    expect(existsSync(join(directory, 'data', 'backups'))).toBe(false);
  });

  it('keeps the last 3 backups', async () => {
    await start(directory);
    for (let later = 1; later <= 5; later += 1) {
      await start(directory, later);
    }

    expect(backups(directory)).toHaveLength(3);
  });

  it('compresses an old plain backup on start, even when no migration is due', async () => {
    await start(directory);
    const name = oldBackup(directory, '2025-01-01T00-00-00-000Z');

    await start(directory);

    expect(backups(directory)).not.toContain(name);
    expect(gunzipSync(readFileSync(join(directory, 'data', 'backups', `${name}.gz`))).toString()).toBe(
      'plain database',
    );
  });

  it('only deletes a plain backup that has a compressed twin', async () => {
    await start(directory);
    const name = oldBackup(directory, '2025-01-01T00-00-00-000Z');
    writeFileSync(join(directory, 'data', 'backups', `${name}.gz`), gzipSync('already'));

    await start(directory);

    expect(gunzipSync(readFileSync(join(directory, 'data', 'backups', `${name}.gz`))).toString()).toBe('already');
    expect(backups(directory)).toEqual([`${name}.gz`]);
  });

  it('keeps the newest 3 across plain and compressed backups, with their session folders', async () => {
    await start(directory);
    const old = oldBackup(directory, '2020-01-01T00-00-00-000Z');
    oldBackup(directory, '2020-01-02T00-00-00-000Z');
    mkdirSync(join(directory, 'data', 'backups', old.replace('.sqlite', '.sessions')));
    await start(directory, 1);
    await start(directory, 2);

    expect(backups(directory)).toHaveLength(3);
    expect(backups(directory).some((name) => name.includes('2020-01-01'))).toBe(false);
    expect(existsSync(join(directory, 'data', 'backups', old.replace('.sqlite', '.sessions')))).toBe(false);
  });

  it('names a plain legacy backup with cp when it is the newest', async () => {
    await start(directory);
    await start(directory, 1);
    const [file] = backups(directory);
    rmSync(join(directory, 'data', 'backups', file));
    const plain = oldBackup(directory, '2026-01-01T00-00-00-000Z');
    writeFileSync(join(directory, 'data', 'backups', plain), 'x');

    await expect(start(directory)).rejects.toThrow(`cp `);
  });
});
