import { mockFetch as githubFetch, service as githubService } from './github/github-code-host.spec-helpers';
import { mockFetch as gitlabFetch, service as gitlabService } from './gitlab/gitlab-code-host.spec-helpers';
import type { MergeGate } from './code-host';

type Mapping = Pick<MergeGate, 'mergeability' | 'blockedBy'>;

const CLEAN: Mapping = { mergeability: 'clean', blockedBy: null };
const UNKNOWN: Mapping = { mergeability: 'unknown', blockedBy: null };
const BEHIND: Mapping = { mergeability: 'behind', blockedBy: null };
const CONFLICTING: Mapping = { mergeability: 'conflicting', blockedBy: null };

describe('github merge gate', () => {
  const pull = (extra: object): object => ({
    state: 'open',
    draft: false,
    head: { ref: 'feature/x', sha: 'abc123' },
    mergeable: true,
    ...extra,
  });

  it.each<[string, object, Mapping]>([
    ['clean', { mergeable_state: 'clean' }, CLEAN],
    ['has_hooks', { mergeable_state: 'has_hooks' }, CLEAN],
    ['unstable', { mergeable_state: 'unstable' }, CLEAN],
    ['behind', { mergeable_state: 'behind' }, BEHIND],
    ['dirty', { mergeable: false, mergeable_state: 'dirty' }, CONFLICTING],
    ['blocked', { mergeable_state: 'blocked' }, { mergeability: 'blocked', blockedBy: 'required reviews or checks' }],
    ['unknown', { mergeable_state: 'unknown' }, UNKNOWN],
    ['a null mergeable', { mergeable: null, mergeable_state: 'clean' }, UNKNOWN],
  ])('maps %s', async (_name, extra, expected) => {
    githubFetch([pull(extra)]);
    const gate = await githubService().readMergeGate('acme/demo', 12);
    expect(gate).toMatchObject({ ...expected, state: 'open', sha: null, draft: false, head: 'abc123' });
  });

  it('reports a draft and a merged request with its commit', async () => {
    githubFetch([pull({ draft: true, merged: true, merge_commit_sha: 'm1', mergeable_state: 'clean' })]);
    const gate = await githubService().readMergeGate('acme/demo', 12);
    expect(gate).toMatchObject({ state: 'merged', sha: 'm1', draft: true });
  });

  it('reads the default branch and its tip, in that order', async () => {
    const seen = githubFetch([{ default_branch: 'main' }, { commit: { sha: 'tip1' } }]);
    const head = await githubService().readDefaultHead('acme/demo');
    expect(head).toMatchObject({ branch: 'main', sha: 'tip1' });
    expect(seen.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/acme/demo',
      'https://api.github.com/repos/acme/demo/branches/main',
    ]);
  });

  it('reads the tip of a branch', async () => {
    const seen = githubFetch([{ commit: { sha: 'tip3' } }]);
    const head = await githubService().readBranchHead({ project: 'acme/demo', ref: 'feature/a-b', sha: 'old' });
    expect(head.sha).toBe('tip3');
    expect(seen.map((call) => call.url)).toEqual(['https://api.github.com/repos/acme/demo/branches/feature%2Fa-b']);
  });

  it('guards a merge with the head, and sends the same payload as before without one', async () => {
    const seen = githubFetch([{ sha: 'm1' }]);
    await githubService().mergeMergeRequest('acme/demo', 12, 'abc123');
    await githubService().mergeMergeRequest('acme/demo', 12);
    expect(seen.map((call) => call.body)).toEqual([
      '{"merge_method":"squash","sha":"abc123"}',
      '{"merge_method":"squash"}',
    ]);
  });
});

describe('gitlab merge gate', () => {
  const request = (extra: object): object => ({
    state: 'opened',
    sha: 'def456',
    draft: false,
    ...extra,
  });
  const blocked = (word: string): Mapping => ({ mergeability: 'blocked', blockedBy: word });

  it.each<[string, Mapping]>([
    ['mergeable', CLEAN],
    ['ci_must_pass', CLEAN],
    ['ci_still_running', CLEAN],
    ['need_rebase', BEHIND],
    ['conflict', CONFLICTING],
    ['broken_status', CONFLICTING],
    ['checking', UNKNOWN],
    ['unchecked', UNKNOWN],
    ['preparing', UNKNOWN],
    ['approvals_syncing', UNKNOWN],
    ['not_approved', blocked('not_approved')],
    ['discussions_not_resolved', blocked('discussions_not_resolved')],
    ['requested_changes', blocked('requested_changes')],
    ['blocked_status', blocked('blocked_status')],
  ])('maps %s', async (status, expected) => {
    gitlabFetch([request({ detailed_merge_status: status })]);
    const gate = await gitlabService().readMergeGate('group/demo', 12);
    expect(gate).toMatchObject({ ...expected, state: 'open', sha: null, draft: false, head: 'def456' });
  });

  it('takes the draft from work_in_progress', async () => {
    gitlabFetch([request({ work_in_progress: true, detailed_merge_status: 'mergeable' })]);
    expect((await gitlabService().readMergeGate('group/demo', 12)).draft).toBe(true);
  });

  it('reads the default branch and its tip, in that order', async () => {
    const seen = gitlabFetch([{ default_branch: 'main' }, { commit: { id: 'tip2' } }]);
    const head = await gitlabService().readDefaultHead('group/demo');
    expect(head).toMatchObject({ branch: 'main', sha: 'tip2' });
    expect(seen.map((call) => call.url)).toEqual([
      'https://gitlab.example/api/v4/projects/group%2Fdemo',
      'https://gitlab.example/api/v4/projects/group%2Fdemo/repository/branches/main',
    ]);
  });

  it('reads the tip of a branch', async () => {
    const seen = gitlabFetch([{ commit: { id: 'tip4' } }]);
    const head = await gitlabService().readBranchHead({ project: 'group/demo', ref: 'feature/a-b', sha: 'old' });
    expect(head.sha).toBe('tip4');
    expect(seen.map((call) => call.url)).toEqual([
      'https://gitlab.example/api/v4/projects/group%2Fdemo/repository/branches/feature%2Fa-b',
    ]);
  });

  it('guards a merge with the head, and sends the same payload as before without one', async () => {
    const seen = gitlabFetch([{ merge_commit_sha: 'm2' }]);
    await gitlabService().mergeMergeRequest('group/demo', 12, 'def456');
    await gitlabService().mergeMergeRequest('group/demo', 12);
    expect(seen.map((call) => call.body)).toEqual(['{"squash":true,"sha":"def456"}', '{"squash":true}']);
  });
});
