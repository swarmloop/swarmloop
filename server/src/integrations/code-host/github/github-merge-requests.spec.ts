import { instantBackoff } from '../../instant-backoff.spec-helpers';
import { FetchFailed, MergeConflict } from '../../../core/swarmloop-error';
import { TOKEN, mockFetch, opened, service } from './github-code-host.spec-helpers';

describe('github merge requests', () => {
  const original = global.fetch;

  beforeEach(() => {
    instantBackoff();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
      draft: false,
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
      draft: true,
    });
    expect(result.record.iid).toBe(12);
    expect(seen[0]?.method).toBe('POST');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      title: 'Ship the field',
      head: 'feature/PROJ-1-ship',
      base: 'main',
      body: 'Ships the field.',
      draft: true,
    });
  });

  it('marks a pull request ready through the GraphQL api next to the enterprise rest root', async () => {
    const seen = mockFetch([{ number: 12, node_id: 'PR_12', draft: true }, { data: {} }]);
    await service({ GITHUB_BASE_URL: 'https://github.example' }).setDraft('acme/demo', 12, false);
    expect(seen.map((call) => call.url)).toEqual([
      'https://github.example/api/v3/repos/acme/demo/pulls/12',
      'https://github.example/api/graphql',
    ]);
    const sent = JSON.parse(seen[1]?.body ?? '{}') as { query: string; variables: { id: string } };
    expect(sent.query).toContain('markPullRequestReadyForReview');
    expect(sent.variables.id).toBe('PR_12');
  });

  it('fails when GraphQL answers with errors in a 200', async () => {
    mockFetch([{ number: 12, node_id: 'PR_12', draft: false }, { errors: [{ message: 'Resource not accessible' }] }]);
    await expect(service().setDraft('acme/demo', 12, true)).rejects.toThrow('Resource not accessible');
  });

  describe('starting a pipeline that never started', () => {
    const ref = { project: 'acme/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' };
    const draftOpened = (): unknown => [{ ...(opened() as object[])[0], draft: true, node_id: 'PR_12' }];

    it('closes and reopens a draft, and marks it a draft again when GitHub reopened it as ready', async () => {
      const seen = mockFetch([draftOpened(), {}, {}, { number: 12, node_id: 'PR_12', draft: false }, { data: {} }]);
      await service().startPipeline(ref);
      expect(seen.map((call) => `${call.method} ${call.url.replace('https://api.github.com', '')}`)).toEqual([
        expect.stringContaining('GET /repos/acme/demo/pulls?state=open'),
        'PATCH /repos/acme/demo/pulls/12',
        'PATCH /repos/acme/demo/pulls/12',
        'GET /repos/acme/demo/pulls/12',
        'POST /graphql',
      ]);
      expect(seen.slice(1, 3).map((call) => JSON.parse(call.body))).toEqual([{ state: 'closed' }, { state: 'open' }]);
      expect(JSON.parse(seen[4]?.body ?? '{}').query).toContain('convertPullRequestToDraft');
    });

    it('leaves a ready pull request ready', async () => {
      const seen = mockFetch([opened(), {}, {}, { number: 12, node_id: 'PR_12', draft: false }]);
      await service().startPipeline(ref);
      expect(seen.map((call) => call.method)).toEqual(['GET', 'PATCH', 'PATCH', 'GET']);
    });

    it('makes no call to change a pull request when none is open', async () => {
      const seen = mockFetch([[]]);
      const result = await service().startPipeline(ref);
      expect(seen.map((call) => call.method)).toEqual(['GET']);
      expect(result.httpCalls).toHaveLength(1);
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
      draft: true,
    });
    expect(result.record.summary).toBe('Updated.');
    expect(seen.map((call) => call.method)).toEqual(['POST', 'GET', 'PATCH']);
  });

  describe('merging', () => {
    it('squash-merges a pull request and returns the merge commit', async () => {
      const seen = mockFetch([{ sha: 'abc123', merged: true }]);
      const result = await service().mergeMergeRequest('acme/demo', 12);
      expect(result.sha).toBe('abc123');
      expect(seen[0]?.method).toBe('PUT');
      expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/demo/pulls/12/merge');
      expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ merge_method: 'squash' });
    });

    it('refuses a conflicting pull request with a MergeConflict', async () => {
      mockFetch([{ message: 'Pull Request is not mergeable' }], 405);
      await expect(service().mergeMergeRequest('acme/demo', 12)).rejects.toBeInstanceOf(MergeConflict);
    });

    it('keeps the message of any other refusal and does not call it a conflict', async () => {
      mockFetch([{ message: 'At least 1 approving review is required by reviewers with write access.' }], 405);
      const error: unknown = await service()
        .mergeMergeRequest('acme/demo', 12)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FetchFailed);
      expect(error).not.toBeInstanceOf(MergeConflict);
      expect((error as Error).message).toBe('At least 1 approving review is required by reviewers with write access.');
      mockFetch([{ message: 'Resource not accessible by personal access token' }], 403);
      await expect(service().mergeMergeRequest('acme/demo', 12)).rejects.toThrow(
        'Resource not accessible by personal access token',
      );
    });

    it('reads whether a pull request is merged, with its commit, and whether it conflicts', async () => {
      mockFetch([{ state: 'closed', merged: true, merge_commit_sha: 'abc123', mergeable: null }]);
      expect(await service().readMergeRequest('acme/demo', 12)).toMatchObject({
        state: 'merged',
        sha: 'abc123',
        conflicts: false,
      });
      mockFetch([{ state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty' }]);
      expect(await service().readMergeRequest('acme/demo', 12)).toMatchObject({
        state: 'open',
        sha: null,
        conflicts: true,
      });
    });

    it('reads who merged a pull request and when, and who closed one that was not merged', async () => {
      mockFetch([
        {
          state: 'closed',
          merged: true,
          merge_commit_sha: 'abc123',
          merged_by: { login: 'ada' },
          merged_at: '2026-05-01T10:00:00Z',
        },
      ]);
      expect(await service().mergeRequestState('acme/demo', 12)).toMatchObject({
        state: 'merged',
        sha: 'abc123',
        by: 'ada',
        at: '2026-05-01T10:00:00Z',
      });
      mockFetch([{ state: 'open', merged: false }]);
      expect(await service().mergeRequestState('acme/demo', 12)).toMatchObject({ state: 'open' });
      const seen = mockFetch([
        { state: 'closed', merged: false, closed_at: '2026-05-02T08:00:00Z' },
        { closed_by: { login: 'grace' } },
      ]);
      expect(await service().mergeRequestState('acme/demo', 12)).toMatchObject({
        state: 'closed',
        by: 'grace',
        at: '2026-05-02T08:00:00Z',
      });
      expect(seen[1]?.url).toBe('https://api.github.com/repos/acme/demo/issues/12');
    });

    it('leaves the closer unknown when the issue cannot be read, and fails when the pull cannot', async () => {
      mockFetch([{ state: 'closed', merged: false, closed_at: '2026-05-02T08:00:00Z' }, {}], [200, 500]);
      expect(await service().mergeRequestState('acme/demo', 12)).toMatchObject({ state: 'closed', by: null });
      mockFetch([{ message: 'boom' }], 500);
      await expect(service().mergeRequestState('acme/demo', 12)).rejects.toThrow();
    });

    it('closes an open pull request and leaves a merged one alone', async () => {
      const seen = mockFetch([{ state: 'open' }, {}]);
      await service().closeMergeRequest('acme/demo', 12);
      expect(seen.map((call) => call.method)).toEqual(['GET', 'PATCH']);
      expect(JSON.parse(seen[1]?.body ?? '')).toEqual({ state: 'closed' });
      const merged = mockFetch([{ state: 'closed', merged: true }]);
      await service().closeMergeRequest('acme/demo', 12);
      expect(merged).toHaveLength(1);
    });

    it('deletes a branch, and takes a branch that is already gone as deleted', async () => {
      const seen = mockFetch([null], 204);
      await service().deleteBranch('acme/demo', 'feature/PROJ-1-ship');
      expect(seen[0]?.method).toBe('DELETE');
      expect(seen[0]?.url).toBe('https://api.github.com/repos/acme/demo/git/refs/heads/feature/PROJ-1-ship');
      mockFetch([{ message: 'Reference does not exist' }], 422);
      await expect(service().deleteBranch('acme/demo', 'feature/PROJ-1-ship')).resolves.toBeDefined();
    });
  });
});
