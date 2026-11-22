import { parseSubtasks, SUBTASKS_KIND } from '../contract/subtask';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { EPIC_CLOSED_NOTE, skippedByEpic } from '../steps/shared/subtask-skip-reason';
import type { SubtaskOps } from '../steps/shared/subtask-ops';

/**
 * Closes every subtask of an epic that merged or closed which is not done: a waiting or failed run, a run its epic
 * marked skipped, or a skipped run whose workspace is still there. A subtask that ended keeps its outcome, and a closed
 * and freed one is left alone, so a second pass changes nothing.
 */
export class EpicLeftovers {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly subtasks: SubtaskOps,
  ) {}

  async run(): Promise<void> {
    for (const epic of await this.runs.listRuns({ split: true, status: 'done' })) {
      const epicState = storedState(epic).state;
      if (epicState !== 'merged' && epicState !== 'closed') continue;
      const children = await this.runs.children(epic);
      if (children.length === 0) continue;
      const tasks = parseSubtasks(await this.documents.latestBody(epic.key, SUBTASKS_KIND));
      for (const child of children) {
        const task = tasks.find((item) => item.id === child.taskId);
        if (this.leftAlone(child, task?.status)) continue;
        const reason =
          epicState === 'closed' ? EPIC_CLOSED_NOTE : skippedByEpic(task?.status === 'skipped' ? task.note : undefined);
        await this.subtasks.closeSkipped(epic, child, reason);
      }
    }
  }

  private leftAlone(child: RunEntity, taskStatus: string | undefined): boolean {
    const { state } = storedState(child);
    if (state === 'merged' || state === 'closed') return true;
    if (state === 'done') return taskStatus !== 'skipped';
    return state === 'skipped' && child.workspace === 'removed';
  }
}
