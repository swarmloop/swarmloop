import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { actionsHarness, backlogHarness } from './backlog.spec-helpers';

type Harness = Awaited<ReturnType<typeof actionsHarness>>;

async function withActions(body: (harness: Harness) => Promise<void>) {
  const harness = await actionsHarness();
  try {
    await harness.actions.createBacklog('ada', { name: 'shop', repositories: ['web', 'server'], mergeMode: 'green' });
    await body(harness);
  } finally {
    await harness.close();
  }
}

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  description: `Do ${id}`,
  repositories: ['web'],
  ...extra,
});

async function tasksOf(harness: Harness) {
  const backlog = (await harness.backlogs.findBacklog('shop')) as { id: number };
  return harness.backlogs.tasks(backlog.id);
}

async function started(harness: Harness, slug: string, runKey = `${slug}-1`) {
  await harness.actions.addTasks('ada', 'shop', [task(slug)]);
  const record = (await tasksOf(harness)).find((other) => other.slug === slug)!;
  await harness.backlogs.saveTask({ ...record, runKey, status: 'running' });
  return runKey;
}

describe('task actions', () => {
  it('adds tasks at the end of the plan order and chains the ones that share a file, keeping outside depends', () =>
    withActions(async (harness) => {
      await harness.actions.addTasks('ada', 'shop', [task('base', { files: ['x.ts'] })]);
      await harness.actions.addTasks('ada', 'shop', [
        task('one', { files: ['a.ts'], depends: ['base'] }),
        task('two', { files: ['a.ts'] }),
        task('three', { files: ['b.ts'] }),
      ]);
      const tasks = await tasksOf(harness);
      expect(tasks.map((record) => record.slug)).toEqual(['base', 'one', 'two', 'three']);
      expect(tasks.map((record) => record.position)).toEqual([1, 2, 3, 4]);
      expect(tasks.map((record) => record.depends)).toEqual([[], ['base'], ['one'], []]);
      expect(tasks[2]).toMatchObject({ madeBy: 'person', status: 'waiting', runKey: null, milestoneId: null });
    }));

  it('refuses invalid scope, ids and statuses and writes nothing', () =>
    withActions(async (harness) => {
      await harness.actions.addTasks('ada', 'shop', [task('base')]);
      await harness.actions.proposeMilestone('ada', 'shop', { title: 'One', goal: '' });
      await harness.actions.acceptMilestone('ada', 'shop', 1).catch(() => undefined);
      const before = await harness.actionEvents('shop');
      const refused: [Promise<unknown>, unknown][] = [
        [
          harness.actions.addTasks('ada', 'shop', [task('ok'), task('bad', { repositories: ['docs'] })]),
          BadRequestException,
        ],
        [harness.actions.addTasks('ada', 'shop', [task('Bad Id')]), BadRequestException],
        [harness.actions.addTasks('ada', 'shop', [task('base')]), ConflictException],
        [harness.actions.addTasks('ada', 'shop', [task('ok', { depends: ['ghost'] })]), BadRequestException],
        [harness.actions.addTasks('ada', 'shop', [task('ok', { covers: ['M1.R9'] })]), BadRequestException],
        [harness.actions.addTasks('ada', 'shop', [task('ok', { milestone: 9 })]), NotFoundException],
        [harness.actions.addTasks('ada', 'shop', []), BadRequestException],
        [harness.actions.addTasks(null, 'shop', [task('ok')]), Error],
        [harness.actions.changeTask('ada', 'shop', 'base', { depends: ['base'] }), BadRequestException],
        [harness.actions.changeTask('ada', 'shop', 'nope', {}), NotFoundException],
      ];
      for (const [call, error] of refused) await expect(call).rejects.toThrow(error as never);
      expect((await tasksOf(harness)).map((record) => record.slug)).toEqual(['base']);
      expect(await harness.actionEvents('shop')).toEqual(before);
    }));

  it('changes a task that has not started and refuses a started one', () =>
    withActions(async (harness) => {
      await harness.actions.proposeMilestone('ada', 'shop', { title: 'One', goal: '' });
      await harness.actions.addTasks('ada', 'shop', [task('one')]);
      await harness.actions.changeTask('ada', 'shop', 'one', {
        title: 'New',
        repositories: ['server'],
        files: ['f.ts'],
        proof: ['f.spec.ts'],
        milestone: 1,
      });
      expect((await tasksOf(harness))[0]).toMatchObject({
        title: 'New',
        repositories: ['server'],
        files: ['f.ts'],
        proof: ['f.spec.ts'],
        description: 'Do one',
      });
      expect((await tasksOf(harness))[0].milestoneId).not.toBeNull();

      await started(harness, 'two');
      await expect(harness.actions.changeTask('ada', 'shop', 'two', { title: 'No' })).rejects.toThrow(
        'two has started: its run takes changes through its own planner',
      );
      expect((await tasksOf(harness))[1].title).toBe('Title two');
    }));

  it('deletes a task that has not started, and refuses a started one, which is skipped instead', () =>
    withActions(async (harness) => {
      await harness.actions.addTasks('ada', 'shop', [task('gone')]);
      await harness.actions.deleteTask('ada', 'shop', 'gone');
      expect(await tasksOf(harness)).toEqual([]);

      await started(harness, 'live');
      await expect(harness.actions.deleteTask('ada', 'shop', 'live')).rejects.toThrow(
        'live has started: skip it instead',
      );
      await harness.actions.skipTask('ada', 'shop', 'live');
      expect((await tasksOf(harness))[0].status).toBe('skipped');
    }));

  it('stops the run of a running task before it marks the task skipped', () =>
    withActions(async (harness) => {
      const key = await started(harness, 'live');
      await harness.runs.saveRun(harness.runs.newWaitingRun(key, null, 'ada'));
      await harness.actions.addTasks('ada', 'shop', [task('idle')]);

      await harness.actions.skipTask('ada', 'shop', 'live');
      expect(harness.stops).toEqual([`stop ${key}`]);
      expect((await tasksOf(harness)).map((record) => record.status)).toEqual(['skipped', 'waiting']);

      await harness.actions.skipTask('ada', 'shop', 'idle');
      expect(harness.stops).toEqual([`stop ${key}`]);
      await expect(harness.actions.skipTask('ada', 'shop', 'idle')).rejects.toThrow(ConflictException);
    }));

  it('sets merge_ok on a started task that waits for the OK, once', () =>
    withActions(async (harness) => {
      await harness.actions.addTasks('ada', 'shop', [task('idle')]);
      await expect(harness.actions.mergeTask('ada', 'shop', 'idle')).rejects.toThrow(ConflictException);
      await started(harness, 'live');
      await harness.actions.mergeTask('ada', 'shop', 'live');
      expect((await tasksOf(harness))[1].mergeOk).toBe(true);
      await expect(harness.actions.mergeTask('ada', 'shop', 'live')).rejects.toThrow(ConflictException);
    }));

  it('leaves the merge OK to the owner and writes nothing for another login', () =>
    withActions(async (harness) => {
      await started(harness, 'live');
      const before = await harness.actionEvents('shop');
      await expect(harness.actions.mergeTask('bob', 'shop', 'live')).rejects.toThrow(ForbiddenException);
      expect((await tasksOf(harness))[0].mergeOk).toBe(false);
      expect(await harness.actionEvents('shop')).toEqual(before);
    }));

  it('refuses a task in a milestone or run now with no repository, and lets an item wait without one', () =>
    withActions(async (harness) => {
      await harness.actions.proposeMilestone('ada', 'shop', { title: 'One', goal: '' });
      await expect(
        harness.actions.addTasks('ada', 'shop', [task('bare', { repositories: [], milestone: 1 })]),
      ).rejects.toThrow(BadRequestException);
      await harness.actions.addItem('ada', 'shop', { id: 'idea', title: 'Idea', description: 'Think' });
      await expect(harness.actions.runTaskNow('ada', 'shop', 'idea')).rejects.toThrow(BadRequestException);
      await expect(harness.actions.moveItem('ada', 'shop', 'idea', { milestone: 1 })).rejects.toThrow(
        BadRequestException,
      );
      await harness.actions.changeTask('ada', 'shop', 'idea', { repositories: ['web'] });
      await harness.actions.moveItem('ada', 'shop', 'idea', { milestone: 1 });
      expect((await tasksOf(harness))[0].milestoneId).not.toBeNull();
    }));

  it('adds, moves and drops backlog items', () =>
    withActions(async (harness) => {
      await harness.actions.proposeMilestone('ada', 'shop', { title: 'One', goal: '' });
      await harness.actions.addItem('ada', 'shop', { id: 'idea', title: 'Idea', description: 'Think' });
      expect((await tasksOf(harness))[0]).toMatchObject({
        milestoneId: null,
        repositories: [],
        covers: [],
        depends: [],
        madeBy: 'person',
      });
      await expect(
        harness.actions.addItem('ada', 'shop', { id: 'idea', title: 'x', description: 'y' }),
      ).rejects.toThrow(ConflictException);
      await expect(harness.actions.addItem('ada', 'shop', { id: 'new', title: ' ', description: 'y' })).rejects.toThrow(
        BadRequestException,
      );

      await harness.actions.changeTask('ada', 'shop', 'idea', { repositories: ['web'] });
      await harness.actions.moveItem('ada', 'shop', 'idea', { milestone: 1 });
      expect((await tasksOf(harness))[0].milestoneId).not.toBeNull();
      await expect(harness.actions.moveItem('ada', 'shop', 'idea', { milestone: 5 })).rejects.toThrow(
        NotFoundException,
      );

      await harness.actions.dropItem('ada', 'shop', 'idea');
      expect(await tasksOf(harness)).toEqual([]);
      await started(harness, 'live');
      await expect(harness.actions.moveItem('ada', 'shop', 'live', { milestone: 1 })).rejects.toThrow(
        ConflictException,
      );
      await expect(harness.actions.dropItem('ada', 'shop', 'live')).rejects.toThrow(ConflictException);
    }));

  it('records every action with who and when', () =>
    withActions(async (harness) => {
      await harness.actions.addTasks('bob', 'shop', [task('one')]);
      await harness.actions.changeTask('bob', 'shop', 'one', { title: 'T' });
      await harness.actions.deleteTask('bob', 'shop', 'one');
      const events = (await harness.actionEvents('shop')).slice(1);
      expect(events.map((event) => event.facts.action)).toEqual(['add tasks', 'change task', 'delete task']);
      for (const event of events) expect(event.facts).toMatchObject({ who: 'bob' });
      for (const event of events) expect(event.facts.at).toBe(event.createdAt);
    }));
});

