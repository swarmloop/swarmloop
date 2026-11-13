import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { middleware } from './middleware';

const PROXY_WAIT_MS = 10_000;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function rewriteTarget(url: string): Promise<string | null> {
  return (await middleware(new NextRequest(url))).headers.get('x-middleware-rewrite');
}

function forwardedUrl(): string {
  return String(fetchMock.mock.calls[0][0]);
}

describe('middleware', () => {
  it('rewrites an API call to the URL set after the import', async () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');

    await middleware(new NextRequest('http://localhost:3921/swarmloop-api/runs?x=1'));

    expect(forwardedUrl()).toBe('http://server:3920/runs?x=1');
  });

  it('follows a changed URL, so nothing is baked in', async () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://other.example:9000');

    await middleware(new NextRequest('http://localhost:3921/swarmloop-api/runs/a/b'));

    expect(forwardedUrl()).toBe('http://other.example:9000/runs/a/b');
  });

  it('sends an API call with its method, headers and body and returns the status and headers of the answer', async () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');
    fetchMock.mockResolvedValue(new Response('created', { status: 201, headers: { 'x-answer': 'yes' } }));

    const response = await middleware(
      new NextRequest('http://localhost:3921/swarmloop-api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-swarmloop': '1' },
        body: '{"a":1}',
      }),
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit & { duplex: string };
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-swarmloop')).toBe('1');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(await new Response(init.body as ReadableStream, { headers: {} }).text()).toBe('{"a":1}');
    expect(init.duplex).toBe('half');
    expect(init.redirect).toBe('manual');
    expect(response.status).toBe(201);
    expect(response.headers.get('x-answer')).toBe('yes');
    expect(await response.text()).toBe('created');
  });

  it('answers 503 the server is busy when the API does not answer within the wait', async () => {
    vi.useFakeTimers();
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');
    fetchMock.mockImplementation(
      (_url: URL, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    const pending = middleware(new NextRequest('http://localhost:3921/swarmloop-api/runs'));
    await vi.advanceTimersByTimeAsync(PROXY_WAIT_MS);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'the server is busy' });
  });

  it('answers 503 the server is busy when the API refuses the connection', async () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const response = await middleware(new NextRequest('http://localhost:3921/swarmloop-api/runs'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: 'the server is busy' });
  });

  it('proxies the OAuth routes to the API, query included', async () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');

    expect(await rewriteTarget('http://localhost:3921/auth/github/callback?code=c&state=s')).toBe(
      'http://server:3920/auth/github/callback?code=c&state=s',
    );
  });

  it.each(['/auth//evil.example/x', '/auth/\\evil', '/auth/x//y'])(
    'refuses %s instead of proxying it',
    async (path) => {
      vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');

      const response = await middleware(new NextRequest(`http://localhost:3921${path}`));

      expect(response.status).toBe(400);
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    },
  );

  it.each(['//evil.example/x', '/\\evil.example/x'])('refuses %s instead of proxying to another host', async (path) => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');

    const response = await middleware(new NextRequest(`http://localhost:3921/swarmloop-api${path}`));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['http://evil.example:3921/', 'http://evil.example:3921/swarmloop-api/runs'])(
    'answers a foreign Host with 421 for %s',
    async (url) => {
      const response = await middleware(new NextRequest(url));

      expect(response.status).toBe(421);
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    },
  );

  it.each(['127.0.0.1:3921', 'localhost:3921', 'dashboard:3921', 'panel.example:8080'])(
    'answers the own host %s',
    async (host) => {
      vi.stubEnv('SWARMLOOP_PUBLIC_URL', 'http://panel.example:8080');

      const response = await middleware(new NextRequest('http://127.0.0.1:3921/', { headers: { host } }));

      expect(response.status).toBe(200);
    },
  );
});
