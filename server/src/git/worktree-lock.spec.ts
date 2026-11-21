import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withWorktree, withWorktrees } from './worktree-lock';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets every promise that can progress without outside input run. It waits on promises only. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

describe('withWorktree', () => {
  it('runs two operations on one path one after the other, in arrival order', async () => {
    const log: string[] = [];
    const firstGate = deferred();
    const first = withWorktree('/lock/a', async () => {
      log.push('first start');
      await firstGate.promise;
      log.push('first end');
    });
    const second = withWorktree('/lock/a', async () => {
      log.push('second start');
    });
    const third = withWorktree('/lock/a', async () => {
      log.push('third start');
    });
    await settle();
    expect(log).toEqual(['first start']);
    firstGate.resolve();
    await Promise.all([first, second, third]);
    expect(log).toEqual(['first start', 'first end', 'second start', 'third start']);
  });

  it('runs two paths at once', async () => {
    const log: string[] = [];
    const gate = deferred();
    const first = withWorktree('/lock/b', async () => {
      log.push('b start');
      await gate.promise;
    });
    const second = withWorktree('/lock/c', async () => {
      log.push('c start');
      await gate.promise;
    });
    await settle();
    expect(log).toEqual(['b start', 'c start']);
    gate.resolve();
    await Promise.all([first, second]);
  });

  it('does not make a nested call on a held path wait', async () => {
    const result = await withWorktree('/lock/d', async () => withWorktree('/lock/d', async () => 'inner'));
    expect(result).toBe('inner');
  });

  it('releases the lock when the operation throws', async () => {
    const failed = withWorktree('/lock/e', () => Promise.reject(new Error('boom')));
    const next = withWorktree('/lock/e', async () => 'next');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('next');
  });

  it('makes detached work started in a held section wait once the holder has released', async () => {
    const log: string[] = [];
    const releaseHolder = deferred();
    const startDetached = deferred();
    let detached: Promise<void> = Promise.resolve();
    const holder = withWorktree('/lock/f', async () => {
      detached = (async () => {
        await startDetached.promise;
        await withWorktree('/lock/f', async () => {
          log.push('detached');
        });
      })();
      await releaseHolder.promise;
    });
    const other = withWorktree('/lock/f', async () => {
      log.push('other start');
      await settle();
      log.push('other end');
    });
    releaseHolder.resolve();
    await holder;
    startDetached.resolve();
    await Promise.all([other, detached]);
    expect(log).toEqual(['other start', 'other end', 'detached']);
  });

  it('shares one lock between a symlink and its directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-lock-'));
    try {
      const real = join(dir, 'real');
      const link = join(dir, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      const log: string[] = [];
      const gate = deferred();
      const first = withWorktree(real, async () => {
        log.push('real');
        await gate.promise;
      });
      const second = withWorktree(link, async () => {
        log.push('link');
      });
      await settle();
      expect(log).toEqual(['real']);
      gate.resolve();
      await Promise.all([first, second]);
      expect(log).toEqual(['real', 'link']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('withWorktrees', () => {
  it('takes the paths in sorted order: the later path stays free while the earlier one is awaited', async () => {
    const log: string[] = [];
    const gate = deferred();
    const holder = withWorktree('/lock/m', async () => {
      await gate.promise;
    });
    const both = withWorktrees(['/lock/n', '/lock/m', '/lock/n'], async () => {
      log.push('both');
      await withWorktree('/lock/n', async () => {
        log.push('nested n');
      });
    });
    const onlyN = withWorktree('/lock/n', async () => {
      log.push('only n');
    });
    await settle();
    expect(log).toEqual(['only n']);
    gate.resolve();
    await Promise.all([holder, both, onlyN]);
    expect(log).toEqual(['only n', 'both', 'nested n']);
  });
});
