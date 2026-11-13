import { footprintOf, memoryCap } from './footprint';

const GB = 1024 ** 3;

function peaks(count: number, rssBytes: number) {
  return Array.from({ length: count }, () => ({ rssBytes }));
}

describe('footprintOf', () => {
  it('takes the seed while there are fewer than 5 peaks', () => {
    expect(footprintOf('check', peaks(4, 9 * GB))).toEqual({ memoryBytes: 4 * GB });
    expect(footprintOf('agent', [])).toEqual({ memoryBytes: 2 * GB });
    expect(footprintOf('setup', [])).toEqual({ memoryBytes: 4 * GB });
  });

  it('takes the p80 of the memory peaks from 5 peaks on', () => {
    const samples = [1, 2, 3, 4, 100].map((gb) => ({ rssBytes: gb * GB }));
    expect(footprintOf('check', samples)).toEqual({ memoryBytes: 4 * GB });
  });

  it('does not depend on the order of the peaks', () => {
    const samples = [5, 1, 4, 2, 3].map((gb) => ({ rssBytes: gb * GB }));
    expect(footprintOf('agent', samples)).toEqual({ memoryBytes: 4 * GB });
  });
});

describe('memoryCap', () => {
  it('is never less than the seed', () => {
    expect(memoryCap('check', { memoryBytes: GB })).toBe(4 * GB);
    expect(memoryCap('agent', { memoryBytes: GB })).toBe(2 * GB);
  });

  it('gives a learned footprint headroom above it', () => {
    expect(memoryCap('check', { memoryBytes: 8 * GB })).toBe(12 * GB);
  });
});