describe('run now', () => {
  it('is the owner only, and a scheduler tick then starts the task behind its dependencies', async () => {
    const harness = await backlogHarness();
    try {
      harness.setMain('web');
      const backlog = (await harness.seedBacklog('shop', { owner: 'ada' })) as { id: number };
      const milestone = (await harness.seedMilestone(backlog.id, 1, 'proposed')) as { id: number };
      await harness.seedTask(backlog.id, 'base', { milestoneId: milestone.id });
      await harness.seedTask(backlog.id, 'next', { milestoneId: milestone.id, depends: ['base'] });

      await expect(harness.actions.runTaskNow('bob', 'shop', 'next')).rejects.toThrow(ForbiddenException);
      await harness.tick();
      expect(harness.started()).toEqual([]);

      await harness.actions.runTaskNow('ada', 'shop', 'next');
      await harness.tick();
      expect(harness.started()).toEqual([]);
      expect((await harness.task(backlog.id, 'next')).runNow).toBe(true);

      await harness.actions.runTaskNow('ada', 'shop', 'base');
      await harness.tick();
      expect(harness.started()).toEqual(['base']);
    } finally {
      await harness.db.close();
    }
  });

  it('refuses a task in an active milestone', async () => {
    const harness = await backlogHarness();
    try {
      const backlog = (await harness.seedBacklog('shop')) as { id: number };
      const milestone = (await harness.seedMilestone(backlog.id, 1, 'active')) as { id: number };
      await harness.seedTask(backlog.id, 'one', { milestoneId: milestone.id });
      await expect(harness.actions.runTaskNow('ada', 'shop', 'one')).rejects.toThrow(ConflictException);
      expect((await harness.task(backlog.id, 'one')).runNow).toBe(false);
    } finally {
      await harness.db.close();
    }
  });
});
