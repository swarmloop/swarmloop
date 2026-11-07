import 'reflect-metadata';

import { existsSync, readFileSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { isAbsolute, join } from 'path';

import { rebaseFeatureRepos } from '../git/rebase';
import { memoryJournal } from '../git/rebase/journal.spec-helpers';

import { FakeClock } from '../core/fake-clock.spec-helpers';

import { featureWorktree, git } from '../testing/runs.spec-helpers';

describe('runs api', () => {
  it('commits a parked index deletion and clears the marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-resume-delete-'));
    const { tree } = featureWorktree(root, 'proj-72');
    const base = git(tree, ['rev-parse', 'origin/main']);
    const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
    const marker = isAbsolute(state) ? state : join(tree, state);
    writeFileSync(marker, `${base}\nfeat(proj-72): Ship the field\n`);
    git(tree, ['rm', 'src/readme.ts']);
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    try {
      const stop = await rebaseFeatureRepos({
        root,
        key: 'proj-72',
        repos: ['demo'],
        branch: 'feature/proj-72-ship-the-field',
        prompt: null,
        denied: ['.env'],
        message: 'feat(proj-72): Ship the field',
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
        journal: memoryJournal(),
      });
      expect(stop).toEqual({ kind: 'clean', leases: [{ repo: 'demo', tip: null }] });
      expect(existsSync(marker)).toBe(false);
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-72): Ship the field');
      expect(git(tree, ['diff', '--name-status', '--format=', 'HEAD^', 'HEAD'])).toContain('D\tsrc/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('src/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('TOKEN=1\n');
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('squashes a staged rename onto the new base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-rename-'));
    const { tree, clone } = featureWorktree(root, 'proj-73');
    git(tree, ['mv', 'src/readme.ts', 'src/guide.ts']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    try {
      const stop = await rebaseFeatureRepos({
        root,
        key: 'proj-73',
        repos: ['demo'],
        branch: 'feature/proj-73-ship-the-field',
        prompt: null,
        denied: [],
        message: 'feat(proj-73): Ship the field',
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
        journal: memoryJournal(),
      });
      expect(stop.kind).toBe('clean');
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      const files = git(tree, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(files).toContain('src/guide.ts');
      expect(files).not.toContain('src/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD^'])).toContain('src/readme.ts');
      expect(readFileSync(join(tree, 'src', 'guide.ts'), 'utf8')).toBe('export const readme = 1;\n');
      expect(existsSync(join(tree, 'src', 'readme.ts'))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });
});
