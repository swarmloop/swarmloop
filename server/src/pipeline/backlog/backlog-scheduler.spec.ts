import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { backlogHarness } from './backlog.spec-helpers';

type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withHarness(body: (harness: Harness) => Promise<void>, parallel = 3): Promise<void> {
  const harness = await backlogHarness(parallel);
  try {
    await body(harness);
  } finally {
    await harness.scheduler().onModuleDestroy();
    await harness.db.close();
  }
}

/** A backlog with one active milestone and a green web. */
async function activeBacklog(harness: Harness, name = 'one', owner = 'ada') {
  harness.setMain('web');
  const backlog = await harness.seedBacklog(name, { owner });
  const milestone = await harness.seedMilestone(backlog.id as number, 1);
  return { id: backlog.id as number, milestoneId: milestone.id as number };
}

describe('BacklogScheduler', () => {
  it('starts the ready tasks in plan order and holds a task until its dependency is merged', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      await h.seedTask(id, 'b', { milestoneId, depends: ['a'] });
      await h.seedTask(id, 'c', { milestoneId });
      await h.tick();
      expect(h.started()).toEqual(['a', 'c']);
      expect(h.starts[0]).toMatchObject({ prompt: 'Do a', projects: ['web'], owner: 'ada' });
      expect((await h.task(id, 'b')).note).toBe('waiting for a');
      await h.tick();
      expect(h.started()).toEqual(['a', 'c']);
    }));

  it('starts nothing behind a blocked task', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      await h.seedTask(id, 'b', { milestoneId, depends: ['a'] });
      await h.tick();
      await h.moveRun(h.starts[0].key, { status: 'failed', currentStep: 'implement' });
      await h.tick();
      expect(h.started()).toEqual(['a']);
      expect(await h.task(id, 'a')).toMatchObject({ status: 'blocked' });
      expect((await h.task(id, 'b')).note).toBe('waiting for a, which is blocked');
    }));

  it('keeps a waiting or blocked run in its place', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      for (const slug of ['a', 'b', 'c']) await h.seedTask(id, slug, { milestoneId });
      await h.tick();
      await h.moveRun(h.starts[0].key, { status: 'blocked', currentStep: 'implement' });
      await h.seedTask(id, 'd', { milestoneId });
      await h.tick();
      expect(h.started()).toEqual(['a', 'b', 'c']);
      expect((await h.task(id, 'd')).note).toBe('waits for a free place: 3 of BACKLOG_PARALLEL');
      await h.moveRun(h.starts[0].key, { status: 'done', currentStep: 'done', merge: { merged: {} } });
      await h.tick();
      expect(h.started()).toEqual(['a', 'b', 'c', 'd']);
    }));

  it('shares the places of the server between two backlogs in turns', () =>
    withHarness(async (h) => {
      const one = await activeBacklog(h, 'one');
      const two = await h.seedBacklog('two', { owner: 'bob' });
      const milestone = await h.seedMilestone(two.id as number, 1);
      for (const slug of ['a1', 'a2', 'a3']) await h.seedTask(one.id, slug, { milestoneId: one.milestoneId });
      for (const slug of ['b1', 'b2', 'b3']) await h.seedTask(two.id as number, slug, { milestoneId: milestone.id });
      await h.tick();
      expect(h.started()).toEqual(['a1', 'a2', 'b1']);
      expect(h.starts.map((start) => start.owner)).toEqual(['ada', 'ada', 'bob']);
      for (const start of h.starts)
        await h.moveRun(start.key, { status: 'done', currentStep: 'done', merge: { merged: {} } });
      await h.tick();
      expect(h.started().slice(3)).toEqual(['a3', 'b2', 'b3']);
    }));

  it('holds only the tasks that touch a red repository', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      h.setMain('server');
      h.setMain('web', 'red');
      await h.seedTask(id, 'web-task', { milestoneId });
      await h.seedTask(id, 'server-task', { milestoneId, repositories: ['server'] });
      await h.seedTask(id, 'both', { milestoneId, repositories: ['web', 'server'] });
      await h.tick();
      expect(h.started()).toEqual(['server-task']);
      expect((await h.task(id, 'web-task')).note).toBe('waits for a green main of web');
      h.setMain('web');
      await h.tick();
      expect(h.started()).toEqual(['server-task', 'web-task', 'both']);
    }));

  it('counts a main as pending right after a merge, when its head has no pipeline yet', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      h.setMain('web', 'no-pipeline');
      await h.tick();
      expect(h.started()).toEqual([]);
      expect((await h.task(id, 'a')).note).toBe('waits for a green main of web');
      h.setMain('web');
      await h.tick();
      expect(h.started()).toEqual(['a']);
    }));

  it('leaves a task waiting with the next try of a host that does not answer', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      h.fake.hostDown('2026-11-12T10:05:00Z');
      await h.tick();
      expect(h.started()).toEqual([]);
      expect((await h.task(id, 'a')).note).toContain('next try at 2026-11-12T10:05:00Z');
    }));

  it('starts a fixes_main task on its red main while every other task of that repository waits', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      h.setMain('web', 'red');
      await h.seedTask(id, 'other', { milestoneId });
      await h.seedTask(id, 'fix', { milestoneId, fixesMain: 'web' });
      await h.tick();
      expect(h.started()).toEqual(['fix']);
      expect((await h.task(id, 'other')).note).toBe('waits for fix, which fixes the main of web');
    }));

  it('starts a run now task behind its dependencies and follows its status while the milestone is proposed', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const backlog = await h.seedBacklog('one');
      const id = backlog.id as number;
      const proposed = await h.seedMilestone(id, 2, 'proposed');
      await h.seedTask(id, 'dep', { milestoneId: proposed.id });
      await h.seedTask(id, 'now', { milestoneId: proposed.id, runNow: true, depends: ['dep'] });
      await h.tick();
      expect(h.started()).toEqual([]);
      await h.backlogs.saveTask({ ...(await h.task(id, 'dep')), status: 'merged' });
      await h.tick();
      expect(h.started()).toEqual(['now']);
      await h.moveRun(h.starts[0].key, { status: 'running', currentStep: 'implement' });
      await h.tick();
      expect((await h.task(id, 'now')).status).toBe('running');
    }));

  it('does not start a started task again when its milestone becomes active', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const backlog = await h.seedBacklog('one');
      const id = backlog.id as number;
      const milestone = await h.seedMilestone(id, 1, 'proposed');
      await h.seedTask(id, 'now', { milestoneId: milestone.id, runNow: true });
      await h.tick();
      await h.backlogs.saveMilestone({ ...milestone, status: 'active' });
      await h.tick();
      expect(h.started()).toEqual(['now']);
    }));

  it('does not start a task twice when its start timed out, also after a restart', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      h.startMode('timeout');
      await h.tick();
      const stored = await h.task(id, 'a');
      expect(stored.runKey).toMatch(/^a-/);
      expect(stored.note).toBe('could not start: start request timed out; next try on the next tick');
      h.restart();
      await h.tick();
      expect(h.started()).toEqual(['a']);
      expect((await h.task(id, 'a')).note).toBe('');
    }));

  it('starts a stored key that the server does not know once again, with the same key, once main is green', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      h.startMode('lost');
      await h.tick();
      const key = (await h.task(id, 'a')).runKey;
      h.startMode('ok');
      h.setMain('web', 'red');
      h.restart();
      await h.tick();
      expect(h.starts).toHaveLength(1);
      expect((await h.task(id, 'a')).note).toBe('waits for a green main of web');
      h.setMain('web');
      await h.tick();
      expect(h.starts.map((start) => start.key)).toEqual([key, key]);
      expect((await h.task(id, 'a')).note).toBe('');
      await h.tick();
      expect(h.starts).toHaveLength(2);
    }));

  it('starts nothing for a paused backlog', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const backlog = await h.seedBacklog('one', { paused: true });
      const milestone = await h.seedMilestone(backlog.id as number, 1);
      await h.seedTask(backlog.id as number, 'a', { milestoneId: milestone.id });
      await h.tick();
      expect(h.started()).toEqual([]);
      expect(h.fake.calls).toEqual([]);
    }));

  it('makes no host call when there is no backlog', () =>
    withHarness(async (h) => {
      h.setMain('web');
      await h.tick();
      expect(h.fake.calls).toEqual([]);
    }));

  it('reads each main once per tick, however many tasks touch it', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      for (const slug of ['a', 'b']) await h.seedTask(id, slug, { milestoneId });
      await h.tick();
      expect(h.fake.calls.filter((call) => call.name === 'readDefaultHead')).toHaveLength(1);
    }));

  describe('on the timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('runs a pass every RECONCILE_MS until the module is destroyed', () =>
      withHarness(async (h) => {
        const { id, milestoneId } = await activeBacklog(h);
        const scheduler = h.scheduler();
        scheduler.schedule();
        await h.seedTask(id, 'a', { milestoneId });
        await jest.advanceTimersByTimeAsync(h.db.config.env.RECONCILE_MS);
        expect(h.started()).toEqual(['a']);
        await scheduler.onModuleDestroy();
        await h.seedTask(id, 'b', { milestoneId });
        await jest.advanceTimersByTimeAsync(h.db.config.env.RECONCILE_MS * 3);
        expect(h.started()).toEqual(['a']);
      }));
  });
});

