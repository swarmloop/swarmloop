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
async function waitingRun(app: Awaited<ReturnType<typeof createTestApp>>, spentUsd: number, tokens: number) {
  const runs = app.app.get(RunRepository);
  const run = await save(runs, KEY, 'research', 'waiting');
  run.spentUsd = spentUsd;
  await runs.saveRun(run);
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
      tokensIn: tokens,
      tokensOut: 0,
    }),
  );
}

describe('run driver limits before a resume after waiting', () => {
  it.each([
    ['MAX_RUN_USD', { MAX_RUN_USD: '25' }, 30, 0, 'spent $30.00 of MAX_RUN_USD $25.00; raise MAX_RUN_USD, then Resume'],
    [
      'MAX_RUN_TOKENS',
      { MAX_RUN_TOKENS: '1000' },
      1,
      1200,
      'used 1200 tokens of MAX_RUN_TOKENS 1000; raise MAX_RUN_TOKENS, then Resume',
    ],
  ])('blocks a run over %s that waits on the same step, and starts nothing', async (_name, env, usd, tokens, text) => {
    const app = await createTestApp({ env });
    try {
      const steps = installScripts(app, {}, ['research']);
      await waitingRun(app, usd, tokens);

      const result = await app.app.get(PipelineService).runThrough(KEY, {});

      const stored = await app.app.get(RunRepository).findRun(KEY);
      expect(storedState(stored!)).toMatchObject({ state: 'blocked', reason: { code: 'SPEND_LIMIT', message: text } });
      expect(result.message).toContain('is over the spend limit');
      expect(steps.get('research')?.count).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('blocks a detached start over the limit before anything runs', async () => {
    const app = await createTestApp({ env: { MAX_RUN_TOKENS: '1000' } });
    try {
      installScripts(app, {}, ['research']);
      await waitingRun(app, 1, 1200);

      const result = await app.app.get(PipelineService).startDetached(KEY, {});

      expect(result).toEqual({ exitCode: 1, message: `${KEY} is over the spend limit. research was not started` });
    } finally {
      await app.close();
    }
  });

  it('lets a run under both limits resume', async () => {
    const app = await createTestApp({ env: { MAX_RUN_USD: '25', MAX_RUN_TOKENS: '1000' } });
    try {
      const steps = installScripts(app, { research: () => ({ outcome: 'waiting', exitCode: 0 }) }, ['research']);
      await waitingRun(app, 1, 10);

      await app.app.get(PipelineService).runThrough(KEY, {});

      expect(steps.get('research')?.count).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
