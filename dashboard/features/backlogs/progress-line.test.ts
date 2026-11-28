import { describe, expect, it } from 'vitest';
import { backlogView, milestone, task } from '../../test/backlog-fixtures';
import { progressLine } from './progress-line';

describe('progressLine', () => {
  it('counts the merged and skipped tasks of the active milestone over all its tasks', () => {
    const tasks = [
      task({ slug: 'a', status: 'merged' }),
      task({ slug: 'b', status: 'skipped' }),
      task({ slug: 'c', status: 'running' }),
      task({ slug: 'd', status: 'merged', milestone: 4 }),
    ];
    expect(progressLine(backlogView({ tasks }))).toBe('M3 · 2/3');
  });

  it('reads all done when every task is merged or skipped', () => {
    const tasks = [task({ slug: 'a', status: 'merged' }), task({ slug: 'b', status: 'skipped' })];
    expect(progressLine(backlogView({ tasks }))).toBe('M3 · 2/2');
  });

  it('gives no line when no milestone is active', () => {
    expect(progressLine(backlogView({ milestones: [milestone({ status: 'proposed' })] }))).toBe('');
  });
});
