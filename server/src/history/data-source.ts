import { applySettings, assertSettings, readSettings } from '../config/load-env';
import { rawEnv } from '../config/process-env';
import { resolveRepoRoot } from '../config/repo-root';
import { GuardedDataSource } from './guarded-data-source';
import { historyDatabaseOptions } from './history.module';

// Load before migration options read raw settings, just as the server does.
const settings = readSettings();
const error = assertSettings(settings);
if (error) throw new Error(error);
applySettings(settings);

export const dataSource = new GuardedDataSource(
  historyDatabaseOptions(resolveRepoRoot(rawEnv().SWARMLOOP_ROOT, __dirname)),
);
