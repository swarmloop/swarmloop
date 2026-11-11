import { Logger } from '@nestjs/common';
import { existsSync, statSync } from 'fs';
import { dirname } from 'path';
import { freeBytes } from '../core/free-bytes';
import type { GuardedDataSource } from './guarded-data-source';

const logger = new Logger('HistoryDatabase');

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * VACUUM once after the migration that emptied the stored logs ran: the file only shrinks then. It needs room for a
 * copy of the database and its WAL, so it skips with a log line when the disk has less. A failed compaction is logged
 * and skipped: the database stays as it was and the server starts.
 */
export async function compactAfterLogMigration(
  dataSource: GuardedDataSource,
  free: (directory: string) => number | Promise<number> = freeBytes,
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
  let after: number;
  try {
    const available = await free(dirname(file));
    if (available < needed) {
      logger.warn(`Database not compacted: ${mib(available)} free, ${mib(needed)} needed`);
      return;
    }
    await dataSource.query('VACUUM');
    await dataSource.query('PRAGMA wal_checkpoint(TRUNCATE)');
    after = sizeOf(file);
  } catch (error) {
    logger.warn(`Database not compacted: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  logger.log(`Database compacted: ${mib(before)} to ${mib(after)}, ${mib(Math.max(0, before - after))} freed`);
}
