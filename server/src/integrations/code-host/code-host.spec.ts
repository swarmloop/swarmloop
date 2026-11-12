import { instantBackoff } from '../instant-backoff.spec-helpers';
import { testEnv } from '../../config/env.spec-helpers';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { FetchFailed, HostUnavailable } from '../../core/swarmloop-error';
import { GithubCodeHost } from './github/github-code-host';

interface Answer {
  status: number;
  body?: unknown;
  /** The host that finally answers, after a redirect. */
  url?: string;
  /** The answer as plain text, instead of JSON. */
  text?: string;
}
type Handler = (method: string, url: string, body: string) => Answer;

function fakeFetch(handler: Handler): { method: string; url: string }[] {
  const seen: { method: string; url: string }[] = [];
  global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url: String(url) });
    const { status, body, url: answeredBy, text } = handler(method, String(url), init?.body ?? '');
    return {
      status,
      ok: status < 300,
      url: answeredBy ?? String(url),
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from(text ?? JSON.stringify(body ?? {})),
    };
  }) as unknown as typeof fetch;
  return seen;
}

const github = (): GithubCodeHost =>
  new GithubCodeHost(testEnv({ GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: 'tok' }), new FakeClock());
const draft = {
  project: 'acme/demo',
  source: 'feature/x',
  target: 'main',
  title: 'T',
  summary: 'S',
  draft: false,
};
const pull = { number: 7, html_url: 'https://github.com/acme/demo/pull/7', head: { ref: 'feature/x' }, draft: false };

describe('code host retries', () => {
  const original = global.fetch;
  beforeEach(() => {
    instantBackoff();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = original;
  });

  it('reuses the request a retried create made, and creates no second one', async () => {
    const stored: unknown[] = [];
    let creates = 0;
    fakeFetch((method, url) => {
      if (method === 'POST') {
        creates += 1;
        if (creates === 1) {
          stored.push(pull);
          return { status: 502 };
        }
        return { status: 422, body: { message: 'Validation Failed: A pull request already exists' } };
      }
      if (method === 'GET' && url.includes('/pulls')) {
        return { status: 200, body: stored };
      }
      return { status: 200, body: pull };
    });
    const result = await github().openMergeRequest(draft);
    expect(result.record.iid).toBe(7);
    expect(stored).toHaveLength(1);
    expect(creates).toBe(2);
  });

  it("keeps today's text for a 422 that is not a duplicate", async () => {
    fakeFetch((method) =>
      method === 'POST'
        ? { status: 422, body: { message: 'Validation Failed: head is invalid' } }
        : { status: 200, body: [] },
    );
    await expect(github().openMergeRequest(draft)).rejects.toThrow(
      new FetchFailed('github pull request failed: HTTP 422'),
    );
  });

  it('lets a host that stays down surface as HostUnavailable, without a second create', async () => {
    const seen = fakeFetch(() => ({ status: 503 }));
    await expect(github().openMergeRequest({ ...draft, draft: true })).rejects.toBeInstanceOf(HostUnavailable);
    expect(seen.filter((entry) => entry.method === 'POST')).toHaveLength(5);
  });

  it('retries a refused draft create as a normal request', async () => {
    const bodies: string[] = [];
    fakeFetch((method, _url, body) => {
      if (method !== 'POST') {
        return { status: 200, body: [] };
      }
      bodies.push(body);
      return bodies.length === 1
        ? { status: 422, body: { message: 'Draft pull requests are not supported' } }
        : { status: 201, body: pull };
    });
    const result = await github().openMergeRequest({ ...draft, draft: true });
    expect(result.draftsUnavailable).toBe(true);
    expect(JSON.parse(bodies[1]).draft).toBe(false);
  });
});

describe('github job log', () => {
  const original = global.fetch;
  const LOG_HOST = 'https://logs.example.com/job/5';
  beforeEach(() => {
    instantBackoff();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = original;
  });

  it('waits for a log host that answers 403 first and returns its trace', async () => {
    let tries = 0;
    fakeFetch(() => {
      tries += 1;
      return tries === 1 ? { status: 403, url: LOG_HOST } : { status: 200, url: LOG_HOST, text: 'log text' };
    });
    const result = await github().readJobTrace('acme/demo', 5);
    expect(result.trace).toBe('log text');
    expect(tries).toBe(2);
  });

  it('says the log is unavailable when the log host answers 404 every time', async () => {
    const seen = fakeFetch(() => ({ status: 404, url: LOG_HOST }));
    await expect(github().readJobTrace('acme/demo', 5)).rejects.toThrow('github pipeline failed: HTTP 404');
    expect(seen).toHaveLength(3);
  });
});
