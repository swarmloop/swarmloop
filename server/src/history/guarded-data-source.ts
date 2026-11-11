import type { DataSourceOptions, Migration } from 'typeorm';
import { SystemClock } from '../core/clock';
import type { Clock } from '../core/clock';
import { DataSource } from 'typeorm';
import { guardMigration } from './migration-guard';

/** The only way the history database migrates, for the server and the TypeORM CLI: `runMigrations` is the one door. */
export class GuardedDataSource extends DataSource {
  constructor(
    options: DataSourceOptions,
    private readonly clock: Clock = new SystemClock(),
  ) {
    super(options);
  }

  /** The migrations the last `runMigrations` applied. */
  migrated: Migration[] = [];

  override async runMigrations(options?: Parameters<DataSource['runMigrations']>[0]): Promise<Migration[]> {
    await guardMigration(this, this.clock.iso());
    this.migrated = await super.runMigrations(options);
    return this.migrated;
  }
}
