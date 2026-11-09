import { join } from 'path';
import { loadEnvFile } from '../config/load-env';
import { rawEnv } from '../config/process-env';
import { resolveRepoRoot } from '../config/repo-root';
import { GuardedDataSource } from './guarded-data-source';
import { historyDatabaseOptions } from './history.module';

// Read by the TypeORM CLI from dist/ (see the migration scripts in package.json). The server loads the same .env itself.
loadEnvFile(join(resolveRepoRoot(undefined, __dirname), '.env'));

export const dataSource = new GuardedDataSource(
  historyDatabaseOptions(resolveRepoRoot(rawEnv().SWARMLOOP_ROOT, __dirname)),
);
