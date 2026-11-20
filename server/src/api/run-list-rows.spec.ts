import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthService } from '../auth/auth.service';
import { Clock } from '../core/clock';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { LiveHub } from '../live/live.hub';
import { CommandService } from '../pipeline/command.service';
import { ContainerGate } from '../sandbox/container-gate';
import { visit } from '../testing/runs.spec-helpers';
import { LiveGateway } from './live.gateway';
import { pageOf } from './run-list-page';
import { RunListRows } from './run-list-rows';
import { freshView, runOf, seedRuns, SEEDED } from './run-list-rows.spec-helpers';
import { RunQueriesService } from './run-queries.service';
import { seededBoot } from './runs-boot.spec-helpers';

const NOW = '2026-11-12T10:00:00Z';

async function withApp(body: (app: Awaited<ReturnType<typeof seededBoot>>) => Promise<void>): Promise<void> {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-run-list-rows-')));
  // The estimates move with the clock, and these specs compare lists read at different moments.
  const frozen = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(NOW));
  try {
    await body(app);
  } finally {
    frozen.mockRestore();
    await app.close();
  }
}

const backlogFor = (name: string) => ({
  name,
  owner: 'ada',
  repositories: ['web'],
  mergeMode: 'green' as const,
  paused: false,
  createdAt: NOW,
});

const taskIn = (backlogId: number, milestoneId: number | null, runKey: string | null) => ({
  backlogId,
  milestoneId,
  slug: 'one',
  title: 'One',
  description: 'Do it',
  repositories: ['web'],
  covers: [],
  depends: [],
  files: [],
  proof: [],
  manual: false,
  fixesMain: null,
  status: 'running' as const,
  runKey,
  note: '',
  runNow: false,
  mergeOk: false,
  merged: {},
  madeBy: 'person' as const,
  position: 1,
  createdAt: NOW,
});

describe('RunListRows', () => {
  it('recomputes only the changed run and the parent of a subtask', () =>
    withApp(async (app) => {
      await seedRuns(app, 400);
      const rows = app.get(RunListRows);
      const documents = app.get(DocumentRepository);

      const first = await rows.read();
      expect(first.view.runs).toHaveLength(400);
      expect(first.recomputed).toBe(400);
      expect((await rows.read()).recomputed).toBe(0);

      await documents.putDocument(await runOf(app, SEEDED.plain), 'requirements', 'changed');
      expect((await rows.read()).recomputed).toBe(1);

      const child = await runOf(app, SEEDED.open);
      await app.get(RunRepository).saveRun(child);
      expect((await rows.read()).recomputed).toBe(2);
    }));

  it('keeps a list equal to a fresh build after changes, a new run, a removed run and a merged subtask', () =>
    withApp(async (app) => {
      await seedRuns(app, 400);
      const rows = app.get(RunListRows);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      await rows.read();
      const same = async () => expect((await rows.read()).view).toEqual(await freshView(app));

      await documents.putDocument(await runOf(app, SEEDED.untitled), 'requirements', 'Another\n');
      await same();

      const open = await runOf(app, SEEDED.open);
      open.status = 'failed';
      open.currentStep = 'checks';
      await runs.saveRun(open);
      await same();

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await app.get(CommandService).accept('answer', SEEDED.plain, {}, { run: () => held.then(() => null) });
      await same();
      release();
      await app.get(CommandService).idle();
      await same();

      await app.get(VisitRepository).finishVisit(await runOf(app, SEEDED.plain), {
        ...visit('implement', 'done'),
        durationMs: 4000,
      });
      await same();

      const backlogs = app.get(BacklogRepository);
      const backlog = await backlogs.saveBacklog(backlogFor('swarmloop'));
      const third = await backlogs.saveMilestone({
        backlogId: backlog.id as number,
        number: 3,
        title: 'Third',
        goal: '',
        status: 'active',
        createdAt: NOW,
      });
      const fourth = await backlogs.saveMilestone({
        backlogId: backlog.id as number,
        number: 4,
        title: 'Fourth',
        goal: '',
        status: 'active',
        createdAt: NOW,
      });
      const saved = await backlogs.saveTask(taskIn(backlog.id as number, third.id as number, 'plain-2'));
      await same();
      await backlogs.transaction((writers) =>
        writers.saveTask({ ...taskIn(backlog.id as number, fourth.id as number, 'plain-2'), id: saved.id }),
      );
      await same();

      await runs.openWaiting('brand-new', '/target');
      await same();
      await runs.remove(await runOf(app, 'plain-3'));
      await same();

      const done = await runOf(app, SEEDED.done);
      done.mergeOutcome = JSON.stringify({ merged: {} });
      await runs.saveRun(done);
      await same();
    }));

  it('sends a connecting socket the runs of a fresh build', () =>
    withApp(async (app) => {
      await seedRuns(app, 40);
      const gateway = new LiveGateway(
        app.get(LiveHub),
        app.get(RunQueriesService),
        app.get(AuthService),
        new ContainerGate(),
        app.get(RunListRows),
        app.get(Clock),
      );
      const told: Array<[string, unknown]> = [];
      await gateway.handleConnection({ emit: (name: string, entry: unknown) => told.push([name, entry]) } as never);
      expect(told.find(([name]) => name === 'runs')?.[1]).toEqual(
        pageOf((await freshView(app)).runs, { part: 'active', q: '' }),
      );
    }));
});
