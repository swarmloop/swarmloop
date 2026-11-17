import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';
import { gitOutput } from '../testing/git-fixture';
import { checkoutSnapshot, requiredTreeFingerprint, worktreeFingerprint, worktreeSnapshot } from './worktree-git';

function git(repo: string, args: string[]): string {
  return gitOutput(repo, ['-C', repo, ...args]);
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

    mkdirSync(join(repo, 'out'));
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

describe('worktrees with no tree', () => {
  it('fails the snapshot of a folder that is not a repository, and the checkout snapshot reads its status', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'swarmloop-plain-'));
    const mounts = [{ hostPath: folder, containerPath: '/work' }];

    await expect(worktreeSnapshot(mounts)).rejects.toThrow(`${basename(folder)}: no git tree at ${folder}`);
    await expect(requiredTreeFingerprint(mounts)).rejects.toThrow('no git tree at');
    await expect(worktreeFingerprint(mounts)).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives a subdirectory of a repository today's results for a checkout", async () => {
    const { repo } = makeRepo();
    mkdirSync(join(repo, 'sub'));
    const mounts = [{ hostPath: join(repo, 'sub'), containerPath: '/work' }];

    await expect(checkoutSnapshot(mounts)).resolves.toContain('sub\n');
    await expect(worktreeFingerprint(mounts)).resolves.toBe(createHash('sha256').update('sub').digest('hex'));
  });

  it('gives a repository the same fingerprint either way', async () => {
    const { mounts } = makeRepo();

    expect(await requiredTreeFingerprint(mounts)).toBe(await worktreeFingerprint(mounts));
  });
});
