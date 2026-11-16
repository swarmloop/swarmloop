import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { backlogLine } from '../contract/backlog';
import { BacklogRepository } from '../history/backlog.repository';
import { RunRepository } from '../history/run.repository';
import { save } from '../testing/runs.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';
import { RunQueriesService } from './run-queries.service';

const NOW = '2026-11-12T10:00:00Z';

async function withApp(body: (app: Awaited<ReturnType<typeof seededBoot>>) => Promise<void>): Promise<void> {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-run-backlog-')));
  try {
    await body(app);
  } finally {
    await app.close();
  }
}

async function seedTaskRun(app: Awaited<ReturnType<typeof seededBoot>>): Promise<void> {
  const backlogs = app.get(BacklogRepository);
  const backlog = await backlogs.saveBacklog({
    name: 'swarmloop',
    owner: 'ada',
    repositories: ['web'],
    mergeMode: 'green',
    paused: false,
    createdAt: NOW,
  });
  const milestone = await backlogs.saveMilestone({
    backlogId: backlog.id as number,
    number: 3,
    title: 'Third',
    goal: '',
    status: 'active',
    createdAt: NOW,
  });
  await backlogs.saveTask({
    backlogId: backlog.id as number,
    milestoneId: milestone.id as number,
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
    status: 'running',
    runKey: 'one-1',
    note: '',
    runNow: false,
    mergeOk: false,
    merged: {},
    madeBy: 'person',
    position: 1,
    createdAt: NOW,
  });
  const runs = app.get(RunRepository);
  await save(runs, 'one-1', 'implement', 'running');
  await save(runs, 'plain-1', 'implement', 'running');
}

describe('run backlog label', () => {
  it('shows the backlog and milestone of a task run on the list and the page, and nothing on other runs', () =>
    withApp(async (app) => {
      await seedTaskRun(app);
      const queries = app.get(RunQueriesService);

      const { runs } = await queries.list();
      const held = runs.find((run) => run.key === 'one-1');
      expect(held?.backlog).toEqual({ name: 'swarmloop', milestone: 3 });
      expect(backlogLine(held!.backlog!)).toBe('swarmloop · M3');
      expect(runs.find((run) => run.key === 'plain-1')).not.toHaveProperty('backlog');

      expect((await queries.flow('one-1')).backlog).toEqual({ name: 'swarmloop', milestone: 3 });
      expect(await queries.flow('plain-1')).not.toHaveProperty('backlog');
    }));
});
