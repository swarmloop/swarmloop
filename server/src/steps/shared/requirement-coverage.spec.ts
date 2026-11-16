import type { Requirement } from '../../contract/requirement-list';
import { coverageOf, coverageProblems, mergeRequirements } from './requirement-coverage';

const nine: Requirement[] = Array.from({ length: 9 }, (_, index) => ({
  id: `R${index + 1}`,
  text: `requirement ${index + 1}`,
}));
const unit = (item: string, ...covers: string[]) => ({ item, covers });
const coveringEight = [unit('first', 'R1', 'R2', 'R3', 'R4'), unit('second', 'R5', 'R6', 'R7', 'R8')];

describe('coverageProblems', () => {
  it('names the one requirement no unit covers', () => {
    expect(coverageProblems(nine, coveringEight)).toEqual(['R9 is not covered: requirement 9']);
  });

  it('gives no problem when every requirement is covered', () => {
    expect(coverageProblems(nine, [...coveringEight, unit('third', 'R9')])).toEqual([]);
  });

  it('names an id that is no requirement with the item that names it', () => {
    const units = [...coveringEight, unit('third', 'R9', 'R12')];
    expect(coverageProblems(nine, units)).toEqual(['R12 is not a requirement: third']);
  });
});

describe('coverageOf', () => {
  it('lists the covering items per id and none for an uncovered one', () => {
    const covered = coverageOf(nine, [...coveringEight, unit('third', 'R1')]);
    expect(covered[0]).toEqual({ id: 'R1', text: 'requirement 1', items: ['first', 'third'] });
    expect(covered[8]).toEqual({ id: 'R9', text: 'requirement 9', items: [] });
  });
});

describe('mergeRequirements', () => {
  it('adds the next id after the last one', () => {
    const result = mergeRequirements(nine, [{ id: 'R10', text: 'new' }]);
    expect(result.problems).toEqual([]);
    expect(result.list).toHaveLength(10);
    expect(result.list[9]).toEqual({ id: 'R10', text: 'new' });
  });

  it('corrects the text of an id and keeps every id it was not given', () => {
    const result = mergeRequirements(nine, [{ id: 'R3', text: 'better' }]);
    expect(result.problems).toEqual([]);
    expect(result.list.map((item) => item.id)).toEqual(nine.map((item) => item.id));
    expect(result.list[2]?.text).toBe('better');
    expect(result.list[3]).toEqual(nine[3]);
  });

  it('rejects an id that skips ahead and an empty text, and changes nothing', () => {
    const result = mergeRequirements(nine, [
      { id: 'R12', text: 'skipped' },
      { id: 'R2', text: '  ' },
    ]);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain('R12');
    expect(result.problems[1]).toContain('R2');
    expect(result.list).toEqual(nine);
  });

  it('numbers a list that holds T1 in the T series', () => {
    const list = [
      { id: 'R2', text: 'two' },
      { id: 'R5', text: 'five' },
      { id: 'T1', text: 'task' },
    ];
    expect(mergeRequirements(list, [{ id: 'T2', text: 'more' }]).list.at(-1)).toEqual({ id: 'T2', text: 'more' });
    expect(mergeRequirements(list, [{ id: 'R6', text: 'six' }]).problems).toHaveLength(1);
  });
});
