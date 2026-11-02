import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { readEnv } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { entities } from './entities';
import { HistoryService } from './history.service';

/** A commit is copied into the database file. The default waits for 1000 pages, so a finished status stays only in the WAL. */
export function configureDatabase(db: { pragma: (statement: string) => unknown }): void {
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 1');
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const root = resolveRepoRoot(readEnv(config).SWARMLOOP_ROOT, __dirname);
        const directory = join(root, 'data');
        mkdirSync(directory, { recursive: true });
        return {
          type: 'better-sqlite3' as const,
          database: join(directory, 'swarmloop.sqlite'),
          entities,
          synchronize: true,
          logging: false,
          prepareDatabase: configureDatabase,
        };
      },
    }),
    TypeOrmModule.forFeature(entities),
  ],
  providers: [HistoryService],
  exports: [HistoryService, TypeOrmModule],
})
export class HistoryModule {}
