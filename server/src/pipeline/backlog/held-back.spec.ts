import type { Subtask } from '../../contract/subtask';
import { heldBack } from './held-back';

function task(id: string, depends: string[] = [], status: Subtask['status'] = 'waiting') {
  return { id, depends, status };
}

describe('heldBack', () => {
  it('names the tasks that depend on a task directly and through other tasks, in plan order', () => {
    const tasks = [task('a'), task('c', ['b']), task('b', ['a']), task('d', ['x'])];
    expect(heldBack('a', tasks)).toEqual(['c', 'b']);
  });

  it('leaves out merged and skipped tasks but still follows through them', () => {
    const tasks = [task('a'), task('b', ['a'], 'merged'), task('c', ['b']), task('d', ['a'], 'skipped')];
    expect(heldBack('a', tasks)).toEqual(['c']);
  });

  it('does not loop on a cycle and never names the task itself', () => {
    const tasks = [task('a', ['b']), task('b', ['a'])];
    expect(heldBack('a', tasks)).toEqual(['b']);
  });

  it('names nothing for a task that nothing depends on', () => {
    expect(heldBack('a', [task('a'), task('b')])).toEqual([]);
  });
});
