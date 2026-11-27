import { storeRun } from '../../testing/store-run.spec-helpers';
import { backlogHarness } from './backlog.spec-helpers';

type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await backlogHarness(3);
  try {
    await body(harness);
  } finally {
    await harness.scheduler().onModuleDestroy();
    await harness.db.close();
  }
}

const WAITING = { code: 'SUBTASKS_RUNNING', message: 'subtasks run' };

/** A backlog whose one task has a run that became an epic between passes. Returns the epic's run key. */
async function epicBetweenPasses(h: Harness, options: { paused?: boolean } = {}) {
  h.setMain('web');
  const backlog = await h.seedBacklog('one', { owner: 'ada', repositories: ['web'], ...options });
  const milestone = await h.seedMilestone(backlog.id as number, 1);
  const key = 'a-run';
  await storeRun(h.runs, h.runs.newWaitingRun(key, null, 'ada'));
  await h.seedTask(backlog.id as number, 'a', { milestoneId: milestone.id as number, runKey: key });
  await h.markSplit(key);
  await h.moveRun(key, { status: 'waiting', currentStep: 'implement', reason: WAITING });
  return { key, backlogId: backlog.id as number };
}

const rebases = (h: Harness) => h.accepts.filter((sent) => sent.type === 'rebase');

describe('EpicMainMoves', () => {
  it('sends one rebase for a green head the epic does not hold, and none for the same head again', () =>
    withHarness(async (h) => {
      const { key } = await epicBetweenPasses(h);
      const head = h.fake.headOf('acme/web');
      await h.tick();
      expect(rebases(h)).toEqual([{ type: 'rebase', key, idempotencyKey: `epic-main-${key}-web@${head}` }]);
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
      h.fake.setHead('acme/web', 'acme/web-head-1');
      h.setMain('web');
      await h.tick();
      expect(rebases(h).map((sent) => sent.idempotencyKey)).toEqual([
        `epic-main-${key}-web@${head}`,
        `epic-main-${key}-web@acme/web-head-1`,
      ]);
    }));

  it('takes a new head of a main with no CI', () =>
    withHarness(async (h) => {
      const { key } = await epicBetweenPasses(h);
      h.setMain('web', 'no-ci');
      const head = h.fake.headOf('acme/web');
      await h.tick();
      expect(rebases(h)).toEqual([{ type: 'rebase', key, idempotencyKey: `epic-main-${key}-web@${head}` }]);
    }));

  it.each(['red', 'pending'] as const)('does not take a %s head', (style) =>
    withHarness(async (h) => {
      await epicBetweenPasses(h);
      h.setMain('web', style);
      await h.tick();
      expect(rebases(h)).toEqual([]);
    }),
  );

  it('sends nothing for a head the epic holds', () =>
    withHarness(async (h) => {
      await epicBetweenPasses(h);
      h.epics.held.add(`web@${h.fake.headOf('acme/web')}`);
      await h.tick();
      expect(rebases(h)).toEqual([]);
    }));

  it('waits while a subtask runs or is held, and moves the epic once none does', () =>
    withHarness(async (h) => {
      await epicBetweenPasses(h);
      h.epics.idle = false;
      await h.tick();
      expect(rebases(h)).toEqual([]);
      h.epics.idle = true;
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
    }));

  it('takes an epic that a blocked subtask holds', () =>
    withHarness(async (h) => {
      const { key } = await epicBetweenPasses(h);
      await h.moveRun(key, {
        status: 'blocked',
        currentStep: 'implement',
        reason: { code: 'SUBTASK_BLOCKED', message: 'a subtask is blocked' },
      });
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
    }));

  it("takes an epic whose pass waits on a part's question", () =>
    withHarness(async (h) => {
      const { key } = await epicBetweenPasses(h);
      const head = h.fake.headOf('acme/web');
      await h.moveRun(key, {
        status: 'waiting',
        currentStep: 'implement',
        reason: { code: 'ASKS_PLANNER', message: 'waiting for the backlog planner' },
      });
      await h.tick();
      expect(rebases(h)).toEqual([{ type: 'rebase', key, idempotencyKey: `epic-main-${key}-web@${head}` }]);
    }));

  it('leaves a running epic alone', () =>
    withHarness(async (h) => {
      const { key } = await epicBetweenPasses(h);
      await h.moveRun(key, { status: 'running', currentStep: 'implement' });
      await h.tick();
      expect(rebases(h)).toEqual([]);
    }));

  it('leaves the epic of a paused backlog alone', () =>
    withHarness(async (h) => {
      await epicBetweenPasses(h, { paused: true });
      await h.tick();
      expect(rebases(h)).toEqual([]);
    }));

  it('writes one event for a send the server refuses, and goes on', () =>
    withHarness(async (h) => {
      const { backlogId } = await epicBetweenPasses(h);
      h.refuseRebase('a subtask runs');
      await h.tick();
      await h.tick();
      const events = (await h.backlogs.events(backlogId, 50)).filter((event) => event.kind === 'rebase-refused');
      expect(events).toHaveLength(1);
    }));

  it('writes the rebase-refused event for another wait that stored a retryAt', () =>
    withHarness(async (h) => {
      const { backlogId } = await epicBetweenPasses(h);
      const error = {
        message: 'limit',
        code: 'RUNTIME_LIMIT',
        retryAt: new Date(h.db.clock.now() + 60_000).toISOString(),
      };
      h.endCommandsAs('failed', JSON.stringify({ error }));
      await h.tick();
      h.db.clock.advance(120_000);
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
      const events = (await h.backlogs.events(backlogId, 50)).filter((event) => event.kind === 'rebase-refused');
      expect(events).toHaveLength(1);
    }));

  it('writes one event for a move the rebase refused, and sends that head no more', () =>
    withHarness(async (h) => {
      const { backlogId } = await epicBetweenPasses(h);
      h.endCommandsAs('failed', JSON.stringify({ error: { message: 'demo rebase failed: boom' } }));
      await h.tick();
      await h.tick();
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
      const events = (await h.backlogs.events(backlogId, 50)).filter((event) => event.kind === 'rebase-refused');
      expect(events).toHaveLength(1);
    }));

  /** A code host outage's stored failure, ended by `endCommandsAs`, and the one move sent again after its next try. */
  const triesOutageAgainOnce = (stored: Record<string, string>) =>
    withHarness(async (h) => {
      const { key } = await epicBetweenPasses(h);
      const head = h.fake.headOf('acme/web');
      const outage = (minutes: number) =>
        JSON.stringify({
          error: {
            message: 'host did not answer',
            ...stored,
            retryAt: new Date(h.db.clock.now() + minutes * 60_000).toISOString(),
          },
        });
      h.endCommandsAs('failed', outage(10));
      await h.tick();
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
      h.endCommandsAs('failed', outage(60));
      h.db.clock.advance(10 * 60_000);
      await h.tick();
      expect(rebases(h).map((sent) => sent.idempotencyKey)).toEqual([
        `epic-main-${key}-web@${head}`,
        `epic-main-${key}-web@${head}-after-command-1`,
      ]);
      await h.tick();
      expect(rebases(h)).toHaveLength(2);
      expect((await h.backlogs.events(1, 50)).filter((event) => event.kind === 'rebase-refused')).toEqual([]);
    });

  it('tries a code host outage again once, after its next try, from the stored command alone', () =>
    triesOutageAgainOnce({}));

  it('tries a code host outage again once, after its next try, from a stored code and retryAt', () =>
    triesOutageAgainOnce({ code: 'HOST_UNAVAILABLE' }));
});
