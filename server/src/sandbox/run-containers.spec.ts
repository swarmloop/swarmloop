import { attemptAwaited } from './run-containers';

/** A docker that answers `ps -q` by its filters: the running ids of the attempt, and those that carry the lost label. */
function docker(running: string[], lost: string[]) {
  return (args: string[]): Promise<string> => {
    if (!args.includes('label=swarmloop.attempt=a1')) return Promise.resolve('');
    const ids = args.includes('label=swarmloop.result=lost') ? lost : running;
    return Promise.resolve(ids.map((id) => `${id}\n`).join(''));
  };
}

describe('attemptAwaited', () => {
  it('is true when a running container of the attempt has no lost label', async () => {
    expect(await attemptAwaited(docker(['c1', 'c2'], ['c1']), 'a1')).toBe(true);
  });

  it('is false when every running container of the attempt is lost, or none runs', async () => {
    expect(await attemptAwaited(docker(['c1', 'c2'], ['c1', 'c2']), 'a1')).toBe(false);
    expect(await attemptAwaited(docker([], []), 'a1')).toBe(false);
  });

  it('is null when docker throws', async () => {
    expect(await attemptAwaited(() => Promise.reject(new Error('no docker')), 'a1')).toBeNull();
  });
});
