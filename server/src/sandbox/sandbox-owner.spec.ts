import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { handToSandbox } from './sandbox-owner';

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
});
