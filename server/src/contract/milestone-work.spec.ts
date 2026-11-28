import type { BacklogView, RequirementStatus } from './backlog';
import { milestoneWork, milestoneWorkDone } from './milestone-work';
import type { SubtaskStatus } from './subtask';

const tasks = (...statuses: SubtaskStatus[]) => statuses.map((status) => ({ status }));
const requirements = (...statuses: RequirementStatus[]) => statuses.map((status) => ({ status }));

describe('milestoneWorkDone', () => {
  it('is true when every task is merged', () => {
    expect(milestoneWorkDone(tasks('merged', 'merged'), [])).toBe(true);
  });

  it('counts a skipped task as settled', () => {
    expect(milestoneWorkDone(tasks('merged', 'skipped', 'merged'), [])).toBe(true);
  });

  it('is false while a task runs', () => {
    expect(milestoneWorkDone(tasks('merged', 'running'), [])).toBe(false);
  });

  it('is false while a requirement is open or ready', () => {
    expect(milestoneWorkDone(tasks('merged'), requirements('closed', 'open'))).toBe(false);
    expect(milestoneWorkDone(tasks('merged'), requirements('ready'))).toBe(false);
  });

  it('is true when settled tasks meet closed requirements', () => {
    expect(milestoneWorkDone(tasks('merged'), requirements('closed'))).toBe(true);
  });

  it('is false for a milestone with no tasks and no requirements', () => {
    expect(milestoneWorkDone([], [])).toBe(false);
  });
});

describe('milestoneWork', () => {
  it('counts settled over total for the one milestone only, skipped included', () => {
    const view = {
      tasks: [
        { milestone: 1, status: 'merged' },
        { milestone: 1, status: 'skipped' },
        { milestone: 1, status: 'running' },
        { milestone: 2, status: 'merged' },
      ],
      requirements: [
        { milestone: 1, status: 'closed' },
        { milestone: 2, status: 'open' },
      ],
    } as unknown as BacklogView;
    expect(milestoneWork(view, 1)).toEqual({ settled: 2, total: 3, done: false });
    expect(milestoneWork(view, 2)).toEqual({ settled: 1, total: 1, done: false });
  });

  it('is done when the milestone has all its work settled and closed', () => {
    const view = {
      tasks: [{ milestone: 1, status: 'skipped' }],
      requirements: [{ milestone: 1, status: 'closed' }],
    } as unknown as BacklogView;
    expect(milestoneWork(view, 1)).toEqual({ settled: 1, total: 1, done: true });
  });
});
