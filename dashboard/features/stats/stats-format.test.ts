import { describe, expect, it } from 'vitest';
import { percent } from './stats-format';

describe('percent', () => {
  it('never rounds a part up to 100%', () => {
    expect(percent(262, 263)).toBe('99.6%');
  });

  it('reads 99.9% for a part just under the whole, even when it would round to 100', () => {
    expect(percent(2629, 2630)).toBe('99.9%');
    expect(percent(412.37, 412.5)).toBe('99.9%');
  });

  it('reads 100% when the part is the whole', () => {
    expect(percent(263, 263)).toBe('100%');
  });

  it('reads a dash when there is no whole', () => {
    expect(percent(0, 0)).toBe('—');
  });

  it('writes one decimal', () => {
    expect(percent(1, 3)).toBe('33.3%');
  });
});
