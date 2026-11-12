import { FakeClock } from '../core/fake-clock.spec-helpers';
import { HostUnavailable, type HttpCallDraft } from '../core/swarmloop-error';
import { HOST_RETRY_MS, request } from './http';

type Answer = number | Error | { status: number; retryAfter: string };

/** A fetch that answers from a script, one answer per try; the last one repeats. */
function scriptedFetch(answers: Answer[]): jest.Mock {
  let index = 0;
  global.fetch = jest.fn(async (url: string) => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    const { status, retryAfter } = typeof answer === 'number' ? { status: answer, retryAfter: null } : answer;
    return {
      status,
      ok: status < 300,
      url,
      headers: { get: (name: string) => (name === 'retry-after' ? retryAfter : null) },
      arrayBuffer: async () => Buffer.from('{}'),
    };
  }) as unknown as jest.Mock;
  return global.fetch as unknown as jest.Mock;
}

const URL_ = 'https://api.example.com/x?token=secret';

describe('request retry policy', () => {
  const original = global.fetch;
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const timing = {
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
    },
    random: () => 1,
  };
  const call = (calls: HttpCallDraft[] = []) => request(clock, URL_, {}, calls, {}, timing);
  beforeEach(() => {
    sleeps.length = 0;
  });
  afterEach(() => {
    global.fetch = original;
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('retries %i and returns the answer that follows', async (status) => {
    const fetched = scriptedFetch([status, 200]);
    const response = await call();
    expect(response.status).toBe(200);
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 422])('returns %i after one try', async (status) => {
    const fetched = scriptedFetch([status, 200]);
    const response = await call();
    expect(response.status).toBe(status);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('retries a network error and a timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetched = scriptedFetch([new TypeError('fetch failed'), timeout, 200]);
    expect((await call()).status).toBe(200);
    expect(fetched).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After in seconds and as a date', async () => {
    scriptedFetch([
      { status: 429, retryAfter: '7' },
      { status: 503, retryAfter: new Date(clock.now() + 3000).toUTCString() },
      200,
    ]);
    await call();
    expect(sleeps).toEqual([7000, 3000]);
  });

  it('gives up after 5 tries with HostUnavailable and a next try 5 minutes after the last', async () => {
    const fetched = scriptedFetch([503]);
    const calls: HttpCallDraft[] = [];
    const error = await call(calls).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostUnavailable);
    expect(error).toMatchObject({
      host: 'api.example.com',
      detail: 'HTTP 503',
      retryAt: new Date(clock.now() + HOST_RETRY_MS).toISOString(),
    });
    expect(fetched).toHaveBeenCalledTimes(5);
    expect(sleeps).toHaveLength(4);
  });

  it('reports a network error that never clears by its message', async () => {
    scriptedFetch([new TypeError('fetch failed')]);
    await expect(call()).rejects.toMatchObject({ detail: 'fetch failed' });
  });

  it('records one call without the secret, whatever the number of tries', async () => {
    scriptedFetch([502, 502, 200]);
    const calls: HttpCallDraft[] = [];
    await call(calls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ statusCode: 200, url: 'https://api.example.com/x' });
  });
});
