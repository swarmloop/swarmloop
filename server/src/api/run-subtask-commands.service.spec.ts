import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { save } from '../testing/runs.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';
import { RunSubtaskCommandsService } from './run-subtask-commands.service';
import type { Subtask } from '../contract/subtask';

describe('a part of a slug run', () => {
  const task: Subtask = {
    id: 'main-move-and-stored-block',
    title: 'Move the block',
    description: 'Move it.',
    depends: [],
    files: ['src/a.ts'],
    proof: 'a test',
    status: 'pending',
  };

  it('opens and launches under a key longer than a run id may be', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-part-key-'));
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'started' }) };
    const app = await seededBoot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const parent = await save(runs, 'epic-conflict-implement-mwu2hcx3', 'implement', 'waiting');
      parent.split = true;
      parent.projects = 'demo\n';
      await storeRun(runs, parent);
      const documents = app.get(DocumentRepository);
      await documents.putDocument(parent, 'requirements', `${JSON.stringify({ prompt: 'Move it\n', tickets: [] })}\n`);
      await documents.putDocument(parent, 'contract', '- decided: keep it\n');
      const commands = app.get(RunSubtaskCommandsService);

      const run = await commands.openSubtask(parent, task);
      await commands.launchSubtask(parent, task);

      const key = 'epic-conflict-implement-mwu2hcx3-main-move-and-stored-block';
      expect(run).toMatchObject({ key, parentRunId: parent.id, taskId: task.id });
      expect(pipeline.startDetached.mock.calls.map((call) => call[0] as string)).toEqual([key]);
    } finally {
      await app.close();
    }
  });
});
