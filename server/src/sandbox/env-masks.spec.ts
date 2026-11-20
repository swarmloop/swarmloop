import { join } from 'path';
import { makeRepo, writeFiles } from '../git/git-repo.spec-helpers';
import { spyOnExecFileSync } from '../testing/git-fixture';
import { collectEnvMasks } from './env-masks';

describe('collectEnvMasks over a checkout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('masks untracked env files outside ignored directories, without a sync process, while the timers run', async () => {
    const repo = makeRepo({ '.gitignore': 'node_modules/\n', '.env': 'x\n' });
    writeFiles(repo, { 'node_modules/pkg/.env': 's\n', '.env.local': 's\n', 'app/.env': 's\n' });
    const spy = spyOnExecFileSync();
    try {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
      let settled = false;
      let settledAtTimer: boolean | undefined;
      // A fake timer: it fires on the advance below, and only if the main thread is free to run it.
      globalThis.setTimeout(() => {
        settledAtTimer = settled;
      }, 10);
      const pending = collectEnvMasks([{ hostPath: repo, containerPath: '/work/demo' }]).finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(10);
      expect(settledAtTimer).toBe(false);
      const masks = await pending;
      expect(spy).not.toHaveBeenCalled();
      const sorted = [...masks].sort((a, b) => a.containerFile.localeCompare(b.containerFile));
      expect(sorted.map((mask) => mask.containerFile)).toEqual(['/work/demo/.env.local', '/work/demo/app/.env']);
      for (const mask of sorted) {
        expect(mask.hostFile).toBe(join(repo, mask.containerFile.replace('/work/demo/', '')));
      }
    } finally {
      spy.mockRestore();
    }
  });
});
