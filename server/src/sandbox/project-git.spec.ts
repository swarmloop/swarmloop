import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeRepo, runGit } from '../git/git-repo.spec-helpers';
import { clearGitFaults, distrustGit } from '../testing/git-fault.spec-helpers';
import { gitOutput } from '../testing/git-fixture';
import { projectGitMount } from './project-git';

import type * as GitFault from '../testing/git-fault.spec-helpers';

jest.mock('child_process', () =>
  jest.requireActual<typeof GitFault>('../testing/git-fault.spec-helpers').faultyChildProcess(),
);

describe('portable project Git metadata', () => {
  it('lets checks read a linked worktree without exposing host config or mutable Git state', async () => {
    const source = makeRepo({ 'test.py': 'print(1)\n' });
    runGit(source, ['config', 'http.extraheader', 'Authorization: secret']);
    const directory = mkdtempSync(join(tmpdir(), 'swarmloop-project-git-'));
    const tree = join(directory, 'worktree');
    runGit(source, ['worktree', 'add', '--detach', tree]);
    const mounts = await projectGitMount({ hostPath: tree, containerPath: '/work/app' }, directory);
    const mount = mounts[0];
    expect(mounts[1]).toMatchObject({ containerPath: '/work/app/.git', readonly: true });
    expect(readFileSync(mounts[1].hostPath, 'utf8')).toBe(`gitdir: ${mount.containerPath}\n`);
    const config = readFileSync(join(mount.hostPath, 'config'), 'utf8');
    expect(config).not.toContain('secret');
    expect(config).not.toContain(source);
    expect(existsSync(join(mount.hostPath, 'objects/info/alternates'))).toBe(false);
    expect(gitOutput(tree, ['--git-dir', mount.hostPath, '--work-tree', tree, 'ls-files'])).toBe('test.py\n');
    expect(runGit(source, ['config', 'http.extraheader']).trim()).toBe('Authorization: secret');
  });

  it('leaves non-Git project directories alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarmloop-project-no-git-'));
    expect(await projectGitMount({ hostPath: directory, containerPath: '/work' }, directory)).toEqual([]);
  });

  describe('a checkout the server user does not own', () => {
    let root: string;
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.SWARMLOOP_ROOT;
      root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-root-')));
      process.env.SWARMLOOP_ROOT = root;
    });

    afterEach(() => {
      clearGitFaults();
      if (saved === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = saved;
      }
      rmSync(root, { recursive: true, force: true });
    });

    function worktreeAt(parent: string): string {
      const source = makeRepo({ 'test.py': 'print(1)\n' });
      const tree = join(parent, 'PROJ-1', 'app');
      mkdirSync(join(parent, 'PROJ-1'), { recursive: true });
      runGit(source, ['worktree', 'add', '--detach', tree]);
      return tree;
    }

    it('is cloned when it is under the roots', async () => {
      const tree = worktreeAt(join(root, 'worktrees'));
      distrustGit(join(root, 'worktrees'));

      const mounts = await projectGitMount({ hostPath: tree, containerPath: '/work/app' }, root);

      expect(gitOutput(tree, ['--git-dir', mounts[0].hostPath, 'ls-files'])).toBe('test.py\n');
    });

    it('is refused when it is outside the roots', async () => {
      const tree = worktreeAt(join(root, 'elsewhere'));
      distrustGit(join(root, 'elsewhere'));

      await expect(projectGitMount({ hostPath: tree, containerPath: '/work/app' }, root)).rejects.toThrow(
        'dubious ownership',
      );
    });
  });
});
