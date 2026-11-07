import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { REBASE_JOURNAL, parseJournal } from '../git/rebase';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { RunRebase } from '../steps/run-rebase';
import { boot, featureWorktree, git, remember } from '../testing/runs.spec-helpers';
import { RunCommandsService } from './run-commands.service';
import { RunRebaseService } from './run-rebase.service';

/** The base of `repo` moves on: one more commit on `main`, pushed. `file` decides whether it conflicts with the branch. */
function moveBase(clone: string, file: string, text: string): string {
  git(clone, ['switch', 'main']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', file), text);
  git(clone, ['add', `src/${file}`]);
  git(clone, ['commit', '-m', `base ${file}`]);
  git(clone, ['push', 'origin', 'main']);
  return git(clone, ['rev-parse', 'main']);
}

function commitField(tree: string): void {
  writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
  git(tree, ['add', 'src/field.ts']);
  git(tree, ['commit', '-m', 'field']);
}

describe('rebase journal', () => {
  it('raises the generation and journals each repo through every checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-journal-'));
    const { tree, clone } = featureWorktree(root, 'proj-90');
    commitField(tree);
    const branch = 'feature/proj-90-ship-the-field';
    git(tree, ['push', '-u', 'origin', branch]);
    const tip = git(tree, ['rev-parse', 'HEAD']);
    const base = moveBase(clone, 'base.ts', 'export const base = 1;\n');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-90 started' }) };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      await remember(runs, documents, 'proj-90', 'done', 'done');
      expect((await runs.findRun('proj-90'))?.generation).toBe(0);
      await app.get(RunRebaseService).rebase('proj-90');
      expect((await runs.findRun('proj-90'))?.generation).toBe(1);
      const journal = parseJournal(await documents.latestBody('proj-90', REBASE_JOURNAL));
      expect(journal.demo).toEqual({
        path: tree,
        branch,
        oldHead: tip,
        fingerprint: expect.any(String),
        protectRef: `refs/swarmloop/pre-rebase/${branch}`,
        expectedRemoteTip: tip,
        baseSha: base,
        checkpoint: 'completed',
        squashSha: git(tree, ['rev-parse', 'HEAD']),
        generation: 1,
      });
    } finally {
      await app.close();
    }
  });

  it('skips the repo that completed and resumes the one in conflict from its stored base after a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-partial-'));
    const a = featureWorktree(root, 'proj-91', 'demo');
    const b = featureWorktree(root, 'proj-91', 'web');
    commitField(a.tree);
    commitField(b.tree);
    const baseA = moveBase(a.clone, 'base.ts', 'export const base = 1;\n');
    const baseB = moveBase(b.clone, 'field.ts', 'export const field = 2;\n');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-91 started' }) };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-91', 'failed', 'failed');
      await documents.putDocument(run, 'repos', 'demo\nweb\n');
      await app.get(RunRebaseService).rebase('proj-91');
      const stored = parseJournal(await documents.latestBody('proj-91', REBASE_JOURNAL));
      expect(stored.demo?.checkpoint).toBe('completed');
      expect(stored.web?.checkpoint).toBe('conflict');
      expect(stored.web?.baseSha).toBe(baseB);
      const applied = git(a.tree, ['rev-parse', 'HEAD']);
      expect(git(a.tree, ['rev-parse', 'HEAD^'])).toBe(baseA);
      // The bases move on again before the restart.
      moveBase(a.clone, 'later.ts', 'export const later = 1;\n');
      moveBase(b.clone, 'later.ts', 'export const later = 1;\n');
      writeFileSync(join(b.tree, 'src', 'field.ts'), 'export const field = 3;\n');
      await app.get(RunRebase).rebase('proj-91', true);
      expect(git(a.tree, ['rev-parse', 'HEAD'])).toBe(applied);
      expect(git(b.tree, ['rev-parse', 'HEAD^'])).toBe(baseB);
      const done = parseJournal(await documents.latestBody('proj-91', REBASE_JOURNAL));
      expect(done.demo?.checkpoint).toBe('completed');
      expect(done.web?.checkpoint).toBe('completed');
      expect((await runs.findRun('proj-91'))?.generation).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('sends a run that failed at merge-request back through code-review after a Rebase', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-merge-request-'));
    const { tree, clone } = featureWorktree(root, 'proj-93');
    commitField(tree);
    moveBase(clone, 'base.ts', 'export const base = 1;\n');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-93 started' }) };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-93', 'merge-request', 'failed');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      await app.get(RunRebaseService).rebase('proj-93');
      const next = await runs.findRun('proj-93');
      expect(next).toMatchObject({ status: 'waiting', currentStep: 'code-review', generation: 1 });
      expect(await documents.latestBody('proj-93', 'rebase_merge_skip')).toBeNull();
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-93');
    } finally {
      await app.close();
    }
  });

  it('raises the generation when a Replay is accepted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-replay-generation-'));
    const pipeline = {
      startDetached: jest.fn(),
      replay: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-92 started' }),
    };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      await remember(runs, app.get(DocumentRepository), 'proj-92', 'implement', 'failed');
      await app.get(RunCommandsService).replay('proj-92', 'implement', 'again');
      expect((await runs.findRun('proj-92'))?.generation).toBe(1);
    } finally {
      await app.close();
    }
  });
});
