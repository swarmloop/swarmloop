import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { FlowRepository } from '../history/flow.repository';
import { RunRebase } from '../steps/run-rebase';
import { remember, featureWorktree, git } from '../testing/runs.spec-helpers';
import { seededBoot } from './runs-boot.spec-helpers';

/** A done subtask on a feature branch that adds `src/field.ts`, and a base that moved on with `src/base.ts` or, when `clash`, with the same file. */
async function rebasedSubtask(key: string, clash: boolean, status = 'done') {
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
  const app = await seededBoot(root, { startDetached: jest.fn() });
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const run = await remember(runs, documents, key, status === 'done' ? 'done' : 'pipeline', status);
  run.parentRunId = run.id;
  await storeRun(runs, run);
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
      const rows = await flows.listFlows(fresh?.id ?? 0);
      expect(rows.at(-1)?.cause).toBe('rebase');
      const phases = JSON.parse(rows.at(-1)?.phases ?? '[]') as string[];
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

  it.each([false, true])('leaves a blocked subtask blocked after the rebase (conflict: %s)', async (clash) => {
    const { app, runs } = await rebasedSubtask(`proj-8${clash ? 4 : 3}`, clash, 'blocked');
    try {
      const next = await app.get(RunRebase).rebase(`proj-8${clash ? 4 : 3}`, false, true);

      const fresh = await runs.findRun(`proj-8${clash ? 4 : 3}`);
      expect(next).toBe('stay');
      expect(fresh?.status).toBe('blocked');
      expect(fresh?.currentStep).toBe('pipeline');
    } finally {
      await app.close();
    }
  });

  it.each([false, true])('keeps a waiting subtask in its wait after the rebase (conflict: %s)', async (clash) => {
    const key = `proj-8${clash ? 6 : 5}`;
    const { app, runs, documents } = await rebasedSubtask(key, clash, 'waiting');
    try {
      const next = await app.get(RunRebase).rebase(key, false, true, false, true);

      const fresh = await runs.findRun(key);
      expect(next).toBe('stay');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('pipeline');
      const pending = await documents.latestBody(key, 'rebase_conflict');
      expect(pending?.startsWith('pending') ?? false).toBe(clash);
    } finally {
      await app.close();
    }
  });
});
