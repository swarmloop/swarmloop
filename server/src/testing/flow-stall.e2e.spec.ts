import 'reflect-metadata';
import { StepStatEntity } from '../history/entities';
import { CommandRepository } from '../history/command.repository';
import { VisitRepository } from '../history/visit.repository';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';

const KEY = 'PROJ-487';
const MINUTE = 60_000;

describe('a run that stopped moving with no reason', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('breaks the flow invariant until the stall pass resumes it after 15 minutes, and then goes on', async () => {
    const run = await flow.begin('plan');
    const now = flow.app.clock.iso();
    await flow.app.app.get(VisitRepository).saveStat(
      Object.assign(new StepStatEntity(), {
        runId: run.id,
        step: 'plan',
        attempt: 1,
        attemptId: 'attempt-1',
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        status: 'waiting',
      }),
    );

    await flow.tick();
    await expect(assertInvariants(flow.app)).rejects.toThrow('started and is idle with no reason');

    flow.app.clock.advance(15 * MINUTE);
    await flow.app.app.get(Reconciler).resumeStalled();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);

    const stored = await flow.app.app.get(CommandRepository).listForRun(run.id);
    expect(stored.map((command) => command.idempotencyKey)).toEqual([`stall-${KEY}-attempt-1-1`]);
    const after = await flow.app.app.get(RunRepository).findRun(KEY);
    expect(after?.state).not.toBe('idle');
    await assertInvariants(flow.app);
  });
});
