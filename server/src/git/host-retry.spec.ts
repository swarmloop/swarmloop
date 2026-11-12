import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { isTransientGitError, withGitHostRetries } from './host-retry';

const clock = { now: () => Date.parse('2026-11-12T10:00:00.000Z'), iso: () => '2026-11-12T10:00:00.000Z' };
const timing = { sleep: () => Promise.resolve(), random: () => 0 };

describe('isTransientGitError', () => {
  it.each([
    'fatal: unable to access: Could not resolve host: github.com',
    'fatal: unable to access: Connection timed out after 300000 milliseconds',
    'error: Connection reset by peer',
    'fatal: unable to access: The requested URL returned error: 502',
    'error: RPC failed; HTTP 500 curl 22',
    'fatal: early EOF',
    'fatal: the remote end hung up unexpectedly',
  ])('retries %s', (stderr) => {
    expect(isTransientGitError(stderr)).toBe(true);
  });

  it.each([
    'fatal: Authentication failed for https://github.com/x/y.git',
    'fatal: unable to access: The requested URL returned error: 403',
    '! [remote rejected] main -> main (pre-receive hook declined)',
  ])('does not retry %s', (stderr) => {
    expect(isTransientGitError(stderr)).toBe(false);
  });
});

describe('withGitHostRetries', () => {
  it('runs again after a transient failure and returns the later answer', async () => {
    let calls = 0;
    const result = await withGitHostRetries(
      'https://github.com/x/y.git',
      clock,
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new SwarmloopError('demo push failed: RPC failed')) : Promise.resolve('ok');
      },
      undefined,
      timing,
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('passes an auth error through at the first try', async () => {
    let calls = 0;
    const failing = withGitHostRetries(
      'https://github.com/x/y.git',
      clock,
      () => {
        calls += 1;
        return Promise.reject(new SwarmloopError('demo push failed: Authentication failed'));
      },
      undefined,
      timing,
    );
    await expect(failing).rejects.toThrow('Authentication failed');
    expect(calls).toBe(1);
  });

  it('waits after 5 tries with the host name and the next try, and no credentials', async () => {
    let calls = 0;
    const failing = withGitHostRetries(
      'https://x-token:s3cret@github.com/x/y.git',
      clock,
      () => {
        calls += 1;
        return Promise.reject(new SwarmloopError('fetch failed: Could not resolve host s3cret'));
      },
      's3cret',
      timing,
    );
    const error = await failing.catch((caught: unknown) => caught);
    expect(calls).toBe(5);
    expect(error).toBeInstanceOf(HostUnavailable);
    expect((error as HostUnavailable).message).toBe(
      'github.com did not answer: fetch failed: Could not resolve host ***; next try at 2026-11-12T10:05:00.000Z',
    );
  });
});
