import { describe, expect, it } from 'vitest';
import { backlogView, milestone } from '../../test/backlog-fixtures';
import { progressLine } from './progress-line';

describe('progressLine', () => {
  it('counts the closed requirements of the active milestone', () => {
    expect(progressLine(backlogView())).toBe('M3 · 4/7');
  });

  it('gives no line when no milestone is active', () => {
    expect(progressLine(backlogView({ milestones: [milestone({ status: 'proposed' })] }))).toBe('');
  });
});
