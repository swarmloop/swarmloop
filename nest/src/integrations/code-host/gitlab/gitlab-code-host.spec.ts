import { ConfigService } from '@nestjs/config';
import { FetchFailed } from '../../../swarmloop-error';
import { GitlabCodeHost } from './gitlab-code-host';

const TOKEN = 'super-secret-token';

describe('gitlab host', () => {
  const original = global.fetch;

  afterEach(() => {
    global.fetch = original;
  });

  it('returns an open merge request and does not create another', async () => {
    const seen = mockFetch([opened()]);
    const result = await service().findMergeRequest({ project: 'group/demo', source: 'feature/PROJ-1-ship' });
    expect(result.record).toEqual({
      project: 'group/demo',
      iid: 12,
      url: 'https://gitlab.example/group/demo/-/merge_requests/12',
      summary: 'Already open.',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toContain('/api/v4/projects/group%2Fdemo/merge_requests');
    expect(seen[0]?.url).toContain('source_branch=feature%2FPROJ-1-ship');
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
    expect(result.httpCalls[0]?.provider).toBe('gitlab');
  });

  it('creates a merge request when none is open', async () => {
    const seen = mockFetch([
      {
        iid: 12,
        web_url: 'https://gitlab.example/group/demo/-/merge_requests/12',
        description: 'Ships the field.',
      },
    ]);
    const result = await service().openMergeRequest({
      project: 'group/demo',
      source: 'feature/PROJ-1-ship',
      target: 'main',
      title: 'Ship the field',
      summary: 'Ships the field.',
    });
    expect(result.record.iid).toBe(12);
    expect(seen[0]?.method).toBe('POST');
    const body = JSON.parse(seen[0]?.body ?? '{}') as { source_branch: string; target_branch: string; description: string };
    expect(body).toEqual({
      source_branch: 'feature/PROJ-1-ship',
      target_branch: 'main',
      title: 'Ship the field',
      description: 'Ships the field.',
    });
    expect(seen[0]?.headers['PRIVATE-TOKEN']).toBe(TOKEN);
    expect(seen[0]?.url).not.toContain(TOKEN);
    expect(seen[0]?.body).not.toContain(TOKEN);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('replaces the description of an open merge request', async () => {
    const seen = mockFetch([opened()]);
    const result = await service().updateMergeRequest('group/demo', 12, 'Ships the field.');
    expect(seen[0]?.method).toBe('PUT');
    expect(seen[0]?.url).toContain('/merge_requests/12');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ description: 'Ships the field.' });
    expect(result.httpCalls).toHaveLength(1);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('ignores an open merge request for another branch', async () => {
    mockFetch([opened('feature/other')]);
    const result = await service().findMergeRequest({ project: 'group/demo', source: 'feature/PROJ-1-ship' });
    expect(result.record).toBeNull();
  });

  it('reuses the merge request when create reports a conflict', async () => {
    const seen = mockFetch([{ message: 'conflict' }, opened()], [409, 200]);
    const result = await service().openMergeRequest({
      project: 'group/demo',
      source: 'feature/PROJ-1-ship',
      target: 'main',
      title: 'Ship the field',
      summary: 'Ships the field.',
    });
    expect(result.record.iid).toBe(12);
    expect(result.record.summary).toBe('Ships the field.');
    expect(seen.map((item) => item.method)).toEqual(['POST', 'GET', 'PUT']);
    expect(result.httpCalls).toHaveLength(3);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('reads the newest pipeline and keeps a yellow job off the trace', async () => {
    const seen = mockFetch([
      [{ id: 3, status: 'success' }, { id: 9, status: 'failed' }],
      { id: 9, status: 'failed', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
      [
        { id: 7, name: 'unit', stage: 'test', status: 'failed', allow_failure: false },
        { id: 8, name: 'lint', stage: 'test', status: 'failed', allow_failure: true },
      ],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(result.snapshot).toMatchObject({
      id: 9,
      status: 'failed',
      url: 'https://gitlab.example/group/demo/-/pipelines/9',
    });
    expect(result.snapshot?.jobs.map((job) => job.name)).toEqual(['unit', 'lint']);
    expect(result.snapshot?.jobs[1]?.allowFailure).toBe(true);
    expect(seen[0]?.url).toContain('ref=feature%2FPROJ-1');
    expect(seen[0]?.url).not.toContain('merge_requests');
    expect(seen[0]?.url).toContain('order_by=id');
    expect(seen[0]?.url).toContain('sort=desc');
    expect(seen[2]?.url).toContain('include_retried=false');
    expect(seen.some((item) => item.url.includes('/jobs/'))).toBe(false);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('ignores a pipeline for a different commit', async () => {
    mockFetch([
      [
        { id: 3, sha: 'old', status: 'success' },
        { id: 9, sha: 'new', status: 'failed' },
      ],
      { id: 3, status: 'success', web_url: 'https://gitlab.example/group/demo/-/pipelines/3' },
      [],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'old' });
    expect(result.snapshot?.id).toBe(3);
    expect(result.snapshot?.status).toBe('success');
  });

  it('returns no pipeline when the branch has none', async () => {
    mockFetch([[]]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(result.snapshot).toBeNull();
  });

  it('reads a job trace as plain text without storing the token', async () => {
    const seen = mockFetch(['unit failed\n']);
    const result = await service().readJobTrace('group/demo', 7);
    expect(result.trace).toBe('unit failed\n');
    expect(seen[0]?.url).toContain('/jobs/7/trace');
    expect(seen[0]?.headers.Accept).toBe('text/plain');
    expect(seen[0]?.url).not.toContain(TOKEN);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('follows the job list and drops a retried failure', async () => {
    const seen = mockFetch(
      [
        [{ id: 9, status: 'failed' }],
        { id: 9, status: 'failed', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
        [{ id: 7, name: 'unit', stage: 'test', status: 'failed', allow_failure: false }],
        [{ id: 8, name: 'unit', stage: 'test', status: 'failed', allow_failure: false, retried: true }],
      ],
      200,
      [null, null, '2', null],
    );
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(result.snapshot?.jobs.map((job) => job.id)).toEqual([7]);
    expect(seen.filter((item) => item.url.includes('/pipelines/9/jobs'))).toHaveLength(2);
  });

  it('names a missing token and does not call gitlab', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    await expect(service({ GITLAB_TOKEN: '' }).findMergeRequest({ project: 'group/demo', source: 'feature/x' })).rejects.toThrow(
      /GITLAB_TOKEN is missing/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names a rejected token and keeps the call off the secret', async () => {
    mockFetch([], 401);
    try {
      await service().findMergeRequest({ project: 'group/demo', source: 'feature/x' });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(FetchFailed);
      expect((error as Error).message).toBe('GITLAB_TOKEN was rejected');
      expect(JSON.stringify((error as FetchFailed).httpCalls)).not.toContain(TOKEN);
    }
  });
});

function service(overrides: Record<string, string> = {}): GitlabCodeHost {
  const values: Record<string, string> = {
    RUNTIME: 'cursor',
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
    GITLAB_BASE_URL: 'https://gitlab.example',
    GITLAB_TOKEN: TOKEN,
    ...overrides,
  };
  const config = {
    getOrThrow: (key: string) => (key in values ? values[key] : 0),
    get: (key: string) => values[key],
  } as ConfigService;
  return new GitlabCodeHost(config);
}

function opened(source = 'feature/PROJ-1-ship'): unknown {
  return [
    {
      iid: 12,
      web_url: 'https://gitlab.example/group/demo/-/merge_requests/12',
      description: 'Already open.',
      source_branch: source,
    },
  ];
}

interface Seen {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

function mockFetch(bodies: unknown[], status: number | number[] = 200, nextPage: (string | null)[] = []): Seen[] {
  const seen: Seen[] = [];
  global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
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
  }) as unknown as typeof fetch;
  return seen;
}
