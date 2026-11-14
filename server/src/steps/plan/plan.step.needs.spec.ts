import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { boot, planBlock, result, seed, writeEnv } from './plan.step.spec-helpers';

describe('plan step with needs', () => {
  it('waits with the needs of a subtask whose plan ends with needs:, stores no plan, and ignores the section in any other run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-needs-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-49-t1', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-50', 'billing-api'), { recursive: true });
    const answer = planBlock(['use the retry policy'], { needs: [{ id: 't0', what: 'the retry policy' }] });
    const agent = jest.fn().mockResolvedValue(result(answer));
    const app = await boot(root, agent);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await runs.openWaiting('PROJ-49', '/target');
      await seed(app, 'PROJ-49-t1', '');
      const child = await runs.findRun('PROJ-49-t1');
      await runs.saveRun({ ...child!, parentRunId: parent.id, taskId: 't1' });
      await seed(app, 'PROJ-50', '');

      await app.get(PipelineService).step('plan', 'PROJ-49-t1');
      const waiting = await runs.findRun('PROJ-49-t1');
      expect(waiting?.currentStep).toBe('plan');
      expect(waiting?.status).toBe('waiting');
      expect(await documents.latestBody('PROJ-49-t1', 'needs')).toBe('needs:\n- t0: the retry policy\n');
      expect(JSON.parse((await documents.latestBody('PROJ-49-t1', 'requirements')) ?? '{}').plan).toBeUndefined();

      await app.get(PipelineService).step('plan', 'PROJ-50');
      expect((await runs.findRun('PROJ-50'))?.currentStep).toBe('plan-improve');
      expect(await documents.latestBody('PROJ-50', 'needs')).toBeNull();
    } finally {
      await app.close();
    }
  });
});
