import { instantBackoff } from '../../instant-backoff.spec-helpers';
import { testEnv } from '../../../config/env.spec-helpers';
import { FakeClock } from '../../../core/fake-clock.spec-helpers';
import type { CodeHostEnv } from '../abstract-code-host';
import { FetchFailed, MergeConflict } from '../../../core/swarmloop-error';
import { GitlabCodeHost } from './gitlab-code-host';

const TOKEN = 'super-secret-token';

describe('gitlab host', () => {
  const original = global.fetch;

  beforeEach(() => {
    instantBackoff();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = original;
  });

  it('confirms conflicts only for the requested MR head and ignores unknown mergeability', async () => {
    const mr = { iid: 12, source_branch: 'feature/task', sha: 'abc', state: 'opened', has_conflicts: true };
    const ref = { project: 'group/demo', ref: 'feature/task', sha: 'abc' };
    const seen = mockFetch([[mr], mr]);
    expect((await service().diagnoseMissingPipeline(ref)).code).toBe('merge-conflict');
    expect(seen[0]?.url).toContain('with_merge_status_recheck=true');
    mockFetch([[mr], { ...mr, sha: 'new' }]);
    expect((await service().diagnoseMissingPipeline(ref)).code).toBeUndefined();
    mockFetch([[mr], { ...mr, has_conflicts: false, detailed_merge_status: 'checking' }]);
    expect((await service().diagnoseMissingPipeline(ref)).code).toBeUndefined();
    mockFetch([[mr], { ...mr, state: 'closed' }]);
    expect((await service().diagnoseMissingPipeline(ref)).code).toBe('closed');
  });

  it("creates the merge request's pipeline to start CI that never started", async () => {
    const seen = mockFetch([opened(), { id: 3 }, { id: 7 }]);
    const result = await service().startPipeline(
      { project: 'group/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' },
      'CI did not start',
    );
    expect(seen.map((call) => call.method)).toEqual(['GET', 'POST', 'POST']);
    expect(seen[1]?.url).toBe('https://gitlab.example/api/v4/projects/group%2Fdemo/merge_requests/12/notes');
    expect(JSON.parse(seen[1]?.body ?? '{}')).toEqual({ body: 'CI did not start' });
    expect(seen[2]?.url).toBe('https://gitlab.example/api/v4/projects/group%2Fdemo/merge_requests/12/pipelines');
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('creates no pipeline when no merge request is open for the ref', async () => {
    const seen = mockFetch([[]]);
    await service().startPipeline({ project: 'group/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' }, 'why');
    expect(seen.map((call) => call.method)).toEqual(['GET']);
  });

  it('returns an open merge request and does not create another', async () => {
    const seen = mockFetch([opened()]);
    const result = await service().findMergeRequest({ project: 'group/demo', source: 'feature/PROJ-1-ship' });
    expect(result.record).toEqual({
      project: 'group/demo',
      iid: 12,
      url: 'https://gitlab.example/group/demo/-/merge_requests/12',
      summary: 'Already open.',
      draft: false,
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
      draft: true,
    });
    expect(result.record.iid).toBe(12);
    expect(seen[0]?.method).toBe('POST');
    const body = JSON.parse(seen[0]?.body ?? '{}') as {
      source_branch: string;
      target_branch: string;
      description: string;
    };
    expect(body).toEqual({
      source_branch: 'feature/PROJ-1-ship',
      target_branch: 'main',
      title: 'Draft: Ship the field',
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
      draft: true,
    });
    expect(result.record.iid).toBe(12);
    expect(result.record.summary).toBe('Ships the field.');
    expect(seen.map((item) => item.method)).toEqual(['POST', 'GET', 'PUT']);
    expect(result.httpCalls).toHaveLength(3);
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('reads the newest pipeline and keeps a yellow job off the trace', async () => {
    const seen = mockFetch([
      [
        { id: 3, status: 'success' },
        { id: 9, status: 'failed' },
      ],
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
      [],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'old' });
    expect(result.snapshot?.id).toBe(3);
    expect(result.snapshot?.status).toBe('success');
  });

  it('reads every pipeline of the commit and the statuses of external apps', async () => {
    const seen = mockFetch([
      [
        { id: 8, sha: 'abc', status: 'failed', source: 'merge_request_event' },
        { id: 9, sha: 'abc', status: 'success', source: 'push' },
        { id: 4, sha: 'old', status: 'failed' },
      ],
      { id: 9, status: 'success', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
      [{ id: 1, name: 'build', stage: 'build', status: 'success' }],
      { id: 8, status: 'failed', web_url: 'https://gitlab.example/group/demo/-/pipelines/8' },
      [{ id: 7, name: 'unit', stage: 'test', status: 'failed', allow_failure: false }],
      [
        { id: 7, name: 'unit', status: 'failed' },
        {
          id: 50,
          name: 'sonar',
          status: 'failed',
          description: 'quality gate',
          target_url: 'https://sonar',
          author: { name: 'Sonar' },
        },
      ],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'abc' });
    expect(result.snapshot?.runs.map((run) => run.id)).toEqual([9, 8]);
    expect(result.snapshot?.id).toBe(8);
    expect(result.snapshot?.jobs.map((job) => job.name)).toEqual(['unit']);
    expect(result.snapshot?.checks.map((check) => [check.name, check.app, check.workflow])).toEqual([
      ['build', 'GitLab CI', true],
      ['unit', 'GitLab CI', true],
      ['sonar', 'Sonar', false],
    ]);
    expect(result.snapshot?.checks[2]).toMatchObject({ status: 'failed', summary: 'quality gate' });
    expect(seen[5]?.url).toContain('/repository/commits/abc/statuses');
  });

  it('judges a source by its newest pipeline, so an old stuck pipeline of the commit is ignored', async () => {
    const seen = mockFetch([
      [
        { id: 6, sha: 'abc', status: 'success', source: 'push' },
        { id: 5, sha: 'abc', status: 'pending', source: 'push' },
      ],
      { id: 6, status: 'success' },
      [{ id: 1, name: 'build', stage: 'build', status: 'success' }],
      [],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'abc' });
    expect(result.snapshot?.status).toBe('success');
    expect(result.snapshot?.runs.map((run) => run.id)).toEqual([6]);
    expect(seen.some((call) => call.url.includes('/pipelines/5'))).toBe(false);
  });

  it('counts the jobs of a pipeline that has not started', async () => {
    mockFetch([[{ id: 5, sha: 'abc', status: 'pending', source: 'push' }], { id: 5, status: 'pending' }, [], []]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'abc' });
    expect(result.snapshot?.runs).toMatchObject([{ id: 5, status: 'running', total: 0, queued: true }]);
  });

  it('is green when a failure is allowed and a manual job is not required', async () => {
    mockFetch([
      [{ id: 9, sha: 'abc', status: 'success' }],
      { id: 9, status: 'success' },
      [
        { id: 1, name: 'lint', status: 'failed', allow_failure: true },
        { id: 2, name: 'deploy', status: 'manual', allow_failure: true },
        { id: 3, name: 'release', status: 'manual', allow_failure: false },
      ],
      [{ id: 60, name: 'coverage', status: 'success' }],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'abc' });
    expect(result.snapshot?.status).toBe('success');
    expect(result.snapshot?.checks.map((check) => check.status)).toEqual(['success', 'skipped', 'manual', 'success']);
  });

  it('is running while an external status is pending', async () => {
    mockFetch([
      [{ id: 9, sha: 'abc', status: 'success' }],
      { id: 9, status: 'success' },
      [],
      [{ id: 60, name: 'coverage', status: 'pending' }],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1', sha: 'abc' });
    expect(result.snapshot?.status).toBe('running');
  });

  it('returns no pipeline when the branch has none', async () => {
    mockFetch([[]]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(result.snapshot).toBeNull();
  });

  it('cancels a pipeline', async () => {
    const seen = mockFetch([{}]);
    const result = await service().cancelPipeline('group/demo', 9);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://gitlab.example/api/v4/projects/group%2Fdemo/pipelines/9/cancel');
    expect(result.httpCalls[0]?.method).toBe('POST');
    expect(result.httpCalls[0]?.url).toContain('/pipelines/9/cancel');
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('retries a pipeline', async () => {
    const seen = mockFetch([{}]);
    const result = await service().rerunFailedJobs('group/demo', 9);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://gitlab.example/api/v4/projects/group%2Fdemo/pipelines/9/retry');
    expect(JSON.stringify(result.httpCalls)).not.toContain(TOKEN);
  });

  it('reads the failure reason and yaml errors of a pipeline', async () => {
    const seen = mockFetch([
      { id: 9, failure_reason: 'config_error', yaml_errors: 'jobs:test config key may not be empty' },
    ]);
    const result = await service().readRunNotes('group/demo', 9);
    expect(result.notes).toBe('config_error jobs:test config key may not be empty');
    expect(seen[0]?.url).toBe('https://gitlab.example/api/v4/projects/group%2Fdemo/pipelines/9');
  });

  it('asks a canceled pipeline for the jobs that never started', async () => {
    const seen = mockFetch([
      [{ id: 9, status: 'canceled' }],
      { id: 9, status: 'canceled' },
      [{ id: 8, name: 'lint', stage: 'test', status: 'created' }],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(seen[2]?.url).toContain('/pipelines/9/jobs');
    expect(result.snapshot?.jobs.map((job) => job.status)).toEqual(['created']);
  });

  it('lists a canceled job and reads its trace', async () => {
    const seen = mockFetch([
      [{ id: 9, status: 'canceled' }],
      { id: 9, status: 'canceled', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
      [{ id: 7, name: 'unit', stage: 'test', status: 'canceled', allow_failure: true }],
      'unit canceled\n',
    ]);
    const host = service();
    const result = await host.readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(result.snapshot?.status).toBe('canceled');
    expect(result.snapshot?.jobs).toEqual([
      { id: 7, name: 'unit', stage: 'test', status: 'canceled', allowFailure: false },
    ]);
    expect(seen[2]?.url).toContain('/pipelines/9/jobs');
    const trace = await host.readJobTrace('group/demo', 7);
    expect(trace.trace).toBe('unit canceled\n');
  });

  it('keeps the name of a running job', async () => {
    const seen = mockFetch([
      [{ id: 9, status: 'running' }],
      { id: 9, status: 'running', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
      [{ id: 4, name: 'test', stage: 'test', status: 'running' }],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' });
    expect(result.snapshot?.jobs.map((job) => job.name)).toEqual(['test']);
    expect(seen[2]?.url).toContain('/pipelines/9/jobs');
  });

  it('skips running and pending jobs while a pipeline is still going', async () => {
    const seen = mockFetch([
      [{ id: 9, status: 'pending' }],
      { id: 9, status: 'pending', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' }, false);
    expect(result.snapshot?.status).toBe('running');
    expect(result.snapshot?.jobs).toEqual([]);
    expect(seen.map((call) => call.url).filter((url) => url.includes('/jobs'))).toHaveLength(1);
  });

  it('still lists failed jobs when the running list is skipped', async () => {
    const seen = mockFetch([
      [{ id: 9, status: 'failed' }],
      { id: 9, status: 'failed', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
      [{ id: 7, name: 'unit', stage: 'test', status: 'failed', allow_failure: false }],
    ]);
    const result = await service().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' }, false);
    expect(result.snapshot?.jobs.map((job) => job.name)).toEqual(['unit']);
    expect(seen[2]?.url).toContain('/pipelines/9/jobs');
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

  it('builds a gitlab https push url from ssh origin', () => {
    const host = service({ GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: 'tok' });
    expect(host.pushUrl('git@gitlab.example:group/demo.git')).toBe('https://oauth2:tok@gitlab.example/group/demo.git');
    expect(host.pushUrl('/tmp/demo.git')).toBeNull();
  });

  it('names a missing token and does not call gitlab', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    await expect(
      service({ GITLAB_TOKEN: '' }).findMergeRequest({ project: 'group/demo', source: 'feature/x' }),
    ).rejects.toThrow(/GITLAB_TOKEN is missing/);
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

  it('reads the current user with one GET', async () => {
    const seen = mockFetch([{ id: 1 }]);
    await service().readCurrentUser();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url).toBe('https://gitlab.example/api/v4/user');
    expect(seen[0]?.headers['PRIVATE-TOKEN']).toBe(TOKEN);
  });

  it('names a rejected token when the current user is refused', async () => {
    mockFetch([{}], 401);
    await expect(service().readCurrentUser()).rejects.toThrow('was rejected');
  });

  describe('merging', () => {
    it('squash-merges a merge request and returns the squash commit', async () => {
      const seen = mockFetch([{ state: 'merged', squash_commit_sha: 'abc123', merge_commit_sha: null }]);
      const result = await service().mergeMergeRequest('group/demo', 12);
      expect(result.sha).toBe('abc123');
      expect(seen[0]?.method).toBe('PUT');
      expect(seen[0]?.url).toBe('https://gitlab.example/api/v4/projects/group%2Fdemo/merge_requests/12/merge');
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ squash: true });
    });

    it('refuses a conflicting merge request with a MergeConflict', async () => {
      mockFetch([{ message: 'Branch cannot be merged' }], 406);
      await expect(service().mergeMergeRequest('group/demo', 12)).rejects.toBeInstanceOf(MergeConflict);
    });

    it('keeps the message of any other refusal and does not call it a conflict', async () => {
      mockFetch([{ message: '405 Method Not Allowed' }], 405);
      const error: unknown = await service()
        .mergeMergeRequest('group/demo', 12)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FetchFailed);
      expect(error).not.toBeInstanceOf(MergeConflict);
      expect((error as Error).message).toBe('405 Method Not Allowed');
      mockFetch([{ message: '403 Forbidden' }], 403);
      await expect(service().mergeMergeRequest('group/demo', 12)).rejects.toThrow('403 Forbidden');
    });

    it('reads whether a merge request is merged, with its commit, and whether it conflicts', async () => {
      mockFetch([{ state: 'merged', merge_commit_sha: 'abc123' }]);
      expect(await service().readMergeRequest('group/demo', 12)).toMatchObject({
        state: 'merged',
        sha: 'abc123',
        conflicts: false,
      });
      mockFetch([{ state: 'opened', has_conflicts: true }]);
      expect(await service().readMergeRequest('group/demo', 12)).toMatchObject({
        state: 'open',
        sha: null,
        conflicts: true,
      });
    });

    it('reads who merged a merge request and when, and who closed one that was not merged', async () => {
      mockFetch([
        {
          state: 'merged',
          merge_commit_sha: 'abc123',
          merged_by: { username: 'ada' },
          merged_at: '2026-05-01T10:00:00Z',
        },
      ]);
      expect(await service().mergeRequestState('group/demo', 12)).toMatchObject({
        state: 'merged',
        sha: 'abc123',
        by: 'ada',
        at: '2026-05-01T10:00:00Z',
      });
      mockFetch([{ state: 'opened' }]);
      expect(await service().mergeRequestState('group/demo', 12)).toMatchObject({ state: 'open' });
      mockFetch([{ state: 'closed', closed_by: { username: 'grace' }, closed_at: '2026-05-02T08:00:00Z' }]);
      expect(await service().mergeRequestState('group/demo', 12)).toMatchObject({
        state: 'closed',
        by: 'grace',
        at: '2026-05-02T08:00:00Z',
      });
      mockFetch([{ message: 'boom' }], 500);
      await expect(service().mergeRequestState('group/demo', 12)).rejects.toThrow();
    });

    it('closes an open merge request and leaves a merged one alone', async () => {
      const seen = mockFetch([{ state: 'opened' }, {}]);
      await service().closeMergeRequest('group/demo', 12);
      expect(seen.map((call) => call.method)).toEqual(['GET', 'PUT']);
      expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ state_event: 'close' });
      const merged = mockFetch([{ state: 'merged' }]);
      await service().closeMergeRequest('group/demo', 12);
      expect(merged).toHaveLength(1);
    });

    it('deletes a branch, and takes a branch that is already gone as deleted', async () => {
      const seen = mockFetch([null], 204);
      await service().deleteBranch('group/demo', 'feature/PROJ-1-ship');
      expect(seen[0]?.method).toBe('DELETE');
      expect(seen[0]?.url).toBe(
        'https://gitlab.example/api/v4/projects/group%2Fdemo/repository/branches/feature%2FPROJ-1-ship',
      );
      mockFetch([{ message: '404 Branch Not Found' }], 404);
      await expect(service().deleteBranch('group/demo', 'feature/PROJ-1-ship')).resolves.toBeDefined();
    });
  });
});

function service(overrides: Partial<CodeHostEnv> = {}): GitlabCodeHost {
  const env = testEnv({ GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: TOKEN, ...overrides });
  return new GitlabCodeHost(env, new FakeClock());
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
