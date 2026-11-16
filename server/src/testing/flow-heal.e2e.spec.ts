import 'reflect-metadata';
import { RunQueriesService } from '../api/run-queries.service';
import { restartWaitSentence } from '../contract/restart-wait';
import { ERROR_CODES } from '../contract/error-codes';
import { deriveState, writeRunState } from '../history/run-state';
import { CheckCommandRepository } from '../history/check-command.repository';
import { CommandRepository } from '../history/command.repository';
import { VisitRepository } from '../history/visit.repository';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { createFlowHarness } from './flow-harness';
import { holdRelaunches } from './relaunch-hold.spec-helpers';
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

  /** A resume that never ends: the relaunch of a cut step is taken by its executor and no step starts. */
  const held = () => new Promise<undefined>(() => undefined);

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

    // Once docker answers the cut step is settled and relaunched; the held relaunch leaves the run as the cut left it.
    flow.app.app.get(CommandService).register('resume', held);
    await tickFor(6);
    const [relaunch] = await flow.app.app.get(CommandRepository).listForRun(run.id);
    expect(relaunch).toMatchObject({ type: 'resume', idempotencyKey: expect.stringMatching(/^relaunch-/) });
    expect((await find()).id).toBe(run.id);
  });

  it('relaunches a step that a server restart cut, once', async () => {
    jest.restoreAllMocks();
    const begun = await flow.app.app.get(RunRepository).begin(KEY, 'implement');

    holdRelaunches(held);
    await flow.restart();
    await flow.tick();
    await assertInvariants(flow.app);

    const cut = await find();
    expect(cut.status).toBe('waiting');
    const stored = await flow.app.app.get(CommandRepository).listForRun(cut.id);
    expect(stored.map((command) => [command.type, command.idempotencyKey])).toEqual([
      ['resume', `relaunch-${begun.activeAttempt}`],
    ]);
  });

  it('a restart in the middle of checks stops the check containers at once, closes their rows as interrupted and starts the checks again with no wait', async () => {
    jest.restoreAllMocks();
    const begun = await flow.app.app.get(RunRepository).begin(KEY, 'checks');
    const attempt = begun.activeAttempt!;
    const rows = flow.app.app.get(CheckCommandRepository);
    const base = { runId: begun.id, attemptId: attempt, repo: 'demo' };
    await rows.add({
      ...base,
      command: 'npm test',
      commandIndex: 0,
      status: 'running',
      startedAt: flow.app.clock.iso(),
    });
    await rows.add({ ...base, command: 'npm run lint', commandIndex: 1 });
    flow.sandbox.leave(attempt, { lost: true });

    holdRelaunches(held);
    await flow.restart();
    await flow.tick();
    await assertInvariants(flow.app);

    expect(await flow.sandbox.calls.attemptRunning(attempt)).toBe(false);
    const cut = await find();
    expect(cut).toMatchObject({ status: 'waiting', activeAttempt: null });
    expect(cut.state).not.toBe('recovering');
    const [visit] = await flow.app.app.get(VisitRepository).listStats(cut.id);
    expect(
      (await flow.app.app.get(CheckCommandRepository).list(cut.id)).map((row) => [row.status, row.endedAt]),
    ).toEqual([
      ['interrupted', visit.finishedAt],
      ['interrupted', visit.finishedAt],
    ]);
    const stored = await flow.app.app.get(CommandRepository).listForRun(cut.id);
    expect(stored.map((command) => command.idempotencyKey)).toEqual([`relaunch-${attempt}`]);
  });

  it("a restart in the middle of an agent visit keeps today's wait and shows the waiting sentence", async () => {
    jest.restoreAllMocks();
    const begun = await flow.app.app.get(RunRepository).begin(KEY, 'implement');
    const attempt = begun.activeAttempt!;
    flow.sandbox.leave(attempt, { lost: false });

    holdRelaunches(held);
    await flow.restart();
    await flow.tick();
    await assertInvariants(flow.app);

    const waiting = await find();
    expect(waiting.state).toBe('recovering');
    const view = await flow.app.app.get(RunQueriesService).flow(KEY);
    const chip = view.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'implement');
    expect(chip).toMatchObject({ status: 'waiting' });
    expect(restartWaitSentence(chip!.restartedAt!, (iso) => iso)).toBe(
      `The server restarted at ${chip!.restartedAt}. Waiting for the agent it had started to finish; then this step goes on by itself.`,
    );
    expect(view.actions).toEqual(['stop', 'replay']);
    expect(await flow.sandbox.calls.attemptRunning(attempt)).toBe(true);

    await tickFor(11);
    expect(await flow.sandbox.calls.attemptRunning(attempt)).toBe(false);
    const stored = await flow.app.app.get(CommandRepository).listForRun(waiting.id);
    expect(stored.map((command) => command.idempotencyKey)).toEqual([`relaunch-${attempt}`]);
  });
});
