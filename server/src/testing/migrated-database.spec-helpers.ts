import 'reflect-metadata';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { GuardedDataSource } from '../history/guarded-data-source';
import { historyDatabaseOptions } from '../history/history.module';

/** Builds a history database under `directory` with every migration applied and returns its path. */
export async function buildMigratedDatabase(directory: string): Promise<string> {
  const dataSource = new GuardedDataSource(historyDatabaseOptions(directory));
  await dataSource.initialize();
  await dataSource.destroy();
  return join(directory, 'data', 'swarmloop.sqlite');
}

/** Puts a copy of the migrated template at the database path of `root`, unless the template is unset or a database is already there. */
export function seedMigratedDatabase(root: string): void {
  const template = process.env.SWARMLOOP_TEST_DATABASE_TEMPLATE;
  const target = join(root, 'data', 'swarmloop.sqlite');
  if (!template || existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(template, target);
}
