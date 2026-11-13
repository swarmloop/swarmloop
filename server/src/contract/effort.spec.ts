import { highestOf, isEffort } from './effort';

describe('effort', () => {
  it('accepts the five words and nothing else', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].every(isEffort)).toBe(true);
    expect(isEffort('extra-high')).toBe(false);
    expect(isEffort('')).toBe(false);
  });

  it('keeps a listed level and falls back to the highest one below it', () => {
    expect(highestOf(['low', 'high'], 'high')).toBe('high');
    expect(highestOf(['low', 'high'], 'xhigh')).toBe('high');
    expect(highestOf(['high'], 'low')).toBeNull();
    expect(highestOf([], 'max')).toBeNull();
  });
});
