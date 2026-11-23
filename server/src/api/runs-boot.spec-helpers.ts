import { boot } from '../testing/runs.spec-helpers';
import { seedMigratedDatabase } from '../testing/migrated-database.spec-helpers';

type BootArguments = Parameters<typeof boot>;

/** Boots the runs test module on a database copied from the migrated template, so no migration runs per test. */
export async function seededBoot(
  root: string,
  pipeline?: BootArguments[1],
  folders?: BootArguments[2],
  env?: BootArguments[3],
) {
  seedMigratedDatabase(root);
  return boot(root, pipeline, folders, env);
}
