import type { BacklogEventKind } from '../../contract/backlog';
import { backlogHarness } from './backlog.spec-helpers';

type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await backlogHarness();
  try {
    await body(harness);
  } finally {
    await harness.scheduler().onModuleDestroy();
    await harness.db.close();
  }
}

async function events(h: Harness, id: number, kind: BacklogEventKind) {
  return (await h.backlogs.events(id, 100)).filter((event) => event.kind === kind);
}

const waitingRun = { status: 'waiting', reason: { code: 'GIT_AUTH', message: 'the git login was refused' } };

describe('BacklogEvents', () => {
  it('makes no host call and writes nothing without a backlog', () =>
    withHarness(async (h) => {
      h.setMain('web');
      h.fake.calls.length = 0;
      await h.tick();
      expect(h.fake.calls).toEqual([]);
    }));

  it('writes run-needs-person once, naming the run key and the tasks it holds back', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedTask(id, 'b', { depends: ['a'] });
      await h.seedTask(id, 'c', { depends: ['b'] });
      await h.seedTask(id, 'd');
      await h.seedDoneRun('a-1', []);
      await h.moveRun('a-1', waitingRun);

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'run-needs-person')).toMatchObject([
        { facts: { slug: 'a', runKey: 'a-1', state: 'waiting', reason: 'the git login was refused', holds: 'b, c' } },
      ]);
    }));

  it('writes run-done-without-request once for a done run with no merge request', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', []);

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'run-done-without-request')).toMatchObject([{ facts: { slug: 'a', runKey: 'a-1' } }]);
    }));

  it('writes task-merged once when the layer merges a task', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'task-merged')).toMatchObject([{ facts: { slug: 'a' } }]);
    }));

  it('writes main-red once per head and main-green only after a main-red', () =>
    withHarness(async (h) => {
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a');
      h.setMain('web', 'green');
      await h.tick();
      expect(await events(h, id, 'main-green')).toEqual([]);

      h.setMain('web', 'red');
      await h.tick();
      await h.tick();
      expect(await events(h, id, 'main-red')).toMatchObject([
        { facts: { repository: 'web', head: 'acme/web-head-0' } },
      ]);

      h.setMain('web', 'pending');
      await h.tick();
      expect(await events(h, id, 'main-green')).toEqual([]);

      h.fake.setHead('acme/web', 'head-1');
      h.setMain('web', 'green');
      await h.tick();
      await h.tick();
      h.fake.setHead('acme/web', 'head-2');
      h.setMain('web', 'green');
      await h.tick();
      expect(await events(h, id, 'main-green')).toMatchObject([{ facts: { repository: 'web', head: 'head-1' } }]);

      h.fake.setHead('acme/web', 'head-3');
      h.setMain('web', 'red');
      await h.tick();
      h.fake.setHead('acme/web', 'head-4');
      h.setMain('web', 'green');
      await h.tick();
      expect(await events(h, id, 'main-green')).toHaveLength(2);
    }));

  it('closes a requirement when its last covering task merges, and readies the milestone once its last requirement closes', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      const milestone = (await h.seedMilestone(id, 1)).id as number;
      await h.seedRequirement(milestone, 'M1.R1');
      await h.seedRequirement(milestone, 'M1.R2');
      await h.seedTask(id, 'a', { milestoneId: milestone, covers: ['M1.R1'], runKey: 'a-1' });
      await h.seedTask(id, 'b', { milestoneId: milestone, covers: ['M1.R1', 'M1.R2'], runKey: 'b-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);
      await h.seedDoneRun('b-1', [{ repo: 'web', iid: 6 }]);
      h.fake.refuseMerge('acme/web', 6, 'branch protected');
      await h.tick();
      expect(await events(h, id, 'requirement-ready')).toEqual([]);

      h.fake.refuseMerge('acme/web', 6, null);
      h.setMain('web');
      await h.tick();
      await h.tick();
      await h.tick();

      const statuses = (await h.backlogs.requirements(id)).map((requirement) => requirement.status);
      expect(statuses).toEqual(['closed', 'closed']);
      expect(await events(h, id, 'requirement-ready')).toHaveLength(2);
      expect(await events(h, id, 'milestone-ready')).toMatchObject([{ facts: { milestone: '1' } }]);
      expect((await h.backlogs.milestones(id))[0].status).toBe('active');
    }));

  it('closes a requirement for a task MergeWatch saw merged, in a paused backlog and a milestone that is not active', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one', { paused: true })).id as number;
      const milestone = (await h.seedMilestone(id, 2, 'proposed')).id as number;
      await h.seedRequirement(milestone, 'M2.R1');
      await h.seedTask(id, 'a', { milestoneId: milestone, covers: ['M2.R1'], runKey: 'a-1' });
      const at = '2026-11-12T10:00:00Z';
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }], {
        merged: { 'acme/web': { sha: 'abc', by: 'bob', at, url: null } },
      });
      await h.backlogs.saveTask({ ...(await h.task(id, 'a')), status: 'merged' });

      await h.tick();

      expect((await h.backlogs.requirements(id))[0].status).toBe('closed');
      expect(await events(h, id, 'requirement-ready')).toHaveLength(1);
      expect(await events(h, id, 'milestone-ready')).toEqual([]);
    }));

  it('leaves a requirement no task covers open, and its milestone not ready', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      const milestone = (await h.seedMilestone(id, 1)).id as number;
      await h.seedRequirement(milestone, 'M1.R1');
      await h.seedTask(id, 'a', { milestoneId: milestone, runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);

      await h.tick();
      await h.tick();

      expect((await h.backlogs.requirements(id))[0].status).toBe('open');
      expect(await events(h, id, 'requirement-ready')).toEqual([]);
      expect(await events(h, id, 'milestone-ready')).toEqual([]);
    }));

  it('writes the refusal events through the same writer, once per head', () =>
    withHarness(async (h) => {
      h.setMain('web');
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedTask(id, 'a', { runKey: 'a-1' });
      await h.seedDoneRun('a-1', [{ repo: 'web', iid: 5 }]);
      h.fake.refuseMerge('acme/web', 5, 'branch protected');

      await h.tick();
      await h.tick();

      expect(await events(h, id, 'merge-refused')).toMatchObject([
        { facts: { task: 'a', repository: 'web', message: 'branch protected' } },
      ]);
    }));
});
