import 'reflect-metadata';

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { boot, git, repoWithMain } from '../steps/prepare/prepare.step.spec-helpers';
import { RunFolders } from './run-folders';

describe('run folders', () => {
  it('removes a dirty worktree and leaves the checkout branch', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-remove-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'demo');
    const tree = join(swarm, 'worktrees', 'PROJ-70', 'demo');
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '-b', 'feature/PROJ-70-ship', tree, 'main']);
    writeFileSync(join(tree, 'dirty.txt'), 'dirty\n');
    const app = await boot(swarm, '..');
    try {
      await app.get(RunFolders).remove('PROJ-70');
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-70'))).toBe(false);
      expect(existsSync(join(clone, 'README'))).toBe(true);
      expect(git(clone, ['branch', '--list', 'feature/PROJ-70-ship'])).toBe('feature/PROJ-70-ship');
      expect(git(clone, ['worktree', 'list'])).not.toContain(tree);
    } finally {
      await app.close();
    }
  });

  it('deletes a worktree when the checkout is already gone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-remove-missing-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'demo');
    const tree = join(swarm, 'worktrees', 'PROJ-71', 'demo');
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '--detach', tree, 'main']);
    rmSync(clone, { recursive: true, force: true });
    const app = await boot(swarm, '..');
    try {
      await app.get(RunFolders).remove('PROJ-71');
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-71'))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
