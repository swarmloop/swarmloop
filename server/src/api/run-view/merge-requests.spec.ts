import { mergeRequestViews } from './merge-requests';

const github = 'project: acme/web\niid: 7\nurl: https://github.com/acme/web/pull/7\ndraft: true\n';
const gitlab = 'project: acme/api\niid: 12\nurl: https://gitlab.com/acme/api/-/merge_requests/12\ndraft: false\n';
const both = `${github}\n${gitlab}`;
const repos = 'web\napi\n';

describe('mergeRequestViews', () => {
  it('gives no links without a merge_request document or with an unreadable one', () => {
    expect(mergeRequestViews(null, null, repos)).toEqual([]);
    expect(mergeRequestViews(null, 'nothing here', repos)).toEqual([]);
  });

  it('reads draft and open from the stored flag for a GitHub and a GitLab record', () => {
    expect(mergeRequestViews(null, both, repos)).toEqual([
      { repo: 'web', url: 'https://github.com/acme/web/pull/7', state: 'draft' },
      { repo: 'api', url: 'https://gitlab.com/acme/api/-/merge_requests/12', state: 'open' },
    ]);
  });

  it('marks every record merged when the outcome is merged', () => {
    const outcome = JSON.stringify({ merged: { web: { sha: 'a', by: null, at: 't', url: null } } });
    expect(mergeRequestViews(outcome, both, repos).map((view) => view.state)).toEqual(['merged', 'merged']);
  });

  it('marks only the closed repository closed', () => {
    const outcome = JSON.stringify({ closed: { repo: 'api', by: null, at: 't' } });
    expect(mergeRequestViews(outcome, both, repos).map((view) => view.state)).toEqual(['draft', 'closed']);
  });

  it('falls back to the project when the repos do not match the records', () => {
    expect(mergeRequestViews(null, github, repos)[0]?.repo).toBe('acme/web');
    expect(mergeRequestViews(null, both, 'web\n').map((view) => view.repo)).toEqual(['acme/web', 'acme/api']);
  });
});
