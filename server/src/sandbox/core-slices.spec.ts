import { checksAtOnce, coreListText, sliceSize } from './core-slices';

function expand(text: string): number[] {
  return text.split(',').flatMap((part) => {
    const [from, to] = part.split('-').map(Number) as [number, number | undefined];
    return Array.from({ length: (to ?? from) - from + 1 }, (_, offset) => from + offset);
  });
}

describe('checks at once', () => {
  it.each([
    [8, 3, 2, 4],
    [8, 1, 1, 8],
    [16, 3, 3, 5],
    [12, 2, 2, 6],
    [4, 3, 1, 4],
    [2, 3, 1, 2],
    [1, 3, 1, 1],
  ])('gives %i cores and CHECKS_PARALLEL %i %i checks of %i cores', (cores, parallel, places, size) => {
    const fit = checksAtOnce(cores, parallel);
    expect([fit, sliceSize(cores, fit)]).toEqual([places, size]);
    const lists = Array.from({ length: fit }, (_, index) => expand(coreListText({ cores, places: fit, index })));
    const all = lists.flat();
    expect(lists.every((list) => list.length > 0)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  it('allows CHECKS_PARALLEL checks when the cores are unknown', () => {
    expect(checksAtOnce(undefined, 3)).toBe(3);
  });
});
