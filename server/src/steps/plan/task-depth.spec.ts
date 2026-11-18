import { splitFacts, taskDepth } from './task-depth';

const task = (id: string, depends: string[] = []) => ({ id, depends });
const firstAndThree = [task('first'), task('a', ['first']), task('b', ['first']), task('c', ['first'])];

describe('taskDepth', () => {
  it('is 0 for no tasks and 1 for one task', () => {
    expect(taskDepth([])).toBe(0);
    expect(taskDepth([task('a')])).toBe(1);
  });

  it('counts a first task and tasks side by side as 2', () => {
    expect(taskDepth(firstAndThree)).toBe(2);
  });

  it('counts a chain of five as 5', () => {
    const chain = [task('a'), task('b', ['a']), task('c', ['b']), task('d', ['c']), task('e', ['d'])];
    expect(taskDepth(chain)).toBe(5);
  });

  it('takes the longest chain and ignores ids that are not in the list', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['a', 'b', 'gone'])];
    expect(taskDepth(tasks)).toBe(3);
  });
});

describe('splitFacts', () => {
  it('names the count and the depth', () => {
    expect(splitFacts(firstAndThree)).toEqual({ details: ['4 tasks · depth 2'] });
  });
});
