import { REASON } from '../../contract/reason-words';
import { storedState } from '../../history/run-state';
import { storeRun } from '../../testing/store-run.spec-helpers';
import { backlogHarness } from './backlog.spec-helpers';
import { RedMainWait } from './red-main-wait';

type Harness = Awaited<ReturnType<typeof backlogHarness>>;

async function withWait(body: (h: Harness, wait: RedMainWait) => Promise<void>): Promise<void> {
  const h = await backlogHarness(3);
  try {
    await body(h, new RedMainWait(h.backlogs, h.runs, h.host));
  } finally {
    await h.scheduler().onModuleDestroy();
    await h.db.close();
  }
}

/** A backlog with a task `a` that has a run, and a fix task `fix` for web's main unless `fixStatus` is left out. */
async function seeded(h: Harness, options: { fix?: 'waiting' | 'merged' | null } = {}) {
  const backlog = await h.seedBacklog('one', { owner: 'ada', repositories: ['web'] });
  const id = backlog.id as number;
  await storeRun(h.runs, h.runs.newWaitingRun('a-run', null, 'ada'));
  await h.moveRun('a-run', { status: 'waiting', currentStep: 'implement' });
  await h.seedTask(id, 'a', { runKey: 'a-run' });
  const fix = options.fix === undefined ? 'waiting' : options.fix;
  if (fix !== null) await h.seedTask(id, 'fix', { fixesMain: 'web', status: fix });
  return id;
}

const runOf = async (h: Harness, key: string) =>
  (await h.runs.findRun(key)) as NonNullable<Awaited<ReturnType<Harness['runs']['findRun']>>>;

describe('RedMainWait', () => {
  it('gives the repository of an unsettled fix task while its main does not read green', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'red');
      await seeded(h);
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBe('web');
    }));

  it('gives none for a main with no CI, which lets work start and merge', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'no-ci');
      await seeded(h);
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBeNull();
    }));

  it('gives none for a run that is not at an implementation step', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'red');
      await seeded(h);
      await h.moveRun('a-run', { status: 'waiting', currentStep: 'implement-improve' });
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBe('web');
      await h.moveRun('a-run', { status: 'waiting', currentStep: 'research' });
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBeNull();
    }));

  it('answers a split epic by its own task', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'red');
      await seeded(h);
      await h.markSplit('a-run');
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBe('web');
    }));

  it('answers a part by its epic task', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'red');
      await seeded(h);
      const epic = await runOf(h, 'a-run');
      const part = h.runs.newWaitingRun('a-part', null, 'ada');
      part.parentRunId = epic.id;
      await storeRun(h.runs, part);
      await h.moveRun('a-part', { status: 'waiting', currentStep: 'implement' });
      expect(await wait.repositoryFor(await runOf(h, 'a-part'))).toBe('web');
    }));

  it('gives none for a green main, no fix task, a settled fix task or the fix task itself', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'green');
      const id = await seeded(h);
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBeNull();
      h.setMain('web', 'red');
      await h.backlogs.saveTask({ ...(await h.task(id, 'fix')), status: 'merged' });
      expect(await wait.repositoryFor(await runOf(h, 'a-run'))).toBeNull();
      await h.backlogs.saveTask({ ...(await h.task(id, 'fix')), status: 'waiting' });
      await storeRun(h.runs, h.runs.newWaitingRun('fix-run', null, 'ada'));
      await h.moveRun('fix-run', { status: 'waiting', currentStep: 'implement' });
      await h.backlogs.saveTask({ ...(await h.task(id, 'fix')), runKey: 'fix-run' });
      expect(await wait.repositoryFor(await runOf(h, 'fix-run'))).toBeNull();
    }));

  it('gives none for a run no backlog task holds', () =>
    withWait(async (h, wait) => {
      await seeded(h, { fix: null });
      await storeRun(h.runs, h.runs.newWaitingRun('loose', null, 'ada'));
      expect(await wait.repositoryFor(await runOf(h, 'loose'))).toBeNull();
    }));

  it('words the hold for the repository that is not green when the task has several', () =>
    withWait(async (h, wait) => {
      h.setMain('api', 'green');
      h.setMain('web', 'red');
      const backlog = await h.seedBacklog('two', { owner: 'ada', repositories: ['api', 'web'] });
      await storeRun(h.runs, h.runs.newWaitingRun('b-run', null, 'ada'));
      await h.seedTask(backlog.id as number, 'b', { runKey: 'b-run', repositories: ['api', 'web'] });
      await wait.hold(await runOf(h, 'b-run'), 'web');
      expect(storedState(await runOf(h, 'b-run')).reason?.message).toBe('waits for a green main of web');
    }));

  it('holds the run waiting with the words a backlog task shows for its main', () =>
    withWait(async (h, wait) => {
      h.setMain('web', 'red');
      await seeded(h, { fix: null });
      await wait.hold(await runOf(h, 'a-run'), 'web');
      expect(storedState(await runOf(h, 'a-run'))).toMatchObject({
        state: 'waiting',
        reason: { code: REASON.waitsForMain, message: 'waits for a green main of web' },
      });
    }));
});
