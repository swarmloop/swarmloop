import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { deriveState, writeRunState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { CommandService } from '../pipeline/command.service';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';

const KEY = 'PROJ-410';
const MINUTE = 60_000;

describe('a passing outage or a restart heals on the reconciler ticks', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let accept: jest.SpyInstance;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
    spyOnCommands();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  function spyOnCommands(): void {
    accept = jest
      .spyOn(flow.app.app.get(CommandService), 'accept')
      .mockImplementation(() => Promise.resolve({} as never));
  }

  const find = async () => (await flow.app.app.get(RunRepository).findRun(KEY))!;

  /** Ticks until the fake clock is `minutes` ahead of `from`; the invariants hold after every tick. */
  async function tickFor(minutes: number): Promise<void> {
    const until = flow.app.clock.now() + minutes * MINUTE;
    while (flow.app.clock.now() < until) {
      await flow.tick();
      await assertInvariants(flow.app);
    }
  }

  it('tries a host that was down for 10 minutes again by itself, and only after its next try', async () => {
    const run = await flow.app.app.get(RunRepository).begin(KEY, 'merge-request');
    const retryAt = new Date(flow.app.clock.now() + 10 * MINUTE).toISOString();
    writeRunState(run, {
      status: 'waiting',
      activeAttempt: null,
      reason: {
        code: ERROR_CODES.HOST_UNAVAILABLE,
        message: `host did not answer: HTTP 503; next try at ${retryAt}`,
        retryAt,
      },
    });
    await flow.app.app.get(RunRepository).saveRun(run);

    await tickFor(9);
    expect(accept).not.toHaveBeenCalled();

    await tickFor(2);
    expect(accept).toHaveBeenCalledWith('resume', KEY, {}, { idempotencyKey: `host-none-${retryAt}` });
  });

  it('waits while docker is silent for 10 minutes, starts nothing, then settles the run', async () => {
    const run = await flow.app.app.get(RunRepository).begin(KEY, 'implement');
    flow.dockerSilent(10 * MINUTE);

    await flow.tick();
    await assertInvariants(flow.app);
    expect(deriveState(await find()).reason?.code).toBe(ERROR_CODES.DOCKER_UNAVAILABLE);

    await tickFor(5);
    expect(deriveState(await find()).reason?.code).toBe(ERROR_CODES.DOCKER_UNAVAILABLE);
    expect(accept).not.toHaveBeenCalled();

    await tickFor(6);
    expect(accept).toHaveBeenCalledWith(
      'resume',
      KEY,
      {},
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect((await find()).id).toBe(run.id);
  });

  it('relaunches a step that a server restart cut, once', async () => {
    jest.restoreAllMocks();
    const accepted = jest
      .spyOn(CommandService.prototype, 'accept')
      .mockImplementation(() => Promise.resolve({} as never));
    const begun = await flow.app.app.get(RunRepository).begin(KEY, 'implement');

    await flow.restart();
    await flow.tick();
    await assertInvariants(flow.app);

    const cut = await find();
    expect(cut.status).toBe('failed');
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveBeenCalledWith('resume', KEY, {}, { idempotencyKey: `relaunch-${begun.activeAttempt}` });
  });
});
