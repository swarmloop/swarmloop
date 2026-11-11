import { Logger } from '@nestjs/common';
import { existsSync, statfsSync, statSync } from 'fs';
import { dirname } from 'path';
import type { GuardedDataSource } from './guarded-data-source';

const logger = new Logger('HistoryDatabase');

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function freeBytes(directory: string): number {
  const { bavail, bsize } = statfsSync(directory);
  return bavail * bsize;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * VACUUM once after the migration that emptied the stored logs ran: the file only shrinks then. It needs room for a
 * copy of the database and its WAL, so it skips with a log line when the disk has less.
 */
export async function compactAfterLogMigration(
  dataSource: GuardedDataSource,
  free: (directory: string) => number = freeBytes,
): Promise<void> {
  const file = dataSource.options.database;
  if (
    typeof file !== 'string' ||
    !dataSource.migrated.some((migration) => migration.name?.startsWith('EmptyLogBodies'))
  ) {
    return;
  }
  const before = sizeOf(file);
  const needed = before + sizeOf(`${file}-wal`);
  const available = free(dirname(file));
  if (available < needed) {
    logger.warn(`Database not compacted: ${mib(available)} free, ${mib(needed)} needed`);
    return;
  }
  await dataSource.query('VACUUM');
  await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
  const after = sizeOf(file);
  logger.log(`Database compacted: ${mib(before)} to ${mib(after)}, ${mib(Math.max(0, before - after))} freed`);
}
