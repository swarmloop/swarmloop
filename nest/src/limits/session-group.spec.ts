import { sessionFileName, sessionGroup, sessionHome } from './session-group';

describe('sessionGroup', () => {
  it('shares one home inside a chat and leaves other steps alone', () => {
    expect(sessionGroup('research')).toBe('plan');
    expect(sessionGroup('plan')).toBe('plan');
    expect(sessionGroup('plan-review')).toBe('plan');
    expect(sessionFileName('PROJ-20--1', 'plan')).toBe('PROJ-20--1-plan-session.json');
    expect(sessionFileName('PROJ-20--1', 'research')).toBe('PROJ-20--1-plan-session.json');
    expect(sessionGroup('implement')).toBe('implement');
    expect(sessionGroup('implement-review')).toBe('implement');
    expect(sessionGroup('implement-other')).toBe('implement');
    expect(sessionFileName('PROJ-20--1', 'implement')).toBe('PROJ-20--1-implement-session.json');
    expect(sessionFileName('PROJ-20--1', 'implement-review')).toBe('PROJ-20--1-implement-session.json');
    expect(sessionFileName('PROJ-20--1', 'implement-other')).toBe('PROJ-20--1-implement-session.json');
    expect(sessionGroup('code-review-security')).toBeNull();
    expect(sessionHome('code-review-security')).toBe('code-review-security');
    expect(sessionFileName('PROJ-20--1', 'code-review-security')).toBe('PROJ-20--1-code-review-security-session.json');
    expect(sessionHome('code-review-report')).toBe('code-review-report');
    expect(sessionGroup('commit')).toBeNull();
  });
});
