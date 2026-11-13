import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { RunRebase } from '../steps/run-rebase';
import { boot, remember, featureWorktree, git } from '../testing/runs.spec-helpers';

/** A done subtask on a feature branch that adds `src/field.ts`, and a base that moved on with `src/base.ts` or, when `clash`, with the same file. */
async function rebasedSubtask(key: string, clash: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-subtask-rebase-'));
  const { tree, clone } = featureWorktree(root, key);
  writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
  git(tree, ['add', 'src/field.ts']);
  git(tree, ['commit', '-m', 'field']);
  git(clone, ['switch', 'main']);
  writeFileSync(join(clone, 'src', clash ? 'field.ts' : 'base.ts'), 'export const base = 2;\n');
  git(clone, ['add', '.']);
  git(clone, ['commit', '-m', 'base']);
  git(clone, ['push', 'origin', 'main']);
  const app = await boot(root, { startDetached: jest.fn() });
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const run = await remember(runs, documents, key, 'done', 'done');
  run.parentRunId = run.id;
  await runs.saveRun(run);
  await documents.putDocument(run, 'implementation', '- changed the field\n');
  git(tree, ['push', '-u', 'origin', `feature/${key}-ship-the-field`]);
  return { app, runs, documents, flows: app.get(FlowRepository) };
}

describe('the rebase of a done subtask by its parent', () => {
  it('keeps its code review when the rebase leaves its own diff as it was: checks and CI run again', async () => {
    const { app, runs, flows } = await rebasedSubtask('proj-81', false);
    try {
      await app.get(RunRebase).rebase('proj-81', false, true);

      const fresh = await runs.findRun('proj-81');
      expect(fresh?.currentStep).toBe('checks');
      const phases = JSON.parse((await flows.listFlows(fresh?.id ?? 0)).at(-1)?.phases ?? '[]') as string[];
      expect(phases).toEqual(expect.arrayContaining(['checks', 'ci']));
      expect(phases).not.toContain('code-review');
    } finally {
      await app.close();
    }
  });

  it('goes back to the implement step when the rebase conflicts, so the review does not stand', async () => {
    const { app, runs } = await rebasedSubtask('proj-82', true);
    try {
      await app.get(RunRebase).rebase('proj-82', false, true);

      expect((await runs.findRun('proj-82'))?.currentStep).toBe('implement');
    } finally {
      await app.close();
    }
  });
});
