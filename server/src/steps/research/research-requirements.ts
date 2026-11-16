import type { Requirement } from '../../contract/requirement-list';
import type { Subtask } from '../../contract/subtask';
import { mergeRequirements } from '../shared/requirement-coverage';

/** What decides the requirement list a research pass writes. */
interface RequirementSources {
  stored: Requirement[] | null;
  answered: Requirement[] | undefined;
  parentList: Requirement[] | null;
  parentTasks: Subtask[];
  taskId: string | null | undefined;
  subtask: boolean;
}

/** The task's own entry: its id never clashes with the parent's. */
const OWN_ID = 'T1';

/** The parent's requirements a task covers, with the parent's ids and texts, plus the task's own description. */
function subtaskList(parentList: Requirement[], task: Subtask): Requirement[] {
  const covers = task.covers ?? [];
  return [
    ...parentList.filter((requirement) => covers.includes(requirement.id)),
    { id: OWN_ID, text: task.description },
  ];
}

/**
 * The list research writes, or null when it writes none. A run that is not a subtask takes the answer's list, merged into
 * the stored one on a rerun. A subtask keeps its stored list, or is given the parent's entries its task covers.
 */
export function requirementsToWrite(sources: RequirementSources): Requirement[] | null {
  const { stored, answered, parentList, parentTasks, taskId, subtask } = sources;
  if (!subtask) {
    return stored && answered ? mergeRequirements(stored, answered).list : (stored ?? answered ?? null);
  }
  const task = parentTasks.find((candidate) => candidate.id === taskId);
  return stored ?? (parentList && task ? subtaskList(parentList, task) : null);
}

/** What is wrong with the list an answer sends on a rerun, for the agent to fix; none when nothing is stored. */
export function requirementErrors(stored: Requirement[] | null, answered: Requirement[] | undefined): string[] {
  return stored && answered ? mergeRequirements(stored, answered).problems : [];
}
