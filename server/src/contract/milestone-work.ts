import type { BacklogView, RequirementStatus } from './backlog';
import { settled, type Subtask } from './subtask';

/** A milestone's work is done when it has work, every task is settled and every requirement is closed. */
export function milestoneWorkDone(
  tasks: Pick<Subtask, 'status'>[],
  requirements: { status: RequirementStatus }[],
): boolean {
  return (
    tasks.length + requirements.length > 0 &&
    tasks.every(settled) &&
    requirements.every((requirement) => requirement.status === 'closed')
  );
}

/** How much of one milestone's work is settled, and whether all of it is. */
export function milestoneWork(view: BacklogView, number: number): { settled: number; total: number; done: boolean } {
  const tasks = view.tasks.filter((task) => task.milestone === number);
  const requirements = view.requirements.filter((requirement) => requirement.milestone === number);
  return { settled: tasks.filter(settled).length, total: tasks.length, done: milestoneWorkDone(tasks, requirements) };
}
