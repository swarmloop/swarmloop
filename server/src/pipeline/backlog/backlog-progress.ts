import { milestoneWorkDone } from '../../contract/milestone-work';
import { settled } from '../../contract/subtask';
import type { BacklogTaskRecord } from '../../history/backlog.repository';
import type { MilestoneStatus, RequirementStatus } from '../../contract/backlog';

interface RequirementFacts {
  ref: string;
  milestoneId: number;
  status: RequirementStatus;
}

interface MilestoneFacts {
  id?: number;
  number: number;
  status: MilestoneStatus;
}

/** What the tasks' merges bring: the requirements that become ready (and so close) and the active milestones whose work is done. */
interface Progress {
  requirements: string[];
  milestones: number[];
}

/**
 * A requirement is ready when at least one task covers it, every covering task is merged or skipped, and at least one is merged;
 * one that no task covers never is. A milestone is ready when it is active and its work is done (`milestoneWorkDone`) once these writes count:
 * every task of it merged or skipped and every requirement of it closed; one with no tasks and no requirements never is.
 */
export function backlogProgress(
  requirements: RequirementFacts[],
  milestones: MilestoneFacts[],
  tasks: Pick<BacklogTaskRecord, 'covers' | 'status' | 'milestoneId'>[],
): Progress {
  const ready = requirements.filter((requirement) => {
    if (requirement.status === 'closed') return false;
    const covering = tasks.filter((task) => task.covers.includes(requirement.ref));
    const finished = covering.every(settled);
    return covering.length > 0 && finished && covering.some((task) => task.status === 'merged');
  });
  const closing = new Set(ready.map((requirement) => requirement.ref));
  const done = milestones.filter((milestone) => {
    const own = requirements
      .filter((requirement) => requirement.milestoneId === milestone.id)
      .map((requirement) => (closing.has(requirement.ref) ? { status: 'closed' as const } : requirement));
    return (
      milestone.status === 'active' &&
      milestoneWorkDone(
        tasks.filter((task) => task.milestoneId === milestone.id),
        own,
      )
    );
  });
  return {
    requirements: ready.map(({ ref }) => ref),
    milestones: done.map((milestone) => milestone.number),
  };
}
