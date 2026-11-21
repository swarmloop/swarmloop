import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handToSandbox, SandboxOwnership } from './sandbox-owner';

describe('handToSandbox', () => {
  const own = process.getuid?.() ?? 0;

  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-owner-'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'file.txt'), 'x');
    const outside = mkdtempSync(join(tmpdir(), 'swarmloop-outside-'));
    writeFileSync(join(outside, 'secret'), 'x');
    symlinkSync(outside, join(root, 'link'));
    return root;
  }

  it('hands over every entry the uid does not own, and only those', async () => {
    const root = tree();
    const calls: [string, number, number][] = [];
    const handed = await handToSandbox(root, own + 1, async (path, uid, gid) => {
      calls.push([path, uid, gid]);
    });
    expect(handed.sort()).toEqual([root, join(root, 'link'), join(root, 'sub'), join(root, 'sub', 'file.txt')].sort());
    expect(calls.every(([, uid, gid]) => uid === own + 1 && gid === own + 1)).toBe(true);
    await expect(handToSandbox(root, own, async () => undefined)).resolves.toEqual([]);
  });

  it('does not follow a symlink into the folder it points to', async () => {
    const root = tree();
    const handed = await handToSandbox(root, own + 1, async () => undefined);
    expect(handed.some((path) => path.endsWith('secret'))).toBe(false);
  });

  it('reuses a hand-over across parallel launches until Git changes or the uid changes', async () => {
    const root = tree();
    const gitDir = join(root, 'metadata');
    mkdirSync(gitDir);
    writeFileSync(join(root, '.git'), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, 'index'), 'old');
    const owner = new SandboxOwnership((path, uid) => handToSandbox(path, uid, async () => undefined));
    const mounts = [{ hostPath: root, containerPath: '/work', volume: 'worktrees', volumeSubpath: 'run/repo' }];
    const [first, second] = await Promise.all([owner.prepare(mounts, own + 1), owner.prepare(mounts, own + 1)]);
    expect(first).toContain(join(root, 'sub', 'file.txt'));
    expect(second).toEqual([]);
    await expect(owner.prepare(mounts, own + 1)).resolves.toEqual([]);

    // Atomic replacement is how Git updates the index, including a reset to the same HEAD.
    writeFileSync(join(gitDir, 'new-index'), 'new');
    renameSync(join(gitDir, 'new-index'), join(gitDir, 'index'));
    await expect(owner.prepare(mounts, own + 1)).resolves.toContain(join(root, 'sub', 'file.txt'));
    await expect(owner.prepare(mounts, own + 2)).resolves.toContain(join(root, 'sub', 'file.txt'));
  });
});
