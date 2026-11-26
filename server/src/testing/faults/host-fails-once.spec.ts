import 'reflect-metadata';
import { ERROR_CODES } from '../../contract/error-codes';
import { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { HOST_RETRY_MS } from '../../integrations/http';
import { createFlowHarness } from '../flow-harness';
import { git } from '../runs.spec-helpers';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-903';

describe('a code host call that fails once', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY, { realHost: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const stored = async () => storedState((await flow.app.app.get(RunRepository).findRun(KEY))!);

  it('at the merge request waits with its next try, then opens the request at that try', async () => {
    await flow.begin('merge-request');
    flow.host.ci.pass(git(flow.tree, ['rev-parse', 'HEAD']));
    // The host is down for one moment: the first call fails and the next try finds it up.
    flow.host.hostDown(1);
    const failedAt = flow.app.clock.now();

    await flow.app.pipeline.step('merge-request', KEY);
    await settle(flow.app);

    const { state, reason } = await stored();
    expect(state).toBe('waiting');
    expect(reason?.code).toBe(ERROR_CODES.HOST_UNAVAILABLE);
    expect(reason?.retryAt).toBe(new Date(failedAt + HOST_RETRY_MS).toISOString());
    expect(flow.host.opened).toBe(0);
    await assertSettled(flow.app);

    flow.app.clock.advance(HOST_RETRY_MS);
    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);
    await settle(flow.app);

    expect((await stored()).state).toBe('done');
    expect(flow.host.opened).toBe(1);
    await assertSettled(flow.app);
  });
});
