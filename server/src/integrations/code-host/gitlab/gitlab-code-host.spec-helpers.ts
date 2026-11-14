import { testEnv } from '../../../config/env.spec-helpers';
import { FakeClock } from '../../../core/fake-clock.spec-helpers';
import type { CodeHostEnv } from '../abstract-code-host';
import { GitlabCodeHost } from './gitlab-code-host';

export const TOKEN = 'super-secret-token';

export function service(overrides: Partial<CodeHostEnv> = {}): GitlabCodeHost {
  const env = testEnv({ GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: TOKEN, ...overrides });
  return new GitlabCodeHost(env, new FakeClock());
}

export function opened(source = 'feature/PROJ-1-ship'): unknown {
  return [
    {
      iid: 12,
      web_url: 'https://gitlab.example/group/demo/-/merge_requests/12',
      description: 'Already open.',
      source_branch: source,
    },
  ];
}

export interface Seen {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export function mockFetch(
  bodies: unknown[],
  status: number | number[] = 200,
  nextPage: (string | null)[] = [],
): Seen[] {
  const seen: Seen[] = [];
  global.fetch = jest.fn(
    async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const method = init?.method ?? 'GET';
      seen.push({ method, url: String(url), body: init?.body ?? '', headers: init?.headers ?? {} });
      const payload = bodies[seen.length - 1] ?? bodies[0];
      const code = Array.isArray(status) ? (status[seen.length - 1] ?? 200) : status;
      const page = nextPage[seen.length - 1] ?? null;
      return {
        status: code,
        ok: code >= 200 && code < 300,
        url: String(url),
        headers: {
          get: (name: string) => {
            const key = name.toLowerCase();
            if (key === 'content-type') {
              return 'application/json';
            }
            if (key === 'x-next-page') {
              return page;
            }
            return null;
          },
        },
        arrayBuffer: async () => Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)),
      };
    },
  ) as unknown as typeof fetch;
  return seen;
}
