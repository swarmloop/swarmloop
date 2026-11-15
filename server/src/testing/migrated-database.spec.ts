import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { SwarmloopConfigModule } from '../config/config.module';
import type { GuardedDataSource } from '../history/guarded-data-source';
import { HistoryModule } from '../history/history.module';
import { migrations } from '../history/migrations';
import { writeEnvOverrides } from './env.spec-helpers';
import { seedMigratedDatabase } from './migrated-database.spec-helpers';

const KEY = 'SWARMLOOP_TEST_DATABASE_TEMPLATE';
let root: string;

async function boot(): Promise<{ dataSource: GuardedDataSource; close: () => Promise<void> }> {
  await writeEnvOverrides(root, { SWARMLOOP_ROOT: root });
  const module = await Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule],
  }).compile();
  return { dataSource: module.get<GuardedDataSource>(DataSource), close: () => module.close() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'swarmloop-migrated-database-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migrated database template', () => {
  it('a seeded root boots with every migration recorded and none left to run', async () => {
    expect(process.env[KEY]).toBeTruthy();
    seedMigratedDatabase(root);
    const { dataSource, close } = await boot();
    try {
      expect(dataSource.migrated).toEqual([]);
      const rows: unknown[] = await dataSource.query('SELECT * FROM migrations');
      expect(rows).toHaveLength(migrations.length);
      expect(await dataSource.showMigrations()).toBe(false);
    } finally {
      await close();
    }
  });

  it('an unset template value leaves boot to run the migrations', async () => {
    const saved = process.env[KEY];
    delete process.env[KEY];
    try {
      seedMigratedDatabase(root);
      expect(existsSync(join(root, 'data', 'swarmloop.sqlite'))).toBe(false);
      const { dataSource, close } = await boot();
      try {
        expect(dataSource.migrated).toHaveLength(migrations.length);
      } finally {
        await close();
      }
    } finally {
      if (saved !== undefined) process.env[KEY] = saved;
    }
  });

  it('an existing database is left as it was', () => {
    const file = join(root, 'data', 'swarmloop.sqlite');
    mkdirSync(join(root, 'data'));
    writeFileSync(file, 'mine');
    seedMigratedDatabase(root);
    expect(readFileSync(file, 'utf8')).toBe('mine');
  });
});
