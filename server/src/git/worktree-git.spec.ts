import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SandboxMount } from '../sandbox/sandbox-launch';
import { worktreeSnapshot } from './worktree-git';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function makeRepo(): { repo: string; mounts: SandboxMount[] } {
  const repo = mkdtempSync(join(tmpdir(), 'swarmloop-worktree-git-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'dev@example.com']);
  git(repo, ['config', 'user.name', 'Dev']);
  writeFileSync(join(repo, 'kept'), 'one\n');
  git(repo, ['add', 'kept']);
  git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'one']);
  return { repo, mounts: [{ hostPath: repo, containerPath: '/work' }] };
}

describe('worktreeSnapshot', () => {
  it('changes when a file git does not track yet is edited', async () => {
    const { repo, mounts } = makeRepo();
    writeFileSync(join(repo, 'created.ts'), 'export const a = 1;\n');
    const first = await worktreeSnapshot(mounts);
    expect(await worktreeSnapshot(mounts)).toBe(first);

    writeFileSync(join(repo, 'created.ts'), 'export const a = 2;\n');

    expect(await worktreeSnapshot(mounts)).not.toBe(first);
  });

  it('changes when a tracked file is edited and ignores ignored files', async () => {
    const { repo, mounts } = makeRepo();
    writeFileSync(join(repo, '.gitignore'), 'out/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'ignore']);
    const clean = await worktreeSnapshot(mounts);

    execFileSync('mkdir', [join(repo, 'out')]);
    writeFileSync(join(repo, 'out', 'big.js'), 'x\n');
    expect(await worktreeSnapshot(mounts)).toBe(clean);

    writeFileSync(join(repo, 'kept'), 'two\n');
    expect(await worktreeSnapshot(mounts)).not.toBe(clean);
  });

  it('leaves the real index alone', async () => {
    const { repo, mounts } = makeRepo();
    writeFileSync(join(repo, 'created.ts'), 'x\n');

    await worktreeSnapshot(mounts);

    expect(git(repo, ['status', '--porcelain']).trim()).toBe('?? created.ts');
  });
});
