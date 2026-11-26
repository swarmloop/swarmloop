import 'reflect-metadata';
import { CheckCommandRepository } from '../../history/check-command.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { storedState } from '../../history/run-state';
import { createFlowHarness } from '../flow-harness';
import { approvedRun } from '../implement-flow.spec-helpers';
import type { TestApp } from '../test-app';
import { assertSettled, settle } from './settle.spec-helpers';

const KEY = 'PROJ-1';

/** The visits the run stored, as step, status and why they ended. */
async function visitsOf(app: TestApp, key: string): Promise<[string, string, string | null][]> {
  const run = (await app.app.get(RunRepository).findRun(key))!;
  const stats = await app.app.get(VisitRepository).listStats(run.id);
  return stats.map((visit) => [visit.step, visit.status, visit.killReason]);
}

/** The state the run settled in. */
async function settledAt(app: TestApp): Promise<string> {
  return storedState((await app.app.get(RunRepository).findRun(KEY))!).state;
}

describe('a server restart inside a step: the new process takes the run over through the reconciler', () => {
  describe('inside a running agent visit', () => {
    let flow: Awaited<ReturnType<typeof createFlowHarness>>;
    beforeEach(async () => {
      flow = await createFlowHarness(KEY);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await flow.close();
    });

    it('closes the cut visit as died and runs the step again, once, in the new process', async () => {
      await approvedRun(flow, KEY, 'implement');
      await flow.app.app.get(RunRepository).begin(KEY, 'implement');

      await flow.restart();
      await settle(flow.app);

      expect((await visitsOf(flow.app, KEY))[0]).toEqual(['implement', 'failed', 'process died']);
      expect(flow.app.blocks.steps.filter((step) => step === 'implement')).toHaveLength(1);
      expect((await flow.app.app.get(RunRepository).findRun(KEY))!.activeAttempt).toBeNull();
      expect(await settledAt(flow.app)).toBe('done');
      await assertSettled(flow.app);
    });
  });

  describe('inside checks', () => {
    let flow: Awaited<ReturnType<typeof createFlowHarness>>;
    beforeEach(async () => {
      flow = await createFlowHarness(KEY, { realHost: true });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await flow.close();
    });

    it('closes the open check rows as interrupted and starts the checks again with no wait', async () => {
      await flow.begin('merge-request');
      const begun = await flow.app.app.get(RunRepository).begin(KEY, 'checks');
      await flow.app.app.get(CheckCommandRepository).add({
        runId: begun.id,
        attemptId: begun.activeAttempt!,
        repo: 'demo',
        command: 'npm test',
        commandIndex: 0,
        status: 'running',
        startedAt: flow.app.clock.iso(),
      });

      await flow.restart();
      await settle(flow.app);

      const stored = await flow.app.app.get(CheckCommandRepository).list(begun.id);
      expect(stored.map((row) => row.status)).toEqual(['interrupted']);
      expect((await visitsOf(flow.app, KEY))[0]).toEqual(['checks', 'failed', 'process died']);
      expect(storedState((await flow.app.app.get(RunRepository).findRun(KEY))!).state).not.toBe('recovering');
      expect(await settledAt(flow.app)).toBe('done');
      await assertSettled(flow.app);
    });
  });

  describe('inside a server pass', () => {
    let flow: Awaited<ReturnType<typeof createFlowHarness>>;
    beforeEach(async () => {
      flow = await createFlowHarness(KEY, { realHost: true });
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      await flow.close();
    });

    it('commit: the pass the restart cut is taken over and the run settles', async () => {
      await flow.begin('merge-request');
      await flow.app.app.get(RunRepository).begin(KEY, 'commit');

      await flow.restart();
      await settle(flow.app);

      expect((await visitsOf(flow.app, KEY))[0]).toEqual(['commit', 'failed', 'process died']);
      expect((await flow.app.app.get(RunRepository).findRun(KEY))!.activeAttempt).toBeNull();
      expect(await settledAt(flow.app)).toBe('done');
      await assertSettled(flow.app);
    });

    it('merge request: the new process finds or opens the one request and ends with it', async () => {
      await flow.begin('merge-request');
      await flow.app.app.get(RunRepository).begin(KEY, 'merge-request');

      await flow.restart();
      await settle(flow.app);

      expect((await visitsOf(flow.app, KEY))[0]).toEqual(['merge-request', 'failed', 'process died']);
      expect(flow.host.opened).toBe(1);
      expect(await settledAt(flow.app)).toBe('done');
      await assertSettled(flow.app);
    });
  });
});
