import { effortsOfList, highestOf, isEffort } from './effort';

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

  describe('effortsOfList', () => {
    const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

    it('runs a first entry without effort at the base level', () => {
      expect(effortsOfList([{}], 'medium', () => all)).toEqual([
        { effort: 'medium', wanted: 'medium', from: 'default' },
      ]);
    });

    it('lets an entry take the level of the entry before it, and an own effort win', () => {
      expect(effortsOfList([{ own: 'high' }, {}, { own: 'low' }], 'medium', () => all)).toEqual([
        { effort: 'high', wanted: 'high', from: 'own' },
        { effort: 'high', wanted: 'high', from: 'above' },
        { effort: 'low', wanted: 'low', from: 'own' },
      ]);
    });

    it('passes the level before the cap on to the next entry', () => {
      const offered = [all, ['low', 'medium', 'high', 'xhigh'] as const];
      const [first, second] = effortsOfList([{ own: 'max' }, {}], 'low', (index) => offered[index]);
      expect(first.effort).toBe('max');
      expect(second).toEqual({ effort: 'xhigh', wanted: 'max', from: 'above' });
    });

    it('gives no effort to a runtime that offers no level', () => {
      const [first, second] = effortsOfList([{}, {}], 'high', (index) => (index === 0 ? [] : all));
      expect(first).toEqual({ effort: null, wanted: 'high', from: 'default' });
      expect(second.effort).toBe('high');
    });
  });
});
