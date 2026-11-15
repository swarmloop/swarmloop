import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, type Migration } from 'typeorm';
import { boot, save } from '../../testing/runs.spec-helpers';
import { seedMigratedDatabase } from '../../testing/migrated-database.spec-helpers';
import { compactAfterLogMigration } from '../compact-database';
import { DocumentEntity } from '../entities';
import type { GuardedDataSource } from '../guarded-data-source';
import { repositoryVisit } from '../repository.spec-helpers';
import { RunRepository } from '../run.repository';
import { VisitRepository } from '../visit.repository';
import { EmptyLogBodies1794900000000 } from './1794900000000-empty-log-bodies';

async function withApp(test: (app: Awaited<ReturnType<typeof boot>>, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-empty-logs-'));
  seedMigratedDatabase(root);
  const app = await boot(root);
  try {
    await mkdir(join(root, 'data'), { recursive: true });
    await test(app, root);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function storedLog(app: Awaited<ReturnType<typeof boot>>, key: string, attemptId: string | null, body: string) {
  const run = await save(app.get(RunRepository), key, 'implement', 'waiting');
  const visits = app.get(VisitRepository);
  const stat = await visits.finishVisit(run, {
    ...repositoryVisit(),
    step: 'implement',
    documents: [{ kind: 'log', fileName: '', body }],
  });
  stat.attemptId = attemptId;
  await visits.saveStat(stat);
}

async function migrate(app: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const runner = app.get(DataSource).createQueryRunner();
  try {
    await new EmptyLogBodies1794900000000().up(runner);
  } finally {
    await runner.release();
  }
}

const bodies = async (app: Awaited<ReturnType<typeof boot>>) =>
  (
    await app
      .get(DataSource)
      .getRepository(DocumentEntity)
      .find({ order: { id: 'ASC' } })
  ).map((item) => item.body);

describe('EmptyLogBodies migration', () => {
  it('empties a stored log whose attempt file exists and keeps one without a file or an attempt', async () => {
    await withApp(async (app, root) => {
      await storedLog(app, 'proj-1', 'att-1', 'in the file\n');
      await storedLog(app, 'proj-2', 'att-2', 'no file\n');
      await storedLog(app, 'proj-3', null, 'no attempt\n');
      await writeFile(join(root, 'data', 'proj-1-implement-att-1-output.txt'), 'in the file\n');
      await writeFile(join(root, 'data', 'proj-3-implement-other-output.txt'), 'another visit\n');
      await migrate(app);
      expect(await bodies(app)).toEqual(['', 'no file\n', 'no attempt\n']);
    });
  });
});

describe('compactAfterLogMigration', () => {
  const migrated = { name: 'EmptyLogBodies1794900000000' } as Migration;

  /** Collects what the compaction logs and warns, instead of counting calls on the spies. */
  function recordLogs(): { logs: string[]; warnings: string[] } {
    const logs: string[] = [];
    const warnings: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logs.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    return { logs, warnings };
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs VACUUM once the migration ran and logs how much the file shrank', async () => {
    await withApp(async (app) => {
      const dataSource = app.get<GuardedDataSource>(DataSource);
      dataSource.migrated = [migrated];
      const { logs } = recordLogs();
      await compactAfterLogMigration(dataSource);
      expect(logs).toEqual([expect.stringMatching(/^Database compacted: .* MiB to .* MiB, .* MiB freed$/)]);
    });
  });

  it('skips, and says so, when the disk has less room than the database needs', async () => {
    await withApp(async (app) => {
      const dataSource = app.get<GuardedDataSource>(DataSource);
      dataSource.migrated = [migrated];
      const { logs, warnings } = recordLogs();
      await compactAfterLogMigration(dataSource, () => 0);
      expect(warnings).toEqual([expect.stringContaining('Database not compacted')]);
      expect(logs).toEqual([]);
    });
  });

  it.each(['VACUUM', 'PRAGMA wal_checkpoint(TRUNCATE)'])(
    'resolves and warns when %s fails, e.g. on a full disk',
    async (failing) => {
      await withApp(async (app) => {
        const dataSource = app.get<GuardedDataSource>(DataSource);
        dataSource.migrated = [migrated];
        const { logs, warnings } = recordLogs();
        jest.spyOn(dataSource, 'query').mockImplementation(async (sql: string) => {
          if (sql === failing) {
            throw new Error('database or disk is full');
          }
          return [];
        });
        await expect(compactAfterLogMigration(dataSource)).resolves.toBeUndefined();
        expect(warnings).toEqual(['Database not compacted: database or disk is full']);
        expect(logs).toEqual([]);
      });
    },
  );

  it('accepts an async reader of the free bytes', async () => {
    await withApp(async (app) => {
      const dataSource = app.get<GuardedDataSource>(DataSource);
      dataSource.migrated = [migrated];
      const { logs, warnings } = recordLogs();
      await compactAfterLogMigration(dataSource, async () => 0);
      expect(warnings).toEqual([expect.stringContaining('Database not compacted')]);
      expect(logs).toEqual([]);
    });
  });

  it('does nothing when that migration did not run in this start', async () => {
    await withApp(async (app) => {
      const dataSource = app.get<GuardedDataSource>(DataSource);
      dataSource.migrated = [];
      const { logs, warnings } = recordLogs();
      await compactAfterLogMigration(dataSource);
      expect(logs).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });
});
