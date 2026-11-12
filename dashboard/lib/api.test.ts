import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, runLog } from './api';

function respond(status: number, body: unknown): void {
  const response = { ok: status < 400, status, json: () => Promise.resolve(body) };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('throws an ApiError with the status and the message of a 404', async () => {
    respond(404, { message: 'run not found' });

    const failure = await api('/runs/missing').catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ status: 404, message: 'run not found' });
  });

  it('joins an array message', async () => {
    respond(400, { message: ['a', 'b'] });

    await expect(api('/runs')).rejects.toMatchObject({ status: 400, message: 'a, b' });
  });

  it('falls back to the HTTP status when there is no message', async () => {
    respond(500, {});

    await expect(api('/runs')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('sends the session cookie, and X-Swarmloop on a write only', async () => {
    respond(200, {});

    await api('/runs');
    await api('/runs', { method: 'POST' });

    const [read, write] = vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => init);
    expect(read).toMatchObject({ credentials: 'include' });
    expect((read?.headers as Record<string, string>)['X-Swarmloop']).toBeUndefined();
    expect(write).toMatchObject({ credentials: 'include', headers: { 'X-Swarmloop': '1' } });
  });

  it('sends the browser to the login page on a 401, but not when it is there already', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, pathname: '/runs/a', search: '' });
    respond(401, { message: 'log in first' });

    await expect(api('/runs')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fruns%2Fa');

    assign.mockClear();
    vi.stubGlobal('location', { assign, pathname: '/login', search: '' });
    await expect(api('/auth/providers')).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it('passes the page and its query as next on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, pathname: '/runs/x', search: '?tab=log' });
    respond(401, { message: 'log in first' });

    await expect(api('/runs/x')).rejects.toMatchObject({ status: 401 });

    expect(assign).toHaveBeenCalledWith('/login?next=%2Fruns%2Fx%3Ftab%3Dlog');
  });

  it('returns the body of a successful response', async () => {
    respond(200, { runs: [] });

    await expect(api('/runs')).resolves.toEqual({ runs: [] });
  });
});

function answer(status: number, body = ''): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('runLog', () => {
  it('reads the log through the API', async () => {
    const fetchMock = answer(200, 'raw log');
    await expect(runLog('proj-1', 'implement')).resolves.toBe('raw log');
    expect(fetchMock.mock.calls[0][0]).toBe('/swarmloop-api/runs/proj-1/steps/implement/log');
  });

  it('adds the attempt and encodes every part', async () => {
    const fetchMock = answer(200, '');
    await runLog('../x', 'a/b', 'id&1');
    expect(fetchMock.mock.calls[0][0]).toBe('/swarmloop-api/runs/..%2Fx/steps/a%2Fb/log?attempt=id%261');
  });

  it('sends the session cookie and goes to the login page on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, pathname: '/runs/a', search: '' });
    const fetchMock = answer(401);

    await expect(runLog('proj-1', 'plan')).resolves.toBeNull();

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fruns%2Fa');
  });

  it('adds tail and from to the query', async () => {
    const fetchMock = answer(200, '');
    await runLog('proj-1', 'implement', 'att-1', { from: 11, tail: 2000 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/swarmloop-api/runs/proj-1/steps/implement/log?attempt=att-1&tail=2000&from=11',
    );
  });

  it('sends a tail of 0', async () => {
    const fetchMock = answer(200, '');
    await runLog('proj-1', 'implement', undefined, { tail: 0 });
    expect(fetchMock.mock.calls[0][0]).toBe('/swarmloop-api/runs/proj-1/steps/implement/log?tail=0');
  });

  it('answers null when the API refuses', async () => {
    answer(404);
    await expect(runLog('proj-1', 'plan')).resolves.toBeNull();
  });
});
