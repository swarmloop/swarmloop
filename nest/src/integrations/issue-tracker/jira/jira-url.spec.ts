import { jiraIssueKey, sameSiteIssueKey } from './jira-url';

const base = 'https://example.atlassian.net';

describe('jira issue urls', () => {
  it('reads a browse url on the same site', () => {
    expect(sameSiteIssueKey('https://example.atlassian.net/browse/PROJ-41', base)).toBe('PROJ-41');
    expect(sameSiteIssueKey('https://example.atlassian.net/browse/PROJ-41/', base)).toBe('PROJ-41');
  });

  it('reads a board url and an issue path', () => {
    expect(sameSiteIssueKey('https://example.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-41', base)).toBe(
      'PROJ-41',
    );
    expect(sameSiteIssueKey('https://example.atlassian.net/jira/software/projects/PROJ/issues/proj-41', base)).toBe('PROJ-41');
  });

  it('ignores another site and a confluence page', () => {
    expect(sameSiteIssueKey('https://other.atlassian.net/browse/PROJ-41', base)).toBeNull();
    expect(jiraIssueKey('https://example.atlassian.net/wiki/spaces/ENG/pages/42/Title')).toBeNull();
    expect(jiraIssueKey('not a url')).toBeNull();
  });
});
