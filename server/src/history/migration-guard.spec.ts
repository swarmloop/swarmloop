import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { serverVersion } from './migration-guard';
import { GuardedDataSource } from './guarded-data-source';
import { historyDatabaseOptions } from './history.module';
import { migrations } from './migrations';

/** A later release: one more migration than the current list. */
function release(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const timestamp = 1794500000000 + index;
    return class implements MigrationInterface {
      name = `Later${timestamp}`;
      async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "later_${timestamp}" ("id" integer)`);
      }
      async down(): Promise<void> {}
    };
  });
}

async function start(directory: string, version: string, later = 0): Promise<void> {
  const options = { ...historyDatabaseOptions(directory), migrations: [...migrations, ...release(later)] };
  const dataSource = new GuardedDataSource(options, version);
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
  return readdirSync(join(directory, 'data', 'backups')).filter((name) => name.endsWith('.sqlite'));
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
    await start(directory, '1.0.0');

    expect(existsSync(join(directory, 'data', 'backups'))).toBe(false);
  });

  it('backs up an existing database before a pending migration, with the session files', async () => {
    await start(directory, '1.0.0');
    const db = new Database(join(directory, 'data', 'swarmloop.sqlite'));
    db.exec(`INSERT INTO checkouts (name, path) VALUES ('main', '/work/main')`);
    db.close();
    writeFileSync(join(directory, 'data', 'PROJ-1-plan-session.json'), '{}');

    await start(directory, '2.0.0', 1);

    const [file] = backups(directory);
    expect(file).toMatch(/^swarmloop-1\.0\.0-.+\.sqlite$/);
    const backup = new Database(join(directory, 'data', 'backups', file), { readonly: true });
    expect(backup.prepare('SELECT name FROM checkouts').all()).toEqual([{ name: 'main' }]);
    backup.close();
    expect(readdirSync(join(directory, 'data', 'backups', file.replace('.sqlite', '.sessions')))).toEqual([
      'PROJ-1-plan-session.json',
    ]);
    expect(tables(directory)).toContain('later_1794500000000');
  });

  it('does not migrate when the backup fails', async () => {
    await start(directory, '1.0.0');
    writeFileSync(join(directory, 'data', 'backups'), 'a file where the directory should be');

    await expect(start(directory, '2.0.0', 1)).rejects.toThrow('was not migrated');

    expect(tables(directory)).not.toContain('later_1794500000000');
  });

  it('refuses an older server on a newer database and names the backup', async () => {
    await start(directory, '1.0.0');
    await start(directory, '2.0.0', 1);
    const [file] = backups(directory);

    const refused = start(directory, '1.0.0');

    await expect(refused).rejects.toThrow(file);
    await expect(refused).rejects.toThrow('release 2.0.0');
  });

  it('starts an older server when the newer release changed no schema', async () => {
    await start(directory, '2.0.0');

    await expect(start(directory, '1.0.0')).resolves.toBeUndefined();
  });

  it('keeps the last 3 backups', async () => {
    await start(directory, '1.0.0');
    for (let later = 1; later <= 5; later += 1) {
      await start(directory, `2.0.${later}`, later);
    }

    expect(backups(directory)).toHaveLength(3);
  });

  it('takes the release version from SWARMLOOP_VERSION', () => {
    process.env.SWARMLOOP_VERSION = 'v1.4.0';
    try {
      expect(serverVersion()).toBe('1.4.0');
    } finally {
      delete process.env.SWARMLOOP_VERSION;
    }
  });

  it.each([
    ['1.2.3-rc1', '1.2.2'],
    ['1.2.3', '1.2.3-rc1'],
    ['1.2.3-rc2', '1.2.3-rc1'],
    ['dev', '1.2.3'],
  ])('refuses a database stored by %s on a server of %s', async (stored, version) => {
    await start(directory, stored, 1);

    await expect(start(directory, version)).rejects.toThrow(`release ${stored}`);
  });

  it('starts a server that is newer than the stored prerelease', async () => {
    await start(directory, '1.2.3-rc1', 1);

    await expect(start(directory, '1.2.3', 1)).resolves.toBeUndefined();
  });
});
