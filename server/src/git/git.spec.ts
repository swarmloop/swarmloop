import { mkdirSync, realpathSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { withSafeDirectory } from './git';

describe('withSafeDirectory', () => {
  let root: string;
  let checkouts: string;
  let worktrees: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-git-'));
    checkouts = join(root, 'checkouts');
    worktrees = join(root, 'worktrees');
    mkdirSync(join(checkouts, 'billing-api'), { recursive: true });
    mkdirSync(join(worktrees, 'PROJ-1', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'checkouts-evil', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
  });

  it('trusts the checkout this command opens', () => {
    const directory = join(checkouts, 'billing-api');
    expect(withSafeDirectory(['-C', directory, 'rev-parse'], [checkouts, worktrees])).toEqual([
      '-c',
      `safe.directory=${realpathSync(directory)}`,
      '-C',
      directory,
      'rev-parse',
    ]);
  });

  it('trusts a worktree under the worktree mount', () => {
    const directory = join(worktrees, 'PROJ-1', 'billing-api');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts, worktrees])[1]).toBe(`safe.directory=${realpathSync(directory)}`);
  });

  it('leaves a command alone when it has no checkout', () => {
    expect(withSafeDirectory(['status'], [checkouts])).toEqual(['status']);
  });

  it('does not trust a directory outside the mounts', () => {
    const directory = join(root, 'outside');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts, worktrees])).toEqual(['-C', directory, 'status']);
  });

  it('does not trust a path that escapes the mount', () => {
    const directory = join(checkouts, '..', 'outside');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts])).toEqual(['-C', directory, 'status']);
  });

  it('does not trust a directory whose name only starts with the mount', () => {
    const directory = join(root, 'checkouts-evil', 'billing-api');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts])).toEqual(['-C', directory, 'status']);
  });

  it('does not trust a missing directory', () => {
    const directory = join(checkouts, 'missing');
    expect(withSafeDirectory(['-C', directory, 'status'], [checkouts])).toEqual(['-C', directory, 'status']);
  });
});
