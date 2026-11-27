import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { REASON } from '../contract/run-state';
import { storedState, writeRunState } from '../history/run-state';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { save } from '../testing/runs.spec-helpers';
import { storeRun } from '../testing/store-run.spec-helpers';
import { RunCommandsService } from './run-commands.service';
import { RunQueriesService } from './run-queries.service';
import { seededBoot } from './runs-boot.spec-helpers';

async function blockedAtChecks(root: string) {
  const pipeline = {
    startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }),
    claimed: () => false,
  };
  const app = await seededBoot(root, pipeline);
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const run = await save(runs, 'proj-checks', 'checks', 'blocked');
  await documents.putDocument(run, 'issues', '- npm test failed\n');
  writeRunState(run, { status: 'blocked', reason: { code: REASON.checkFailed, message: 'blocked' } });
  await storeRun(runs, run);
  runs.notify('proj-checks');
  return { app, pipeline, runs, documents };
}

describe('the Resume of a block from a repeated required check', () => {
  it('reads that it returns to implementation and starts implement with the stored notes when blocked at checks', async () => {
    const { app, pipeline, runs, documents } = await blockedAtChecks(
      await mkdtemp(join(tmpdir(), 'swarmloop-check-block-')),
    );
    try {
      const flow = await app.get(RunQueriesService).flow('proj-checks');
      expect(flow.sentence).toContain('Resume returns to implementation with the stored notes');
      await app.get(RunCommandsService).resume('proj-checks');
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-checks', {}, 'implement');
      expect(await documents.latestBody('proj-checks', 'issues')).toBe('- npm test failed\n');
      expect(storedState((await runs.findRun('proj-checks'))!).reason?.code).toBe(REASON.checkFailed);
    } finally {
      await app.close();
    }
  });

  it("starts the run's own step when the machine resumes it after a move onto a new tree", async () => {
    const { app, pipeline } = await blockedAtChecks(await mkdtemp(join(tmpdir(), 'swarmloop-check-block-')));
    try {
      await app.get(RunCommandsService).resume('proj-checks', undefined, { by: 'machine', level: null });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-checks', { startBy: 'machine', level: null });
    } finally {
      await app.close();
    }
  });
});
