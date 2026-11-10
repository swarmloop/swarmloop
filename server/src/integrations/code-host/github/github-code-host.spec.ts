import { testEnv } from '../../../config/env.spec-helpers';
import { FakeClock } from '../../../core/fake-clock.spec-helpers';
import type { CodeHostEnv } from '../abstract-code-host';
import { GithubCodeHost } from './github-code-host';

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
    expect(seen[0]?.url).toBe(
      'https://api.github.com/repos/acme/demo/pulls?state=open&head=acme%3Afeature%2FPROJ-1-ship&per_page=20',
    );
    expect(seen[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
    expect(result.httpCalls[0]?.provider).toBe('github');
  });

  it('uses the enterprise api root', async () => {
    const seen = mockFetch([[]]);
    await service({ GITHUB_BASE_URL: 'https://github.example' }).findMergeRequest({
      project: 'acme/demo',
      source: 'feature/PROJ-1-ship',
    });
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
          {
            id: 9,
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/acme/demo/actions/runs/9',
          },
        ],
      },
      {
        jobs: [
          { id: 4, name: 'test', conclusion: 'failure' },
          { id: 5, name: 'lint', conclusion: 'success' },
        ],
      },
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

  it('cancels an actions run', async () => {
    const seen = mockFetch([{}]);
    const result = await service().cancelPipeline('acme/demo', 9);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/demo/actions/runs/9/cancel');
    expect(result.httpCalls[0]?.method).toBe('POST');
    expect(result.httpCalls[0]?.url).toContain('/actions/runs/9/cancel');
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('re-runs the failed jobs of an actions run', async () => {
    const seen = mockFetch([{}]);
    const result = await service().rerunFailedJobs('acme/demo', 9);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/demo/actions/runs/9/rerun-failed-jobs');
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('reads the annotations of the check runs of a run', async () => {
    const seen = mockFetch([
      { check_suite_id: 33 },
      { check_runs: [{ id: 71 }, { id: 72 }] },
      [{ message: 'The job was not started because your account has reached its spending limit.' }],
      [],
    ]);
    const result = await service().readRunNotes('acme/demo', 9);
    expect(result.notes).toBe('The job was not started because your account has reached its spending limit.');
    expect(seen[1]?.url).toBe('https://api.github.com/repos/acme/demo/check-suites/33/check-runs');
    expect(seen[2]?.url).toBe('https://api.github.com/repos/acme/demo/check-runs/71/annotations');
  });

  it('falls back to the message of the run when there are no annotations', async () => {
    mockFetch([{ check_suite_id: 33, message: 'startup failure' }, { check_runs: [] }]);
    expect((await service().readRunNotes('acme/demo', 9)).notes).toBe('startup failure');
  });

  it('keeps timed out, cancelled, startup failure and queued jobs under their own status', async () => {
    mockFetch([
      { workflow_runs: [{ id: 9, head_sha: 'abc', status: 'completed', conclusion: 'failure' }] },
      {
        jobs: [
          { id: 1, name: 'a', status: 'completed', conclusion: 'timed_out' },
          { id: 2, name: 'b', status: 'completed', conclusion: 'startup_failure' },
          { id: 3, name: 'c', status: 'queued', conclusion: null },
          { id: 4, name: 'd', status: 'completed', conclusion: 'failure' },
        ],
      },
    ]);
    const pipeline = await service().readBranchPipeline({
      project: 'acme/demo',
      ref: 'feature/PROJ-1-ship',
      sha: 'abc',
    });
    expect(pipeline.snapshot?.jobs.map((job) => job.status)).toEqual([
      'timed_out',
      'startup_failure',
      'queued',
      'failed',
    ]);
  });

  it('explains why a conflicting pull request cannot start CI', async () => {
    const seen = mockFetch([
      [{ number: 12, head: { ref: 'feature/task', sha: 'abc' } }],
      {
        state: 'open',
        head: { ref: 'feature/task', sha: 'abc' },
        mergeable: false,
        mergeable_state: 'dirty',
        html_url: 'https://github.com/acme/demo/pull/12',
      },
    ]);
    const result = await service().diagnoseMissingPipeline({ project: 'acme/demo', ref: 'feature/task', sha: 'abc' });
    expect(result.reason).toContain('has merge conflicts');
    expect(result.reason).toContain('Rebase');
    expect(result.code).toBe('merge-conflict');
    expect(seen[1]?.url).toBe('https://api.github.com/repos/acme/demo/pulls/12');
    expect(result.httpCalls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('reports a closed PR instead of recommending a rebase', async () => {
    mockFetch([[{ number: 12, head: { ref: 'feature/task', sha: 'abc' } }], { state: 'closed', mergeable: false }]);
    const result = await service().diagnoseMissingPipeline({ project: 'acme/demo', ref: 'feature/task', sha: 'abc' });
    expect(result.reason).toContain('is closed');
    expect(result.reason).not.toContain('Rebase');
    expect(result.code).toBe('closed');
  });

  it('does not diagnose another commit or guess while GitHub calculates mergeability', async () => {
    mockFetch([[{ number: 12, head: { ref: 'feature/task', sha: 'old' } }]]);
    expect(
      (await service().diagnoseMissingPipeline({ project: 'acme/demo', ref: 'feature/task', sha: 'abc' })).reason,
    ).toBeNull();
    mockFetch([
      [{ number: 12, head: { ref: 'feature/task', sha: 'abc' } }],
      { state: 'open', head: { ref: 'feature/task', sha: 'new' }, mergeable: false },
    ]);
    expect(
      (await service().diagnoseMissingPipeline({ project: 'acme/demo', ref: 'feature/task', sha: 'abc' })).code,
    ).toBeUndefined();
    mockFetch([
      [{ number: 12, head: { ref: 'feature/task', sha: 'abc' } }],
      { state: 'open', mergeable: null, mergeable_state: 'unknown' },
    ]);
    expect(
      (await service().diagnoseMissingPipeline({ project: 'acme/demo', ref: 'feature/task', sha: 'abc' })).reason,
    ).toBeNull();
  });

  it('lists a cancelled job on a canceled run and reads its log', async () => {
    const seen = mockFetch([
      {
        workflow_runs: [
          {
            id: 9,
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'cancelled',
            html_url: 'https://github.com/acme/demo/actions/runs/9',
          },
        ],
      },
      {
        jobs: [
          { id: 4, name: 'test', status: 'completed', conclusion: 'cancelled' },
          { id: 5, name: 'lint', conclusion: 'success' },
        ],
      },
      'canceled before the tests',
    ]);
    const host = service();
    const pipeline = await host.readBranchPipeline({ project: 'acme/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' });
    expect(pipeline.snapshot?.status).toBe('canceled');
    expect(pipeline.snapshot?.jobs).toEqual([
      { id: 4, name: 'test', stage: '', status: 'canceled', allowFailure: false },
    ]);
    const trace = await host.readJobTrace('acme/demo', 4);
    expect(trace.trace).toBe('canceled before the tests');
    expect(seen[2]?.url).toBe('https://api.github.com/repos/acme/demo/actions/jobs/4/logs');
  });

  it('keeps the name of an in-progress job', async () => {
    mockFetch([
      { workflow_runs: [{ id: 9, status: 'in_progress', html_url: 'https://github.com/acme/demo/actions/runs/9' }] },
      { jobs: [{ id: 4, name: 'test', status: 'in_progress', conclusion: null }] },
    ]);
    const pipeline = await service().readBranchPipeline({ project: 'acme/demo', ref: 'feature/PROJ-1-ship' });
    expect(pipeline.snapshot?.status).toBe('running');
    expect(pipeline.snapshot?.jobs).toEqual([
      { id: 4, name: 'test', stage: '', status: 'in_progress', allowFailure: false },
    ]);
  });

  it('skips the job list while a run is still going', async () => {
    const seen = mockFetch([
      { workflow_runs: [{ id: 9, status: 'in_progress', html_url: 'https://github.com/acme/demo/actions/runs/9' }] },
    ]);
    const pipeline = await service().readBranchPipeline({ project: 'acme/demo', ref: 'feature/PROJ-1-ship' }, false);
    expect(pipeline.snapshot?.status).toBe('running');
    expect(pipeline.snapshot?.jobs).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).not.toContain('/jobs');
  });

  it('still lists failed jobs when the running list is skipped', async () => {
    const seen = mockFetch([
      {
        workflow_runs: [
          {
            id: 9,
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/acme/demo/actions/runs/9',
          },
        ],
      },
      { jobs: [{ id: 4, name: 'test', conclusion: 'failure' }] },
    ]);
    const pipeline = await service().readBranchPipeline(
      { project: 'acme/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' },
      false,
    );
    expect(pipeline.snapshot?.jobs).toEqual([
      { id: 4, name: 'test', stage: '', status: 'failed', allowFailure: false },
    ]);
    expect(seen[1]?.url).toContain('/actions/runs/9/jobs');
  });

  it('names a rejected token', async () => {
    mockFetch([null], 401);
    await expect(service().findMergeRequest({ project: 'acme/demo', source: 'feature/PROJ-1-ship' })).rejects.toThrow(
      'GITHUB_TOKEN was rejected',
    );
  });

  it('reads a job log after the blob host answers 403 twice', async () => {
    const seen = mockLogs([403, 403, 200]);
    const result = await service().readJobTrace('acme/demo', 4);
    expect(result.trace).toBe('the log');
    expect(seen).toHaveLength(3);
    expect(result.httpCalls).toHaveLength(3);
  });

  it('says the log is unavailable when the blob host answers 403 three times', async () => {
    const seen = mockLogs([403, 403, 403]);
    const failure = service().readJobTrace('acme/demo', 4);
    await expect(failure).rejects.toThrow(
      'job log unavailable: HTTP 403 from productionresultssa16.blob.core.windows.net',
    );
    await expect(failure).rejects.not.toThrow('was rejected');
    expect(seen).toHaveLength(3);
  });

  it('still names a rejected token for a 403 from the api host, after one attempt', async () => {
    const seen = mockFetch([null], 403);
    await expect(service().readJobTrace('acme/demo', 4)).rejects.toThrow('GITHUB_TOKEN was rejected');
    expect(seen).toHaveLength(1);
  });

  it('never gives the token text for a response from another host', () => {
    const host = service() as unknown as {
      assertStatus(response: { status: number; url: string }, calls: unknown[], failure: string): void;
    };
    for (const status of [401, 403]) {
      expect(() => host.assertStatus({ status, url: 'https://blob.example/log' }, [], 'x')).toThrow(
        `job log unavailable: HTTP ${status} from blob.example`,
      );
    }
    expect(() => host.assertStatus({ status: 403, url: 'https://api.github.com/x' }, [], 'x')).toThrow(
      'GITHUB_TOKEN was rejected',
    );
  });

  it('builds a github https push url from ssh origin', () => {
    const host = service({ GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: 'tok' });
    expect(host.pushUrl('git@github.com:acme/demo.git')).toBe('https://x-access-token:tok@github.com/acme/demo.git');
    expect(host.pushUrl('git@gitlab.example:group/demo.git')).toBeNull();
  });

  it('names a missing token', async () => {
    await expect(
      service({ GITHUB_TOKEN: '' }).findMergeRequest({ project: 'acme/demo', source: 'feature/PROJ-1-ship' }),
    ).rejects.toThrow('GITHUB_TOKEN is missing');
  });

  it('reads the current user with one GET', async () => {
    const seen = mockFetch([{ id: 1 }]);
    await service().readCurrentUser();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('https://api.github.com/user');
    expect(seen[0]?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('names a rejected token when the current user is refused', async () => {
    mockFetch([{}], 401);
    await expect(service().readCurrentUser()).rejects.toThrow('was rejected');
  });
});

function service(overrides: Partial<CodeHostEnv> = {}): GithubCodeHost {
  const env = testEnv({ GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: TOKEN, ...overrides });
  return new GithubCodeHost(env, new FakeClock());
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

const BLOB = 'https://productionresultssa16.blob.core.windows.net/logs/4';

/** The logs endpoint redirects to a blob host; each call answers the next status. */
function mockLogs(statuses: number[]): string[] {
  const seen: string[] = [];
  global.fetch = jest.fn((url: string) => {
    seen.push(String(url));
    const code = statuses[seen.length - 1] ?? 200;
    return Promise.resolve({
      status: code,
      ok: code === 200,
      url: BLOB,
      headers: { get: () => 'text/plain' },
      arrayBuffer: () => Promise.resolve(Buffer.from('the log')),
    });
  }) as unknown as typeof fetch;
  return seen;
}
