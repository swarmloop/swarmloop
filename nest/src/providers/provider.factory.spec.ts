import { createIssueTracker } from '../integrations/issue-tracker/issue-tracker.registry';
import { createRequirementsSource } from './provider.factory';

describe('provider factory', () => {
  const tracker = { fetch: jest.fn() };
  const agent = { write: jest.fn() };
  const direct = { write: jest.fn() };

  it('rejects an unknown issue tracker', () => {
    expect(() => createIssueTracker('github', tracker)).toThrow(/ISSUE_TRACKER has unknown value github/);
  });

  it('rejects an unknown requirements source', () => {
    expect(() => createRequirementsSource('other', { agent, direct })).toThrow(/REQUIREMENTS_VIA has unknown value other/);
  });

  it('returns the jira tracker and the direct source', () => {
    expect(createIssueTracker('jira', tracker)).toBe(tracker);
    expect(createRequirementsSource('direct', { agent, direct })).toBe(direct);
  });
});
