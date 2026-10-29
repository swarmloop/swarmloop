import { ConfigService } from '@nestjs/config';
import { GithubHostService } from './github-host.service';
import { FetchFailed } from '../../swarmloop-error';

const TOKEN = 'super-secret-token';

describe('github host', () => {
  const original = global.fetch;

  afterEach(() => {
    global.fetch = original;
  });

  it('returns an open pull request and does not create another', async () => {
    const seen = mockFetch([opened()]);
    const result = await service().findMergeRequest({ project: 'acme/demo', source: 'feature/PROJ-1-ship' });
    expect(result.record).toEqual({
      project: 'acme/demo',
      iid: 12,
      url: 'https://github.com/acme/demo/pull/12',
      summary: 'Already open.',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/demo/pulls?state=open&head=acme%3Afeature%2FPROJ-1-ship&per_page=20');
    expect(seen[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
    expect(result.httpCalls[0]?.provider).toBe('github');
  });

  it('uses the enterprise api root', async () => {
    const seen = mockFetch([[]]);
    await service({ GITHUB_BASE_URL: 'https://github.example' }).findMergeRequest({ project: 'acme/demo', source: 'feature/PROJ-1-ship' });
    expect(seen[0]?.url).toContain('https://github.example/api/v3/repos/acme/demo/pulls');
  });

  it('creates a pull request when none is open', async () => {
    const seen = mockFetch([
      {
        number: 12,
        html_url: 'https://github.com/acme/demo/pull/12',
        body: 'Ships the field.',
      },
    ]);
    const result = await service().openMergeRequest({
      project: 'acme/demo',
      source: 'feature/PROJ-1-ship',
      target: 'main',
      title: 'Ship the field',
      summary: 'Ships the field.',
    });
    expect(result.record.iid).toBe(12);
    expect(seen[0]?.method).toBe('POST');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      title: 'Ship the field',
      head: 'feature/PROJ-1-ship',
      base: 'main',
      body: 'Ships the field.',
    });
  });

  it('updates the open pull request when create conflicts', async () => {
    const seen = mockFetch([null, opened(), { number: 12 }], [422, 200, 200]);
    const result = await service().openMergeRequest({
      project: 'acme/demo',
      source: 'feature/PROJ-1-ship',
      target: 'main',
      title: 'Ship the field',
      summary: 'Updated.',
    });
    expect(result.record.summary).toBe('Updated.');
    expect(seen.map((call) => call.method)).toEqual(['POST', 'GET', 'PATCH']);
  });

  it('reads a failed actions run and the job log', async () => {
    const seen = mockFetch([
      {
        workflow_runs: [
          { id: 9, head_sha: 'abc', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/demo/actions/runs/9' },
        ],
      },
      { jobs: [{ id: 4, name: 'test', conclusion: 'failure' }, { id: 5, name: 'lint', conclusion: 'success' }] },
      'assertion failed',
    ]);
    const host = service();
    const pipeline = await host.readBranchPipeline({ project: 'acme/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' });
    expect(pipeline.snapshot).toEqual({
      id: 9,
      status: 'failed',
      url: 'https://github.com/acme/demo/actions/runs/9',
      jobs: [{ id: 4, name: 'test', stage: '', status: 'failed', allowFailure: false }],
    });
    const trace = await host.readJobTrace('acme/demo', 4);
    expect(trace.trace).toBe('assertion failed');
    expect(seen[2]?.url).toBe('https://api.github.com/repos/acme/demo/actions/jobs/4/logs');
  });

  it('names a rejected token', async () => {
    mockFetch([null], 401);
    await expect(service().findMergeRequest({ project: 'acme/demo', source: 'feature/PROJ-1-ship' })).rejects.toThrow('GITHUB_TOKEN was rejected');
  });

  it('names a missing token', async () => {
    await expect(service({ GITHUB_TOKEN: '' }).findMergeRequest({ project: 'acme/demo', source: 'feature/PROJ-1-ship' })).rejects.toThrow(
      'GITHUB_TOKEN is missing',
    );
  });
});

function service(overrides: Record<string, string> = {}): GithubHostService {
  const values: Record<string, string> = {
    RUNTIME: 'cursor',
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: 'https://github.com',
    GITHUB_TOKEN: TOKEN,
    ...overrides,
  };
  const config = {
    getOrThrow: (key: string) => (key in values ? values[key] : 0),
    get: (key: string) => values[key],
  } as ConfigService;
  return new GithubHostService(config);
}

function opened(): unknown {
  return [
    {
      number: 12,
      html_url: 'https://github.com/acme/demo/pull/12',
      body: 'Already open.',
      head: { ref: 'feature/PROJ-1-ship' },
    },
  ];
}

interface Seen {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

function mockFetch(bodies: unknown[], status: number | number[] = 200): Seen[] {
  const seen: Seen[] = [];
  global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET';
    seen.push({ method, url: String(url), body: init?.body ?? '', headers: init?.headers ?? {} });
    const payload = bodies[seen.length - 1] ?? bodies[0];
    const code = Array.isArray(status) ? (status[seen.length - 1] ?? 200) : status;
    return {
      status: code,
      ok: code >= 200 && code < 300,
      url: String(url),
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      arrayBuffer: async () => Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)),
    };
  }) as unknown as typeof fetch;
  return seen;
}
