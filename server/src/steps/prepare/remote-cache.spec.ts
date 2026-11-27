import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { CACHE_MS, RemoteCache } from './remote-cache';

const snapshot = (at: number) => ({ at, repositories: [], owners: [] });

describe('RemoteCache', () => {
  it('serves a snapshot as fresh until CACHE_MS has passed, and keeps it as stale', () => {
    const clock = new FakeClock();
    const cache = new RemoteCache(clock);
    cache.store('ann', 'github', snapshot(clock.now()));
    clock.advance(CACHE_MS - 1);
    expect(cache.fresh('ann', 'github')).toBeDefined();
    clock.advance(1);
    expect(cache.fresh('ann', 'github')).toBeUndefined();
    expect(cache.snapshot('ann', 'github')).toBeDefined();
  });

  it('keeps one slot per person and host', () => {
    const clock = new FakeClock();
    const cache = new RemoteCache(clock);
    cache.store('ann', 'github', snapshot(clock.now()));
    expect(cache.fresh('bob', 'github')).toBeUndefined();
    expect(cache.fresh('ann', 'gitlab')).toBeUndefined();
    expect(cache.fresh(null, 'github')).toBeUndefined();
  });

  it('holds one pending mark per slot', () => {
    const cache = new RemoteCache(new FakeClock());
    cache.markPending('ann', 'github');
    expect(cache.isPending('ann', 'github')).toBe(true);
    expect(cache.isPending('ann', 'gitlab')).toBe(false);
    expect(cache.isPending('bob', 'github')).toBe(false);
    cache.clearPending('ann', 'github');
    expect(cache.isPending('ann', 'github')).toBe(false);
  });

  it('keeps a failure until it is dropped or a snapshot is stored', () => {
    const clock = new FakeClock();
    const cache = new RemoteCache(clock);
    cache.fail('ann', 'github', 'down');
    cache.fail('ann', 'gitlab', 'down');
    cache.fail('bob', 'github', 'down');
    cache.store('ann', 'github', snapshot(clock.now()));
    expect(cache.failure('ann', 'github')).toBeUndefined();
    cache.dropFailures('ann');
    expect(cache.failure('ann', 'gitlab')).toBeUndefined();
    expect(cache.failure('bob', 'github')).toBe('down');
  });

  it('adds a repository to the kept snapshot', () => {
    const clock = new FakeClock();
    const cache = new RemoteCache(clock);
    cache.store(null, 'github', snapshot(clock.now()));
    const repository = {
      host: 'github',
      owner: 'acme',
      name: 'x',
      visibility: 'private',
      defaultBranch: 'main',
    } as const;
    cache.add(null, 'github', repository);
    expect(cache.snapshot(null, 'github')?.repositories).toEqual([repository]);
  });
});
