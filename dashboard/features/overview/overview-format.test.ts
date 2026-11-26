import { describe, expect, it } from 'vitest';
import { compactCount, percent, returnsWords, wholeDollars } from './index';
import { longDuration } from './overview-format';

describe('overview formats', () => {
  it('shortens counts', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1234)).toBe('1.2k');
  });

  it('writes dollars without cents', () => {
    expect(wholeDollars(141.6)).toBe('$142');
    expect(wholeDollars(0)).toBe('$0');
  });

  it('writes a share as a whole percent', () => {
    expect(percent(0.862)).toBe('86.2%');
  });

  it('pads the minutes after hours', () => {
    expect(longDuration(12 * 3_600_000 + 4 * 60_000)).toBe('12h 04m');
    expect(longDuration(12 * 3_600_000 + 40 * 60_000)).toBe('12h 40m');
    expect(longDuration(5 * 60_000 + 3000)).toBe('5m 3s');
  });

  it('says the returns in words', () => {
    expect(returnsWords(0, true)).toBe('first pass');
    expect(returnsWords(1, true)).toBe('1 return, fixed');
    expect(returnsWords(2, true)).toBe('2 returns, all fixed');
    expect(returnsWords(2, false)).toBe('2 returns');
  });
});
