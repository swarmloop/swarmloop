import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { DataSourceOptions } from 'typeorm';
import type { BetterSqlite3ConnectionOptions } from 'typeorm/driver/better-sqlite3/BetterSqlite3ConnectionOptions';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { compactAfterLogMigration } from './compact-database';
import { GuardedDataSource } from './guarded-data-source';
import { CommandRepository } from './command.repository';
import { CheckCommandRepository } from './check-command.repository';
import { entities } from './entities';
import { migrations } from './migrations';
import { RunRepository } from './run.repository';
import { DocumentRepository } from './document.repository';
import { VisitRepository } from './visit.repository';
import { FlowRepository } from './flow.repository';
import { EventRepository } from './event.repository';
import { CheckoutRepository } from './checkout.repository';
import { StatsRepository } from './stats.repository';
import { StepEventLog } from './step-event.log';
import { FlakyTestRepository } from './flaky-test.repository';
import { RuntimeCooldownRepository } from './runtime-cooldown.repository';
import { UserSettingRepository } from './user-setting.repository';
import { FootprintRepository } from './footprint.repository';

/** A commit is copied into the database file. The default waits for 1000 pages, so a finished status stays only in the WAL. */
export function configureDatabase(db: { pragma: (statement: string) => unknown }): void {
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 1');
}

function databaseFile(root: string): string {
  const directory = join(root, 'data');
  mkdirSync(directory, { recursive: true });
  return join(directory, 'swarmloop.sqlite');
}

export function historyDatabaseOptions(root: string): BetterSqlite3ConnectionOptions {
  return {
    type: 'better-sqlite3',
    database: databaseFile(root),
    entities,
    migrations,
    synchronize: false,
    migrationsRun: true,
    logging: false,
    prepareDatabase: configureDatabase,
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => historyDatabaseOptions(resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname)),
      dataSourceFactory: async (options) => {
        const dataSource = await new GuardedDataSource(options as DataSourceOptions).initialize();
        await compactAfterLogMigration(dataSource);
        return dataSource;
      },
    }),
    TypeOrmModule.forFeature(entities),
  ],
  providers: [
    RunRepository,
    DocumentRepository,
    VisitRepository,
    FlowRepository,
    EventRepository,
    CheckoutRepository,
    StepEventLog,
    CommandRepository,
    CheckCommandRepository,
    StatsRepository,
    RuntimeCooldownRepository,
    FlakyTestRepository,
    UserSettingRepository,
    FootprintRepository,
  ],
  exports: [
    RunRepository,
    DocumentRepository,
    VisitRepository,
    FlowRepository,
    EventRepository,
    CheckoutRepository,
    StepEventLog,
    CommandRepository,
    CheckCommandRepository,
    StatsRepository,
    RuntimeCooldownRepository,
    FlakyTestRepository,
    UserSettingRepository,
    FootprintRepository,
    TypeOrmModule,
  ],
})
export class HistoryModule {}
