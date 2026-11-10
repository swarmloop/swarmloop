import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import type { DataSource } from 'typeorm';
import { SwarmloopError } from '../core/swarmloop-error';

const BACKUPS = 'backups';
const KEPT_BACKUPS = 3;
const BACKUP_FILE = /^swarmloop-.+\.sqlite$/;
const SESSION_FILE = /-session\.json$/;
/** `2026-01-01T00-00-00-000Z`: the same length for every backup, so the names sort by time. */
const TIME_LENGTH = 24;

function backupTime(file: string): string {
  return basename(file, '.sqlite').slice(-TIME_LENGTH);
}

/** The backup files in `data/backups`, newest first. */
function listBackups(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => BACKUP_FILE.test(name))
    .sort((a, b) => backupTime(b).localeCompare(backupTime(a)));
}

async function tableExists(dataSource: DataSource, name: string): Promise<boolean> {
  const rows = await dataSource.query<unknown[]>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [
    name,
  ]);
  return rows.length > 0;
}

async function unknownMigrations(dataSource: DataSource): Promise<string[]> {
  if (!(await tableExists(dataSource, 'migrations'))) {
    return [];
  }
  const known = new Set(dataSource.migrations.map((migration) => migration.name ?? migration.constructor.name));
  const applied = await dataSource.query<{ name: string }[]>(`SELECT name FROM migrations`);
  return applied.map((row) => row.name).filter((name) => !known.has(name));
}

function refuse(unknown: string[], backups: string): SwarmloopError {
  const newest = listBackups(backups)[0];
  const restore = newest
    ? `To run this version, restore the backup ${join(backups, newest)}; otherwise start the newer version.`
    : `No backup is in ${backups}: start the newer version.`;
  return new SwarmloopError(
    `The database was migrated by a newer version: this server does not know its migrations ${unknown.join(', ')}. ${restore}`,
  );
}

/** The session files of the runs, next to the backup. Nothing is written when there are none. */
function copySessions(data: string, destination: string): void {
  const sessions = readdirSync(data).filter((name) => SESSION_FILE.test(name));
  if (sessions.length === 0) {
    return;
  }
  mkdirSync(destination, { recursive: true });
  for (const name of sessions) {
    copyFileSync(join(data, name), join(destination, name));
  }
}

async function backUp(dataSource: DataSource, data: string, now: string): Promise<void> {
  const backups = join(data, BACKUPS);
  const stem = `swarmloop-${now.replace(/[:.]/g, '-')}`;
  try {
    mkdirSync(backups, { recursive: true });
    await (
      dataSource.driver as unknown as { databaseConnection: { backup(file: string): Promise<unknown> } }
    ).databaseConnection.backup(join(backups, `${stem}.sqlite`));
    copySessions(data, join(backups, `${stem}.sessions`));
  } catch (error) {
    throw new SwarmloopError(
      `The database was not migrated: its backup in ${backups} failed (${error instanceof Error ? error.message : String(error)}). Fix that, then start again.`,
    );
  }
  for (const stale of listBackups(backups).slice(KEPT_BACKUPS)) {
    rmSync(join(backups, stale), { force: true });
    rmSync(join(backups, `${basename(stale, '.sqlite')}.sessions`), { recursive: true, force: true });
  }
}

/**
 * Runs before every migration. A server refuses a database that a newer version migrated, and a database that has
 * data is backed up first. A failed backup throws, so nothing migrates without one.
 */
export async function guardMigration(dataSource: DataSource, now: string): Promise<void> {
  const data = dirname(String(dataSource.options.database));
  const unknown = await unknownMigrations(dataSource);
  if (unknown.length > 0) {
    throw refuse(unknown, join(data, BACKUPS));
  }
  if ((await tableExists(dataSource, 'runs')) && (await dataSource.showMigrations())) {
    await backUp(dataSource, data, now);
  }
}
