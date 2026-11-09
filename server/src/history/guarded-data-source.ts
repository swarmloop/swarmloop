import type { DataSourceOptions, Migration } from 'typeorm';
import { SystemClock } from '../core/clock';
import type { Clock } from '../core/clock';
import { DataSource } from 'typeorm';
import { guardMigration, recordVersion, serverVersion } from './migration-guard';

/** The only way the history database migrates, for the server and the TypeORM CLI: `runMigrations` is the one door. */
export class GuardedDataSource extends DataSource {
  constructor(
    options: DataSourceOptions,
    private readonly version: string = serverVersion(),
    private readonly clock: Clock = new SystemClock(),
  ) {
    super(options);
  }

  override async runMigrations(options?: Parameters<DataSource['runMigrations']>[0]): Promise<Migration[]> {
    await guardMigration(this, this.version, this.clock.iso());
    const ran = await super.runMigrations(options);
    await recordVersion(this, this.version);
    return ran;
  }
}
