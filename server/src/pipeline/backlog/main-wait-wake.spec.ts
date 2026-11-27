import { REASON } from '../../contract/reason-words';
import { storedState } from '../../history/run-state';
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

const HELD = { code: REASON.waitsForMain, message: 'waits for a green main of web' };

/** A backlog whose task `a` has a run that waits for a green main. Returns the run's key. */
async function waitingRun(h: Harness, options: { paused?: boolean; repositories?: string[]; fixesMain?: string } = {}) {
  const { repositories = ['web'], fixesMain, ...backlogOptions } = options;
  h.setMain('web', 'red');
  const backlog = await h.seedBacklog('one', { owner: 'ada', repositories, ...backlogOptions });
  const key = 'a-run';
  await storeRun(h.runs, h.runs.newWaitingRun(key, null, 'ada'));
  await h.seedTask(backlog.id as number, 'a', { runKey: key, repositories, ...(fixesMain ? { fixesMain } : {}) });
  await h.moveRun(key, { status: 'waiting', currentStep: 'implement', reason: HELD });
  return { key, backlogId: backlog.id as number };
}

const rebases = (h: Harness) => h.accepts.filter((sent) => sent.type === 'rebase');
const messageOf = async (h: Harness, key: string) =>
  storedState((await h.runs.findRun(key)) as NonNullable<Awaited<ReturnType<Harness['runs']['findRun']>>>).reason
    ?.message;

describe('MainWaitWake', () => {
  it('keeps the run waiting while a main reads red, and sends nothing', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h);
      await h.tick();
      expect(rebases(h)).toEqual([]);
      expect(await messageOf(h, key)).toBe('waits for a green main of web');
    }));

  it('refreshes the words when the task waits for another reason', () =>
    withHarness(async (h) => {
      const { key, backlogId } = await waitingRun(h);
      await h.seedTask(backlogId, 'fix', { fixesMain: 'web', status: 'waiting' });
      await h.tick();
      expect(await messageOf(h, key)).toBe('waits for fix, which fixes the main of web');
      expect(rebases(h)).toEqual([]);
    }));

  it('words the wait for the repository that is not green, not for one that is', () =>
    withHarness(async (h) => {
      const { key, backlogId } = await waitingRun(h, { repositories: ['api', 'web'] });
      h.setMain('api');
      await h.seedTask(backlogId, 'fix', { fixesMain: 'web', status: 'waiting', repositories: ['web'] });
      await h.tick();
      expect(await messageOf(h, key)).toBe('waits for fix, which fixes the main of web');
      expect(rebases(h)).toEqual([]);
    }));

  it('sends one rebase keyed by the heads once main is green, and never the same one twice', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h);
      await h.tick();
      h.setMain('web');
      const head = h.fake.headOf('acme/web');
      await h.tick();
      expect(rebases(h)).toEqual([{ type: 'rebase', key, idempotencyKey: `main-wait-${key}-web@${head}` }]);
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
    }));

  it('sends the rebase when one repository turns green and the other has no CI', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h, { repositories: ['api', 'docs'] });
      h.setMain('docs', 'no-ci');
      h.setMain('api');
      await h.tick();
      expect(rebases(h).map((sent) => sent.key)).toEqual([key]);
    }));

  it('does not ask the main that the waiting task itself fixes', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h, { repositories: ['api', 'docs'], fixesMain: 'api' });
      h.setMain('api', 'red');
      h.setMain('docs');
      await h.tick();
      expect(rebases(h).map((sent) => sent.key)).toEqual([key]);
    }));

  it('sends it also when the run already holds those heads', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h);
      h.epics.held.add(`web@${h.fake.headOf('acme/web')}`);
      h.setMain('web');
      await h.tick();
      expect(rebases(h).map((sent) => sent.key)).toEqual([key]);
    }));

  it('gives the planner the refused event for a refused try, keeps the wait and tries the next head', () =>
    withHarness(async (h) => {
      const { key, backlogId } = await waitingRun(h);
      h.setMain('web');
      h.endCommandsAs('failed', JSON.stringify({ error: { message: 'demo rebase failed: boom' } }));
      await h.tick();
      await h.tick();
      expect(rebases(h)).toHaveLength(1);
      const events = (await h.backlogs.events(backlogId, 50)).filter((event) => event.kind === 'rebase-refused');
      expect(events).toHaveLength(1);
      expect(await messageOf(h, key)).toBe('waits for a green main of web');
      h.fake.setHead('acme/web', 'acme/web-head-1');
      h.setMain('web');
      await h.tick();
      expect(rebases(h)).toHaveLength(2);
    }));

  const wakes = (h: Harness) => rebases(h).filter((sent) => sent.idempotencyKey?.startsWith('main-wait-'));

  it('leaves a split run to the epic main move', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h);
      await h.markSplit(key);
      await h.moveRun(key, { status: 'waiting', currentStep: 'implement', reason: HELD });
      h.setMain('web');
      await h.tick();
      expect(wakes(h)).toEqual([]);
    }));

  it('leaves a part to the main move of its epic', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h);
      const epic = (await h.runs.findRun(key)) as NonNullable<Awaited<ReturnType<Harness['runs']['findRun']>>>;
      const part = h.runs.newWaitingRun('a-part', null, 'ada');
      part.parentRunId = epic.id;
      await storeRun(h.runs, part);
      await h.moveRun('a-part', { status: 'waiting', currentStep: 'implement', reason: HELD });
      await h.moveRun(key, { status: 'running', currentStep: 'implement' });
      await h.backlogs.saveTask({ ...(await h.task(1, 'a')), runKey: 'a-part' });
      h.setMain('web');
      await h.tick();
      expect(wakes(h)).toEqual([]);
    }));

  it('leaves a run that does not wait for a green main alone', () =>
    withHarness(async (h) => {
      const { key } = await waitingRun(h);
      await h.moveRun(key, {
        status: 'waiting',
        currentStep: 'implement',
        reason: { code: 'ASKS_PLANNER', message: 'x' },
      });
      h.setMain('web');
      await h.tick();
      expect(wakes(h)).toEqual([]);
    }));

  it('leaves the run of a paused backlog alone', () =>
    withHarness(async (h) => {
      await waitingRun(h, { paused: true });
      h.setMain('web');
      await h.tick();
      expect(rebases(h)).toEqual([]);
    }));
});
