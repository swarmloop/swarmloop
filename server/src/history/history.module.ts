import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { BetterSqlite3ConnectionOptions } from 'typeorm/driver/better-sqlite3/BetterSqlite3ConnectionOptions';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { entities } from './entities';
import { HistoryService } from './history.service';
import { migrations } from './migrations';
import { RunRepository } from './run.repository';
import { DocumentRepository } from './document.repository';
import { VisitRepository } from './visit.repository';
import { FlowRepository } from './flow.repository';
import { EventRepository } from './event.repository';
import { CheckoutRepository } from './checkout.repository';

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
    }),
    TypeOrmModule.forFeature(entities),
  ],
  providers: [
    HistoryService,
    RunRepository,
    DocumentRepository,
    VisitRepository,
    FlowRepository,
    EventRepository,
    CheckoutRepository,
  ],
  exports: [
    HistoryService,
    RunRepository,
    DocumentRepository,
    VisitRepository,
    FlowRepository,
    EventRepository,
    CheckoutRepository,
    TypeOrmModule,
  ],
})
export class HistoryModule {}
