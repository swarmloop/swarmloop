import { defaultLevelOf } from './default-levels';

describe('defaultLevelOf', () => {
  it('reads the effort of the first entry of each list from the shipped defaults.env', () => {
    expect(defaultLevelOf('AGENTS_PLAN')).toBe('high');
    expect(defaultLevelOf('AGENTS_SUBTASK_REVIEW')).toBe('medium');
    expect(defaultLevelOf('AGENTS_BACKLOG_PLAN')).toBe('high');
    expect(defaultLevelOf('AGENTS_READ')).toBe('medium');
  });

  it('refuses a list that defaults.env does not name', () => {
    expect(() => defaultLevelOf('AGENTS_NOPE')).toThrow('AGENTS_NOPE');
  });
});
