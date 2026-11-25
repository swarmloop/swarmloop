import { parseSubtasks, settled, SUBTASKS_KIND } from '../../contract/subtask';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';

/** The ISO time a task of the parent was merged or skipped, or null when it is not settled or the time is not known. */
export async function settledAt(
  runs: Pick<RunRepository, 'findSubtask'>,
  documents: DocumentRepository,
  parent: RunEntity,
  taskId: string,
): Promise<string | null> {
  const task = parseSubtasks(await documents.latestBody(parent.key, SUBTASKS_KIND)).find((item) => item.id === taskId);
  if (!task || !settled(task)) return null;
  if (task.status === 'merged') return (await runs.findSubtask(parent, taskId))?.doneAt ?? null;
  // A skipped task has no run to say when: the first list that holds it as skipped does.
  const lists = await documents.revisionsOfKind(parent.id, SUBTASKS_KIND);
  const first = lists.find((item) => parseSubtasks(item.body).some((t) => t.id === taskId && t.status === 'skipped'));
  return first?.createdAt ?? null;
}
