import { AppConfig } from '../config/env';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { createTestApp, type TestApp } from '../testing/test-app';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';

const KEY = 'PROJ-1';

async function block(app: TestApp, step: string, code: string, message: string, spentUsd = 0): Promise<void> {
  const runs = app.app.get(RunRepository);
  const run = await runs.begin(KEY, step);
  writeRunState(run, { status: 'blocked', currentStep: step, reason: { code, message } });
  run.spentUsd = spentUsd;
  await runs.saveRun(run);
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

  it('accepts Resume of SPEND_LIMIT, checks the spend again and goes on once MAX_RUN_USD is raised', async () => {
    const app = await createTestApp({ env: { MAX_RUN_USD: '25' } });
    try {
      await block(
        app,
        'research',
        'SPEND_LIMIT',
        'spent $30.00 of MAX_RUN_USD $25.00; raise MAX_RUN_USD, then Resume',
        30,
      );
      const commands = app.app.get(RunCommandsService);
      await expect(commands.resume(KEY)).rejects.toThrow('is over the spend limit');
      await app.pipeline.whenIdle(KEY);
      const stillBlocked = (await app.app.get(RunRepository).findRun(KEY))!;
      expect(stillBlocked.status).toBe('blocked');
      expect(stillBlocked.stateReason).toContain('SPEND_LIMIT');
      app.app.get(AppConfig).env.MAX_RUN_USD = 100;
      await commands.resume(KEY);
      await app.pipeline.whenIdle(KEY);
      expect((await app.app.get(RunRepository).findRun(KEY))!.status).not.toBe('blocked');
    } finally {
      await app.close();
    }
  });
});
