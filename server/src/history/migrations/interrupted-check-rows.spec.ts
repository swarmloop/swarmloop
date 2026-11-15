import 'reflect-metadata';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { boot, save } from '../../testing/runs.spec-helpers';
import { CheckCommandRepository } from '../check-command.repository';
import { repositoryVisit } from '../repository.spec-helpers';
import { RunRepository } from '../run.repository';
import { VisitRepository } from '../visit.repository';
import { InterruptedCheckRows1795900000000 } from './1795900000000-interrupted-check-rows';

type App = Awaited<ReturnType<typeof boot>>;

async function withApp(test: (app: App) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-check-rows-'));
  const app = await boot(root);
  try {
    await test(app);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

const STARTED = '2026-01-01T00:00:00.000Z';

async function row(app: App, runId: number, attemptId: string, status: string, endedAt: string | null = null) {
  await app.get(CheckCommandRepository).add({
    runId,
    attemptId,
    repo: 'demo',
    command: 'npm test',
    commandIndex: 0,
    status,
    startedAt: STARTED,
    endedAt,
    exitCode: endedAt ? 1 : null,
  });
}

async function migrate(app: App): Promise<void> {
  const runner = app.get(DataSource).createQueryRunner();
  try {
    await new InterruptedCheckRows1795900000000().up(runner);
  } finally {
    await runner.release();
  }
}

const rowsOf = async (app: App, runId: number) =>
  (await app.get(CheckCommandRepository).list(runId)).map((item) => [item.status, item.exitCode, item.endedAt]);

describe('InterruptedCheckRows migration', () => {
  it('ends an open row of an ended attempt at the finish of that visit', async () => {
    await withApp(async (app) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'checks', 'waiting');
      const stat = await app.get(VisitRepository).finishVisit(run, { ...repositoryVisit(), step: 'checks' });
      stat.attemptId = 'att-1';
      await app.get(VisitRepository).saveStat(stat);
      await row(app, run.id, 'att-1', 'running');
      await row(app, run.id, 'att-1', 'waiting');
      await migrate(app);
      expect(await rowsOf(app, run.id)).toEqual([
        ['interrupted', null, stat.finishedAt],
        ['interrupted', null, stat.finishedAt],
      ]);
    });
  });

  it('ends an open row of an attempt with no visit at its own start, never at the time of the migration', async () => {
    await withApp(async (app) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'checks', 'waiting');
      await row(app, run.id, 'att-none', 'running');
      await migrate(app);
      expect(await rowsOf(app, run.id)).toEqual([['interrupted', null, STARTED]]);
    });
  });

  it('leaves passed, failed and skipped rows as they are', async () => {
    await withApp(async (app) => {
      const run = await save(app.get(RunRepository), 'proj-1', 'checks', 'waiting');
      await row(app, run.id, 'att-1', 'passed', '2026-01-01T00:01:00.000Z');
      await row(app, run.id, 'att-1', 'failed', '2026-01-01T00:02:00.000Z');
      await row(app, run.id, 'att-1', 'skipped');
      await migrate(app);
      expect(await rowsOf(app, run.id)).toEqual([
        ['passed', 1, '2026-01-01T00:01:00.000Z'],
        ['failed', 1, '2026-01-01T00:02:00.000Z'],
        ['skipped', null, null],
      ]);
    });
  });

  it('leaves the rows of the active attempt of a run to the settler', async () => {
    await withApp(async (app) => {
      const run = await app.get(RunRepository).begin('proj-1', 'checks');
      await row(app, run.id, run.activeAttempt!, 'running');
      await migrate(app);
      expect(await rowsOf(app, run.id)).toEqual([['running', null, null]]);
    });
  });
});
