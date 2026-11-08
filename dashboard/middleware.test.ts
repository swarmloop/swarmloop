import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { middleware } from './middleware';

afterEach(() => {
  vi.unstubAllEnvs();
});

function rewriteTarget(url: string): string | null {
  return middleware(new NextRequest(url)).headers.get('x-middleware-rewrite');
}

describe('middleware', () => {
  it('rewrites an API call to the URL set after the import', () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');

    expect(rewriteTarget('http://localhost:3921/swarmloop-api/runs?x=1')).toBe('http://server:3920/runs?x=1');
  });

  it('follows a changed URL, so nothing is baked in', () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://other.example:9000');

    expect(rewriteTarget('http://localhost:3921/swarmloop-api/runs/a/b')).toBe('http://other.example:9000/runs/a/b');
  });

  it.each(['//evil.example/x', '/\\evil.example/x'])('refuses %s instead of proxying to another host', (path) => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://server:3920');

    const response = middleware(new NextRequest(`http://localhost:3921/swarmloop-api${path}`));

    expect(response.status).toBe(400);
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });
});
