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
