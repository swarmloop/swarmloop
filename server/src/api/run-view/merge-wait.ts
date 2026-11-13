import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { DocumentRepository } from '../../history/document.repository';
import { parseSubtasks, SUBTASKS_KIND, type Subtask } from '../../contract/subtask';

/** What a done subtask waits for before its parent merges it: the note of its task in the parent's task list. Empty once it is merged. */
async function mergeWait(
  documents: DocumentRepository,
  run: RunEntity,
  parentKey: string,
  parsed: Map<string, Subtask[]> = new Map(),
): Promise<{ mergeWait?: string }> {
  if (run.status !== 'done' || run.mergeOutcome || !run.taskId) {
    return {};
  }
  if (!parsed.has(parentKey)) {
    parsed.set(parentKey, parseSubtasks(await documents.latestBody(parentKey, SUBTASKS_KIND)));
  }
  const note = parsed.get(parentKey)?.find((task) => task.id === run.taskId)?.note;
  return note ? { mergeWait: note } : {};
}

/** The wait of every done subtask in `runs`, by run key. `keys` names each run by id. */
export async function mergeWaits(
  documents: DocumentRepository,
  runs: RunEntity[],
  keys: Map<number, string>,
): Promise<Map<string, { mergeWait: string }>> {
  const waits = new Map<string, { mergeWait: string }>();
  const parsed = new Map<string, Subtask[]>();
  for (const run of runs) {
    const parentKey = typeof run.parentRunId === 'number' ? keys.get(run.parentRunId) : undefined;
    const wait = parentKey ? await mergeWait(documents, run, parentKey, parsed) : {};
    if (wait.mergeWait) waits.set(run.key, { mergeWait: wait.mergeWait });
  }
  return waits;
}

/** The parent link of a subtask, with what its merge waits for. Empty for a run with no parent. */
export async function parentOf(
  runs: RunRepository,
  documents: DocumentRepository,
  run: RunEntity,
): Promise<{ parentKey?: string; mergeWait?: string }> {
  const parent = typeof run.parentRunId === 'number' ? await runs.findById(run.parentRunId) : null;
  return parent ? { parentKey: parent.key, ...(await mergeWait(documents, run, parent.key)) } : {};
}
