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
import { NEEDS_ANSWERS } from '../contract/run-state';
import { writeRunState } from '../history/run-state';
import { SubtaskPort } from '../pipeline/subtask-port';
import { renderQuestions } from '../steps/research/research-record';
import { questionFor } from '../steps/implement/split-questions';

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

  it('resumes an epic that waits on questions when the skip closes the question of the part', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-part-skip-'));
    const app = await seededBoot(root);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await save(runs, 'epic-skip-asks', 'implement', 'waiting');
      parent.split = true;
      parent.projects = 'demo\n';
      writeRunState(parent, {
        status: 'waiting',
        currentStep: 'implement',
        reason: { code: NEEDS_ANSWERS, message: 'questions are open' },
      });
      await storeRun(runs, parent);
      await documents.putDocument(parent, 'requirements', `${JSON.stringify({ prompt: 'Move it\n', tickets: [] })}\n`);
      await documents.putDocument(parent, 'subtasks', `${JSON.stringify([task])}\n`);
      await documents.putDocument(
        parent,
        'subtask_questions',
        renderQuestions([questionFor(task.id, 'Which one?', '2026-01-01T00:00:00.000Z')]),
      );
      const port = app.get(SubtaskPort);
      jest.spyOn(port, 'stop').mockResolvedValue();
      const resumed = jest.spyOn(port, 'resumeParent').mockResolvedValue();
      const commands = app.get(RunSubtaskCommandsService);
      await commands.openSubtask(parent, task);

      await commands.skipTask(parent.key, task.id);

      expect(resumed.mock.calls.map((call) => call[0].key)).toEqual([parent.key]);
    } finally {
      await app.close();
    }
  });
});
