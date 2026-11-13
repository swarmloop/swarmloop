import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { DocumentRepository } from '../history/document.repository';
import { deriveState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { HOST_RETRY_MS } from '../integrations/http';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git } from './runs.spec-helpers';

const KEY = 'PROJ-420';
const MINUTE = 60_000;

describe('a code host that fails for a while is waited for, and the real merge-request and pipeline steps go on', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;
  const stateNow = async () => deriveState(await find());
  const head = () => git(flow.tree, ['rev-parse', 'HEAD']);

  /** Ticks until the fake clock is `minutes` ahead; the invariants hold after every tick, and a resumed run finishes its hops. */
  async function tickFor(minutes: number): Promise<void> {
    const until = flow.app.clock.now() + minutes * MINUTE;
    while (flow.app.clock.now() < until) {
      await flow.tick();
      await flow.app.pipeline.whenIdle(KEY);
      await assertInvariants(flow.app);
    }
  }

  /** The step runs while the host is down: the run waits, says when it tries next, and nothing runs before that. */
  async function waitsWhileHostIsDown(step: 'merge-request' | 'pipeline', status: number): Promise<void> {
    await flow.begin(step);
    flow.host.ci.pass(head());
    flow.host.hostDown(2 * MINUTE, status);
    const failedAt = flow.app.clock.now();

    await flow.app.pipeline.step(step, KEY);
    const { state, reason } = await stateNow();
    expect(state).toBe('waiting');
    expect(reason?.code).toBe(ERROR_CODES.HOST_UNAVAILABLE);
    const retryAt = new Date(failedAt + HOST_RETRY_MS).toISOString();
    expect(reason?.retryAt).toBe(retryAt);
    expect(reason?.message).toContain(`HTTP ${status}`);
    expect(reason?.message).toContain(retryAt);

    await tickFor(4);
    expect((await stateNow()).state).toBe('waiting');
    expect((await find()).currentStep).toBe(step);
  }

  it.each([503, 429, 500, 502, 504])(
    'a host that answers %s at merge-request is waited for and then opens the request',
    async (status) => {
      await waitsWhileHostIsDown('merge-request', status);
      expect(flow.host.merged.size).toBe(0);

      await tickFor(2);
      expect((await stateNow()).state).toBe('done');
      const opened = await flow.host.findMergeRequest({
        project: 'group/demo',
        source: `feature/${KEY}-ship-the-field`,
      });
      expect(opened.record).toMatchObject({ project: 'group/demo', iid: 1, draft: false });
    },
  );

  it.each([503, 429, 500, 502, 504])(
    'a host that answers %s at pipeline is waited for and then passes the pipeline',
    async (status) => {
      await waitsWhileHostIsDown('pipeline', status);

      await tickFor(2);
      expect((await stateNow()).state).toBe('done');
    },
  );

  it.each([
    { advised: 3, early: 2, late: 2 },
    { advised: 8, early: 7, late: 2 },
  ])(
    'a host that advises Retry-After of $advised minutes is not tried before then',
    async ({ advised, early, late }) => {
      await flow.begin('merge-request');
      flow.host.ci.pass(head());
      flow.host.hostDown(MINUTE, 429, advised * MINUTE);
      const failedAt = flow.app.clock.now();

      await flow.app.pipeline.step('merge-request', KEY);
      expect((await stateNow()).reason?.retryAt).toBe(new Date(failedAt + advised * MINUTE).toISOString());

      await tickFor(early);
      expect((await stateNow()).state).toBe('waiting');
      expect((await find()).currentStep).toBe('merge-request');

      await tickFor(late);
      expect((await stateNow()).state).toBe('done');
    },
  );

  it('returns a red pipeline to implement with the failed job named, then passes the next commit', async () => {
    await flow.begin('pipeline');
    flow.host.ci.fail(head(), 'FAIL src/readme.spec.ts\n  expected 1 to be 2');

    await flow.app.pipeline.step('pipeline', KEY);
    const red = await flow.app.app.get(RunRepository).findRun(KEY);
    expect(red?.currentStep).toBe('implement');
    expect(red?.attemptsPipeline).toBe(1);
    const log = await flow.app.app.get(DocumentRepository).latestBody(KEY, 'pipeline_log');
    expect(log).toContain('job: test');
    expect(log).toContain('expected 1 to be 2');

    const fixed = await flow.recommit();
    flow.host.ci.pass(fixed);
    await flow.app.pipeline.step('pipeline', KEY);
    await assertInvariants(flow.app);
    expect((await stateNow()).state).toBe('done');
  });
});
