import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeRepo, runGit } from '../git/git-repo.spec-helpers';
import { projectGitMount } from './project-git';

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
    expect(
      execFileSync('git', ['--git-dir', mount.hostPath, '--work-tree', tree, 'ls-files'], { encoding: 'utf8' }),
    ).toBe('test.py\n');
    expect(runGit(source, ['config', 'http.extraheader']).trim()).toBe('Authorization: secret');
  });

  it('leaves non-Git project directories alone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swarmloop-project-no-git-'));
    expect(await projectGitMount({ hostPath: directory, containerPath: '/work' }, directory)).toEqual([]);
  });
});
