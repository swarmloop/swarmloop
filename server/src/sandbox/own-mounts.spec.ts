import { mkdirSync, mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OwnMounts } from './own-mounts';

describe('OwnMounts', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-own-')));
  const worktrees = join(root, 'worktrees');
  const data = join(root, 'data');
  mkdirSync(join(worktrees, 'r1', 'demo'), { recursive: true });
  mkdirSync(join(worktrees, 'bound'), { recursive: true });
  mkdirSync(data, { recursive: true });

  function mounts(extra: object[] = []): OwnMounts {
    const listed = [
      { Type: 'volume', Name: 'swarmloop-worktrees', Destination: worktrees },
      { Type: 'bind', Source: '/Users/dev/data', Destination: data },
      ...extra,
    ];
    return new OwnMounts(() => async () => JSON.stringify(listed));
  }

  it('gives a path under a volume that volume with the rest as its subpath', async () => {
    const demo = join(worktrees, 'r1', 'demo');
    const [mount] = await mounts().withDaemonPaths([{ hostPath: demo, containerPath: '/work/demo', readonly: true }]);
    expect(mount).toEqual({
      hostPath: demo,
      containerPath: '/work/demo',
      readonly: true,
      volume: 'swarmloop-worktrees',
      volumeSubpath: 'r1/demo',
    });
  });

  it('gives the destination of a volume itself an empty subpath', async () => {
    const [mount] = await mounts().withDaemonPaths([{ hostPath: worktrees, containerPath: '/work' }]);
    expect(mount?.volume).toBe('swarmloop-worktrees');
    expect(mount?.volumeSubpath).toBe('');
  });

  it('resolves a path under a bind as before', async () => {
    const [mount] = await mounts().withDaemonPaths([{ hostPath: data, containerPath: '/work/x' }]);
    expect(mount?.daemonPath).toBe('/Users/dev/data');
    expect(mount?.volume).toBeUndefined();
  });

  it('lets a longer bind destination win over a shorter volume one', async () => {
    const bound = join(worktrees, 'bound');
    const own = mounts([{ Type: 'bind', Source: '/Users/dev/bound', Destination: bound }]);
    const [mount] = await own.withDaemonPaths([{ hostPath: bound, containerPath: '/work/b' }]);
    expect(mount?.daemonPath).toBe('/Users/dev/bound');
    expect(mount?.volume).toBeUndefined();
  });

  it('keeps a path under neither as it is and leaves a resolved mount alone', async () => {
    const outside = join(root, 'other');
    const given = [
      { hostPath: outside, containerPath: '/work/o' },
      { hostPath: worktrees, containerPath: '/work', volume: 'swarmloop-cli-x' },
    ];
    const [other, resolved] = await mounts().withDaemonPaths(given);
    expect(other?.daemonPath).toBe(outside);
    expect(resolved).toBe(given[1]);
  });

  it('answers where the daemon finds a folder, as a volume or as a path', async () => {
    const own = mounts();
    await expect(own.daemonPlace(join(worktrees, 'r1'))).resolves.toEqual({
      volume: 'swarmloop-worktrees',
      subpath: 'r1',
    });
    await expect(own.daemonPlace(data)).resolves.toEqual({ path: '/Users/dev/data' });
  });

  it('resolves a state path through the binds only', async () => {
    await expect(mounts().resolveBind(join(worktrees, 'r1'))).resolves.toBe(join(worktrees, 'r1'));
  });
});
