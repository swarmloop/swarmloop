import { storeRun } from '../testing/store-run.spec-helpers';
import { AgentCallRepository } from '../history/agent-call.repository';
import { seedCall } from '../history/agent-call.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { storedState, writeRunState } from '../history/run-state';
import { createTestApp, type TestApp } from '../testing/test-app';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';

const KEY = 'PROJ-1';

async function block(app: TestApp, step: string, code: string, message: string, spentUsd = 0): Promise<void> {
  const runs = app.app.get(RunRepository);
  const run = await runs.begin(KEY, step);
  writeRunState(run, { status: 'blocked', currentStep: step, reason: { code, message } });
  await storeRun(runs, run);
  if (spentUsd > 0) await seedCall(app.app.get(AgentCallRepository), { runKey: KEY, step, usd: spentUsd });
}

async function loopMark(app: TestApp): Promise<number> {
  return (await app.app.get(DocumentRepository).latestDocument(KEY, 'loop_mark'))?.id ?? 0;
}

describe('resume of a limit block', () => {
  it('accepts Resume of LOOP_LIMIT and writes a new loop mark', async () => {
    const app = await createTestApp();
    try {
      await block(
        app,
        'code-review',
        'LOOP_LIMIT',
        'code-review ran 3 times (MAX_RETURNS); Resume starts another round',
      );
      const run = (await app.app.get(RunRepository).findRun(KEY))!;
      await app.app.get(DocumentRepository).putDocument(run, 'implementation', '- changed the field\n');
      await app.app.get(DocumentRepository).putDocument(run, 'requirements', '{"prompt":"Ship the field"}\n');
      expect((await app.app.get(RunQueriesService).flow(KEY)).resume).toBe('ready');
      const before = await loopMark(app);
      await app.app.get(RunCommandsService).resume(KEY);
      await app.pipeline.whenIdle(KEY);
      expect(await loopMark(app)).toBeGreaterThan(before);
    } finally {
      await app.close();
    }
  });

  it("accepts a person's Resume of SPEND_LIMIT and runs the step past the limit", async () => {
    const app = await createTestApp({ env: { MAX_RUN_USD: '25' } });
    try {
      await block(
        app,
        'research',
        'SPEND_LIMIT',
        'spent $30.00 of MAX_RUN_USD $25.00. Resume runs the step past the limit; a higher MAX_RUN_USD lets the run go on by itself',
        30,
      );
      await app.app.get(RunCommandsService).resume(KEY);
      await app.pipeline.whenIdle(KEY);
      const after = (await app.app.get(RunRepository).findRun(KEY))!;
      const visits = await app.app.get(VisitRepository).listStats(after.id);
      // The step ran past the limit; the machine's next start is held back by it again.
      expect(visits.map((visit) => [visit.step, visit.status])).toEqual([['research', 'done']]);
      expect(after.currentStep).toBe('plan');
      expect(storedState(after).reason?.code).toBe('SPEND_LIMIT');
    } finally {
      await app.close();
    }
  });
});
