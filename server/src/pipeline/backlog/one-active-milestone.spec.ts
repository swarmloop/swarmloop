import { OneActiveMilestone } from './one-active-milestone';
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

const statuses = async (h: Harness, id: number) =>
  (await h.backlogs.milestones(id)).map((milestone) => [milestone.status, milestone.queuedAfterId]);

describe('OneActiveMilestone', () => {
  it('keeps the lower of two active milestones and queues the higher behind it', () =>
    withHarness(async (h) => {
      const id = (await h.seedBacklog('one')).id as number;
      const first = (await h.seedMilestone(id, 1)).id as number;
      await h.seedMilestone(id, 2);
      await new OneActiveMilestone(h.backlogs).run(await h.backlogs.listBacklogs());
      expect(await statuses(h, id)).toEqual([
        ['active', null],
        ['queued', first],
      ]);
    }));

  it('makes one chain of two active milestones that each have a queue, and accepting each starts the next', () =>
    withHarness(async (h) => {
      const id = (await h.seedBacklog('one')).id as number;
      const ids: number[] = [];
      for (const number of [1, 2, 3, 4]) {
        const milestone = await h.seedMilestone(id, number, number <= 2 ? 'active' : 'queued');
        ids.push(milestone.id as number);
        await h.seedRequirement(milestone.id as number, `M${number}.R1`, 'closed');
      }
      for (const [index, after] of [
        [2, 0],
        [3, 1],
      ]) {
        const queued = (await h.backlogs.milestones(id))[index];
        await h.backlogs.saveMilestone({ ...queued, queuedAfterId: ids[after] });
      }
      await new OneActiveMilestone(h.backlogs).run(await h.backlogs.listBacklogs());
      expect(await statuses(h, id)).toEqual([
        ['active', null],
        ['queued', ids[2]],
        ['queued', ids[0]],
        ['queued', ids[1]],
      ]);
      for (const [accepted, next] of [
        [1, 3],
        [3, 2],
        [2, 4],
      ]) {
        await h.actions.acceptMilestone('ada', 'one', accepted);
        const stored = await h.backlogs.milestones(id);
        expect(stored.find((milestone) => milestone.number === next)?.status).toBe('active');
      }
      await h.actions.acceptMilestone('ada', 'one', 4);
      expect((await statuses(h, id)).map(([status]) => status)).toEqual([
        'accepted',
        'accepted',
        'accepted',
        'accepted',
      ]);
    }));

  it('writes nothing for a backlog with one active milestone', () =>
    withHarness(async (h) => {
      const id = (await h.seedBacklog('one')).id as number;
      await h.seedMilestone(id, 1);
      await h.seedMilestone(id, 2, 'proposed');
      await new OneActiveMilestone(h.backlogs).run(await h.backlogs.listBacklogs());
      expect(await statuses(h, id)).toEqual([
        ['active', null],
        ['proposed', null],
      ]);
    }));
});
