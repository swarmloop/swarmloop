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

/** What the tasks' merges bring: the requirements that become ready (and so close) and the active milestones whose requirements are all closed. */
interface Progress {
  requirements: string[];
  milestones: number[];
}

/**
 * A requirement is ready when at least one task covers it, every covering task is merged or skipped, and at least one is merged;
 * one that no task covers never is. A milestone is ready when it is active, has requirements and all of them are closed once these writes count.
 */
export function backlogProgress(
  requirements: RequirementFacts[],
  milestones: MilestoneFacts[],
  tasks: Pick<BacklogTaskRecord, 'covers' | 'status'>[],
): Progress {
  const ready = requirements.filter((requirement) => {
    if (requirement.status === 'closed') return false;
    const covering = tasks.filter((task) => task.covers.includes(requirement.ref));
    const finished = covering.every(settled);
    return covering.length > 0 && finished && covering.some((task) => task.status === 'merged');
  });
  const closing = new Set(ready.map((requirement) => requirement.ref));
  const done = milestones.filter((milestone) => {
    const own = requirements.filter((requirement) => requirement.milestoneId === milestone.id);
    return (
      milestone.status === 'active' &&
      own.length > 0 &&
      own.every((requirement) => requirement.status === 'closed' || closing.has(requirement.ref))
    );
  });
  return {
    requirements: ready.map(({ ref }) => ref),
    milestones: done.map((milestone) => milestone.number),
  };
}
