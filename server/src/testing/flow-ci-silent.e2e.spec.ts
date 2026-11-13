import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import { actionsFor, NEEDS_PERSON } from '../contract/run-state';
import { DocumentRepository } from '../history/document.repository';
import { deriveState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git } from './runs.spec-helpers';

const KEY = 'PROJ-440';
const SOURCE = `feature/${KEY}-ship-the-field`;
const MINUTE = 60_000;

describe('a commit whose CI does not start is waited for and nudged, never failed', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
    writeFileSync(join(flow.tree, '.gitlab-ci.yml'), 'test:\n  script: [true]\n');
    git(flow.tree, ['add', '.gitlab-ci.yml']);
    git(flow.tree, ['commit', '-m', 'ci: add the workflow']);
    git(flow.tree, ['push', 'origin', SOURCE]);
    flow.fastWaits();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;
  const stateNow = async () => deriveState(await find());
  const head = () => git(flow.tree, ['rev-parse', 'HEAD']);
  const log = async () => (await flow.app.app.get(DocumentRepository).latestBody(KEY, 'pipeline_log')) ?? '';

  /** Ticks until the fake clock is `minutes` ahead; the invariants hold after every tick. */
  async function tickFor(minutes: number): Promise<void> {
    const until = flow.app.clock.now() + minutes * MINUTE;
    while (flow.app.clock.now() < until) {
      await flow.tick();
      await flow.app.pipeline.whenIdle(KEY);
      await assertInvariants(flow.app);
    }
  }

  /** The commit gets no run: the request is opened and the pipeline step finds nothing to read. */
  async function startSilent(startsOnNudge = false): Promise<string> {
    await flow.begin('merge-request');
    const sha = head();
    flow.host.ci.silent(sha, startsOnNudge);
    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);
    await flow.app.pipeline.runThrough(KEY);
    return sha;
  }

  it('waits with CI_NOT_STARTED and a next look, and a wait is not a launch that failed', async () => {
    const sha = await startSilent();
    const { state, reason } = await stateNow();
    expect(state).toBe('waiting');
    expect(reason?.code).toBe(ERROR_CODES.CI_NOT_STARTED);
    expect(reason?.message).toBe(`CI has not started for ${sha}; next look at ${reason?.retryAt}`);
    expect(Date.parse(reason?.retryAt ?? '') - flow.app.clock.now()).toBeLessThanOrEqual(2 * MINUTE);
    expect(await log()).toContain('no conflict or closed request explains it');

    await tickFor(8);
    expect((await stateNow()).state).toBe('waiting');
    expect((await find()).currentStep).toBe('pipeline');
  });

  it('looks again only when its next look has come', async () => {
    await startSilent();
    const first = (await stateNow()).reason?.retryAt;
    const reads = flow.host.ci.reads;

    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);
    expect(flow.host.ci.reads).toBe(reads);
    expect((await stateNow()).reason?.retryAt).toBe(first);

    await tickFor(3);
    expect(flow.host.ci.reads).toBeGreaterThan(reads);
    expect((await stateNow()).reason?.retryAt).not.toBe(first);
  });

  it('rebases a conflict that appeared since the last look, once', async () => {
    const stuck = await startSilent();
    flow.host.conflicts(true);

    await tickFor(3);
    expect((await find()).attemptsPipeline).toBe(1);
    expect(head()).not.toBe(stuck);
    expect(flow.host.nudged).toHaveLength(0);
  });

  it('nudges the host once after 10 minutes, says why, and goes on when CI starts', async () => {
    const sha = await startSilent(true);
    await tickFor(5);
    expect(flow.host.nudged).toHaveLength(0);

    await tickFor(8);
    expect(flow.host.nudged).toEqual([{ project: 'group/demo', ref: SOURCE, sha }]);
    expect(flow.host.nudgeNotes).toEqual([expect.stringContaining(`CI has not started for ${sha} after 10 minutes`)]);
    await tickFor(3);
    expect((await stateNow()).state).toBe('done');
    expect(await log()).toContain('result: pass');
  });

  it('asks a person after 60 minutes with the commit, the link and what was tried, nudging only once', async () => {
    const sha = await startSilent();
    await tickFor(62);

    const { state, reason } = await stateNow();
    expect(state).toBe('blocked');
    expect(reason?.code).toBe(ERROR_CODES.CI_NOT_RUN);
    expect(actionsFor(state, reason?.code ?? null)).toContain(NEEDS_PERSON[reason?.code ?? '']);
    expect(flow.host.nudged).toHaveLength(1);
    expect(reason?.message).toContain(`commit: ${sha}`);
    expect(reason?.message).toContain('link: ');
    expect(reason?.message).toContain(`tried: looked again every 2 minutes`);
    expect(reason?.message).toContain('asked the host to start the pipeline');
  });
});
