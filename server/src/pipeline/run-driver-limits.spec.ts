import { AgentCallRepository } from '../history/agent-call.repository';
import { seedCall } from '../history/agent-call.spec-helpers';
import { StepStatEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { storedState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { createTestApp } from '../testing/test-app';
import { save } from '../testing/runs.spec-helpers';
import { installScripts, KEY } from './run-driver.spec-helpers';
import { PipelineService } from './pipeline.service';

/** A run that waits on `research`, which its last visit left waiting: the shape every resume after `waiting` starts from. */
async function waitingRun(app: Awaited<ReturnType<typeof createTestApp>>, spentUsd: number) {
  const runs = app.app.get(RunRepository);
  const run = await save(runs, KEY, 'research', 'waiting');
  await seedCall(app.app.get(AgentCallRepository), {
    runKey: run.key,
    step: 'research',
    usd: spentUsd,
  });
  await app.app
    .get(DocumentRepository)
    .putDocument(run, 'requirements', `${JSON.stringify({ prompt: 'p', tickets: [] })}\n`);
  const now = new Date().toISOString();
  await app.app.get(VisitRepository).saveStat(
    Object.assign(new StepStatEntity(), {
      runId: run.id,
      step: 'research',
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      status: 'waiting',
    }),
  );
}

describe('run driver limits before a resume after waiting', () => {
  it("blocks a machine's start over MAX_RUN_USD on the same waiting step, and starts nothing", async () => {
    const app = await createTestApp({ env: { MAX_RUN_USD: '25' } });
    try {
      const steps = installScripts(app, {}, ['research']);
      await waitingRun(app, 30);

      const result = await app.app.get(PipelineService).runThrough(KEY, { startBy: 'machine' });

      const stored = await app.app.get(RunRepository).findRun(KEY);
      expect(storedState(stored!)).toMatchObject({
        state: 'blocked',
        reason: {
          code: 'SPEND_LIMIT',
          message:
            'spent $30.00 of MAX_RUN_USD $25.00. Resume runs the step past the limit; a higher MAX_RUN_USD lets the run go on by itself',
        },
      });
      expect(result.message).toContain('is over the spend limit');
      expect(steps.get('research')?.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("runs a person's start over the limit", async () => {
    const app = await createTestApp({ env: { MAX_RUN_USD: '25' } });
    try {
      const steps = installScripts(app, { research: () => ({ outcome: 'waiting', exitCode: 0 }) }, ['research']);
      await waitingRun(app, 30);

      await app.app.get(PipelineService).runThrough(KEY, {});

      expect(steps.get('research')?.count).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it('lets a run under the limit resume', async () => {
    const app = await createTestApp({ env: { MAX_RUN_USD: '25' } });
    try {
      const steps = installScripts(app, { research: () => ({ outcome: 'waiting', exitCode: 0 }) }, ['research']);
      await waitingRun(app, 1);

      await app.app.get(PipelineService).runThrough(KEY, {});

      expect(steps.get('research')?.count).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
