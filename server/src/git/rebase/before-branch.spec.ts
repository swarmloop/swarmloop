import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';
import { writeFileSync } from 'fs';
import { rebaseFeatureRepos } from '.';
import { isBeforeBranch } from './before-branch';
import { completeRebase } from './journal';
import { memoryJournal } from './journal.spec-helpers';

const hosts = { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() };

/** A worktree that is detached at the old base, as prepare leaves it before the branch step, and a base that moved. */
async function detached(key: string) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-before-branch-'));
  const { tree, clone } = featureWorktree(root, key);
  const branch = `feature/${key}-ship-the-field`;
  git(tree, ['switch', '--detach']);
  git(tree, ['branch', '-D', branch]);
  git(clone, ['switch', 'main']);
  writeFileSync(join(clone, 'moved.ts'), 'export const moved = 1;\n');
  git(clone, ['add', 'moved.ts']);
  git(clone, ['commit', '-m', 'moved']);
  git(clone, ['push', 'origin', 'main']);
  return { root, tree, branch, base: git(clone, ['rev-parse', 'HEAD']) };
}

describe('a worktree before its branch step', () => {
  let previousRoot: string | undefined;

  beforeEach(() => {
    previousRoot = process.env.SWARMLOOP_ROOT;
  });

  afterEach(() => {
    if (previousRoot === undefined) {
      delete process.env.SWARMLOOP_ROOT;
    } else {
      process.env.SWARMLOOP_ROOT = previousRoot;
    }
  });

  it('is before its branch only when it is detached and the branch does not exist', async () => {
    const run = await detached('proj-before-a');

    expect(await isBeforeBranch(run.tree, '', run.branch)).toBe(true);
    expect(await isBeforeBranch(run.tree, run.branch, run.branch)).toBe(false);
    git(run.tree, ['branch', run.branch]);
    expect(await isBeforeBranch(run.tree, '', run.branch)).toBe(false);
  });

  it('stands on the new base and completes its journal, with no branch to be on', async () => {
    const run = await detached('proj-before-b');
    process.env.SWARMLOOP_ROOT = run.root;
    const journal = memoryJournal();

    const stop = await rebaseFeatureRepos({
      root: run.root,
      key: 'proj-before-b',
      repos: ['demo'],
      branch: run.branch,
      prompt: null,
      denied: [],
      message: 'feat(proj-before-b): Ship the field',
      hosts,
      journal,
    });
    await completeRebase(journal, 'proj-before-b');

    expect(stop.kind).toBe('clean');
    expect(git(run.tree, ['rev-parse', 'HEAD'])).toBe(run.base);
    expect(git(run.tree, ['branch', '--show-current'])).toBe('');
    expect(await journal.entry('demo')).toMatchObject({ checkpoint: 'completed', baseSha: run.base });
  });
});
