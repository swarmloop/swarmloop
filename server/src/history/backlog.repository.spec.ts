import { backlogLine } from '../contract/backlog';
import type { BacklogTaskRecord } from './backlog.repository';
import { BacklogRepository } from './backlog.repository';
import { repositoryDatabase } from './repository.spec-helpers';

async function withBacklogs(
  body: (backlogs: BacklogRepository, db: Awaited<ReturnType<typeof repositoryDatabase>>) => Promise<void>,
): Promise<void> {
  const db = await repositoryDatabase();
  try {
    await body(db.app.get(BacklogRepository), db);
  } finally {
    await db.close();
  }
}

const NOW = '2026-11-12T10:00:00Z';

function task(backlogId: number, slug: string, overrides: Partial<BacklogTaskRecord> = {}): BacklogTaskRecord {
  return {
    backlogId,
    milestoneId: null,
    slug,
    title: `Task ${slug}`,
    description: 'Do the work',
    repositories: ['web', 'server'],
    covers: ['M1.R1'],
    depends: ['other'],
    files: ['a.ts', 'b.ts'],
    proof: ['a.spec.ts'],
    manual: true,
    fixesMain: 'web',
    status: 'pending',
    runKey: null,
    note: '',
    runNow: false,
    merged: { web: 'abc123' },
    madeBy: 'planner',
    position: 1,
    createdAt: NOW,
    ...overrides,
  };
}

async function seedBacklog(backlogs: BacklogRepository, name = 'swarmloop') {
  return backlogs.saveBacklog({
    name,
    owner: 'ada',
    repositories: ['web', 'server'],
    mergeMode: 'ok',
    paused: true,
    createdAt: NOW,
  });
}

describe('BacklogRepository', () => {
  it('round-trips a backlog, milestone, requirement, task, decision and event', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const milestone = await backlogs.saveMilestone({
        backlogId: backlog.id as number,
        number: 1,
        title: 'First',
        goal: 'Goal',
        status: 'proposed',
        createdAt: NOW,
      });
      const requirement = await backlogs.saveRequirement({
        milestoneId: milestone.id as number,
        ref: 'M1.R1',
        text: 'It works',
        status: 'open',
      });
      const saved = await backlogs.saveTask(task(backlog.id as number, 'one', { milestoneId: milestone.id as number }));
      await backlogs.addDecision({ backlogId: backlog.id as number, text: 'Use SQLite', who: 'ada', createdAt: NOW });
      await backlogs.recordEvent(backlog.id as number, 'k1', 'main-red', { repository: 'web' });

      expect(await backlogs.listBacklogs()).toEqual([backlog]);
      expect(await backlogs.findBacklog('swarmloop')).toEqual(backlog);
      expect(await backlogs.findBacklog('none')).toBeNull();
      expect(await backlogs.milestones(backlog.id as number)).toEqual([milestone]);
      expect(await backlogs.requirements(backlog.id as number)).toEqual([requirement]);
      expect(await backlogs.tasks(backlog.id as number)).toEqual([saved]);
      expect(saved).toMatchObject({ covers: ['M1.R1'], merged: { web: 'abc123' }, manual: true, fixesMain: 'web' });
      expect(await backlogs.decisions(backlog.id as number)).toMatchObject([{ text: 'Use SQLite', who: 'ada' }]);
      expect(await backlogs.events(backlog.id as number, 10)).toMatchObject([
        { eventKey: 'k1', kind: 'main-red', facts: { repository: 'web' }, turn: null },
      ]);
    }));

  it('updates a saved task and keeps plan order', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const first = await backlogs.saveTask(task(backlog.id as number, 'b', { position: 2 }));
      await backlogs.saveTask(task(backlog.id as number, 'a', { position: 1 }));
      await backlogs.saveTask({ ...first, status: 'running', runKey: 'b-1' });

      const tasks = await backlogs.tasks(backlog.id as number);
      expect(tasks.map((entry) => entry.slug)).toEqual(['a', 'b']);
      expect(tasks[1]).toMatchObject({ status: 'running', runKey: 'b-1' });
      expect(await backlogs.findTaskByRunKey('b-1')).toMatchObject({ slug: 'b' });
      expect(await backlogs.findTaskByRunKey('missing')).toBeNull();
    }));

  it('gives the backlog and milestone of each run key and leaves unknown keys out', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const milestone = await backlogs.saveMilestone({
        backlogId: backlog.id as number,
        number: 3,
        title: 'Third',
        goal: '',
        status: 'active',
        createdAt: NOW,
      });
      await backlogs.saveTask(
        task(backlog.id as number, 'in', { milestoneId: milestone.id as number, runKey: 'in-1' }),
      );
      await backlogs.saveTask(task(backlog.id as number, 'item', { runKey: 'item-1' }));

      const labels = await backlogs.labelsFor(['in-1', 'item-1', 'unknown']);

      expect([...labels.keys()].sort()).toEqual(['in-1', 'item-1']);
      expect(labels.get('in-1')).toEqual({ name: 'swarmloop', milestone: 3 });
      expect(labels.get('item-1')).toEqual({ name: 'swarmloop', milestone: null });
      expect(backlogLine(labels.get('in-1')!)).toBe('swarmloop · M3');
      expect(backlogLine(labels.get('item-1')!)).toBe('swarmloop');
    }));

  it('keeps one row for an event key written twice', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const id = backlog.id as number;

      expect(await backlogs.recordEvent(id, 'same', 'main-red', { repository: 'web' })).toBe(true);
      expect(await backlogs.recordEvent(id, 'same', 'main-green', { repository: 'server' })).toBe(false);

      expect(await backlogs.events(id, 10)).toMatchObject([{ kind: 'main-red', facts: { repository: 'web' } }]);
    }));

  it('writes nothing when a transaction fails', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const id = backlog.id as number;

      await expect(
        backlogs.transaction(async (writers) => {
          await writers.saveTask(task(id, 'lost'));
          await writers.recordEvent(id, 'lost', 'main-red', {});
          throw new Error('stop');
        }),
      ).rejects.toThrow('stop');

      expect(await backlogs.tasks(id)).toEqual([]);
      expect(await backlogs.events(id, 10)).toEqual([]);
    }));

  it('writes everything of a transaction that succeeds', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const id = backlog.id as number;

      await backlogs.transaction(async (writers) => {
        await writers.saveTask(task(id, 'kept'));
        await writers.recordEvent(id, 'kept', 'main-red', {});
      });

      expect(await backlogs.tasks(id)).toHaveLength(1);
      expect(await backlogs.events(id, 10)).toHaveLength(1);
    }));

  it('counts started tasks that are not merged or skipped', () =>
    withBacklogs(async (backlogs) => {
      const backlog = await seedBacklog(backlogs);
      const id = backlog.id as number;
      await backlogs.saveTask(task(id, 'idle'));
      await backlogs.saveTask(task(id, 'running', { status: 'running', runKey: 'r-1' }));
      await backlogs.saveTask(task(id, 'waiting', { status: 'waiting', runKey: 'r-2' }));
      await backlogs.saveTask(task(id, 'merged', { status: 'merged', runKey: 'r-3' }));
      await backlogs.saveTask(task(id, 'skipped', { status: 'skipped', runKey: 'r-4' }));

      expect(await backlogs.startedUnmergedCount()).toBe(2);
    }));
});