describe('BacklogScheduler run keys and requirement cycles', () => {
  it('gives each of two backlogs that start the same slug at the same time its own run', () =>
    withHarness(async (h) => {
      const first = await activeBacklog(h, 'one');
      const second = await activeBacklog(h, 'two');
      await h.seedTask(first.id, 'setup', { milestoneId: first.milestoneId });
      await h.seedTask(second.id, 'setup', { milestoneId: second.milestoneId });
      await h.tick();
      const keys = [(await h.task(first.id, 'setup')).runKey, (await h.task(second.id, 'setup')).runKey] as string[];
      expect(new Set(keys).size).toBe(2);
      expect(keys[1]).toMatch(/--2$/);
      await h.moveRun(keys[0], { status: 'failed', currentStep: 'implement' });
      await h.tick();
      expect(await h.task(first.id, 'setup')).toMatchObject({ status: 'blocked' });
      expect(await h.task(second.id, 'setup')).not.toMatchObject({ status: 'blocked' });
    }));

  it('stores the --2 key the server opened when the key is taken, and follows that run', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      const taken = `a-${h.db.clock.now().toString(36)}`;
      await h.runs.saveRun(h.runs.newWaitingRun(taken, null, 'ada'));
      await h.seedTask(id, 'a', { milestoneId });
      await h.tick();
      expect((await h.task(id, 'a')).runKey).toBe(`${taken}--2`);
      await h.moveRun(`${taken}--2`, { status: 'failed', currentStep: 'implement' });
      await h.tick();
      expect(await h.task(id, 'a')).toMatchObject({ status: 'blocked' });
    }));

  it('shows a stored cycle through requirements on its tasks and starts none of them', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId, covers: ['M1.R1'], depends: ['M1.R2'] });
      await h.seedTask(id, 'b', { milestoneId, covers: ['M1.R2'], depends: ['M1.R1'] });
      await h.tick();
      await h.tick();
      expect(h.started()).toEqual([]);
      expect(await h.task(id, 'a')).toMatchObject({
        status: 'waiting',
        note: 'waits in a cycle: a -> M1.R2 (b) -> M1.R1 (a)',
      });
      expect(await h.task(id, 'b')).toMatchObject({
        status: 'waiting',
        note: 'waits in a cycle: b -> M1.R1 (a) -> M1.R2 (b)',
      });
    }));

  it('starts a task that depends on a requirement it covers itself', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId, covers: ['M1.R1'], depends: ['M1.R1'] });
      await h.tick();
      expect(h.started()).toEqual(['a']);
    }));

  it('holds the dependents of a merged task until a finished turn has read its merge, then starts them', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId, status: 'merged' });
      await h.seedTask(id, 'b', { milestoneId, depends: ['a'] });
      await h.backlogs.recordEvent(id, 'task-merged:a', 'task-merged', { slug: 'a' });
      await h.tick();
      expect(h.started()).toEqual([]);
      expect((await h.task(id, 'b')).note).toBe('waits for the planner to read the merge of a');

      const chat = h.db.app.get(BacklogChatRepository);
      const base = { backlogId: id, reason: '', nextTryAt: null, createdAt: h.db.clock.iso() };
      await chat.saveTurn({ ...base, turnKey: 'turn-1', status: 'running' });
      await chat.takeInto(id, 'turn-1');
      await h.tick();
      expect(h.started()).toEqual([]);

      await chat.saveTurn({ ...(await chat.findTurn('turn-1')), ...base, turnKey: 'turn-1', status: 'done' });
      await h.tick();
      expect(h.started()).toEqual(['b']);
    }));

  it('calls a listener at the end of each events pass until it is removed', () =>
    withHarness(async (h) => {
      await activeBacklog(h);
      const calls: string[] = [];
      const stop = h.scheduler().afterEvents(async () => {
        calls.push('pass');
      });
      await h.tick();
      await h.tick();
      stop();
      await h.tick();
      expect(calls).toEqual(['pass', 'pass']);
    }));

  it('goes on with the pass when a listener fails', () =>
    withHarness(async (h) => {
      const { id, milestoneId } = await activeBacklog(h);
      await h.seedTask(id, 'a', { milestoneId });
      h.scheduler().afterEvents(() => Promise.reject(new Error('listener broke')));
      await h.tick();
      expect(h.started()).toEqual(['a']);
    }));
});
