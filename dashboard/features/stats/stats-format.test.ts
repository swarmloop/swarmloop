import { describe, expect, it } from 'vitest';
import { percent } from './stats-format';

describe('percent', () => {
  it('never rounds a part up to 100%', () => {
    expect(percent(262, 263)).toBe('99.6%');
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
