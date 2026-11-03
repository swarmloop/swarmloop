import { join } from 'path';
import { DataSource } from 'typeorm';
import { loadEnvFile } from '../config/load-env';
import { resolveRepoRoot } from '../config/repo-root';
import { historyDatabaseOptions } from './history.module';

// Read by the TypeORM CLI from dist/ (see the migration scripts in package.json). The server loads the same .env itself.
loadEnvFile(join(resolveRepoRoot(undefined, __dirname), '.env'));

export const dataSource = new DataSource(
  historyDatabaseOptions(resolveRepoRoot(process.env.SWARMLOOP_ROOT, __dirname)),
);
