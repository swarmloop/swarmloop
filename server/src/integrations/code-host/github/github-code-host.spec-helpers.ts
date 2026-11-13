import { testEnv } from '../../../config/env.spec-helpers';
import { FakeClock } from '../../../core/fake-clock.spec-helpers';
import type { CodeHostEnv } from '../abstract-code-host';
import { GithubCodeHost } from './github-code-host';

export const TOKEN = 'super-secret-token';

export function service(overrides: Partial<CodeHostEnv> = {}): GithubCodeHost {
  const env = testEnv({ GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: TOKEN, ...overrides });
  return new GithubCodeHost(env, new FakeClock());
}

export function opened(): unknown {
  return [
    {
      number: 12,
      html_url: 'https://github.com/acme/demo/pull/12',
      body: 'Already open.',
      head: { ref: 'feature/PROJ-1-ship' },
    },
  ];
}

export interface Seen {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export function mockFetch(bodies: unknown[], status: number | number[] = 200): Seen[] {
  const seen: Seen[] = [];
  global.fetch = jest.fn((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url: String(url), body: init?.body ?? '', headers: init?.headers ?? {} });
    const payload = bodies[seen.length - 1] ?? bodies[0];
    const code = Array.isArray(status) ? (status[seen.length - 1] ?? 200) : status;
    return Promise.resolve({
      status: code,
      ok: code >= 200 && code < 300,
      url: String(url),
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      arrayBuffer: () =>
        Promise.resolve(Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null))),
    });
  }) as unknown as typeof fetch;
  return seen;
}
