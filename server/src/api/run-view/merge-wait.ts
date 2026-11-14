import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { DocumentRepository } from '../../history/document.repository';
import { parseSubtasks, SUBTASKS_KIND, type Subtask } from '../../contract/subtask';

/** Whether a run is a done subtask that its parent has not merged yet, the only run with something to wait for. */
function awaitsMerge(run: RunEntity): boolean {
  return run.status === 'done' && !run.mergeOutcome && Boolean(run.taskId);
}

/** What the run's task in the parent's plan says its merge waits for. Empty when the note is empty. */
function noteOf(run: RunEntity, plan: Subtask[]): { mergeWait?: string } {
  const note = plan.find((task) => task.id === run.taskId)?.note;
  return note ? { mergeWait: note } : {};
}

/** What a done subtask waits for before its parent merges it: the note of its task in the parent's task list. Empty once it is merged. */
async function mergeWait(
  documents: DocumentRepository,
  run: RunEntity,
  parentKey: string,
): Promise<{ mergeWait?: string }> {
  if (!awaitsMerge(run)) {
    return {};
  }
  return noteOf(run, parseSubtasks(await documents.latestBody(parentKey, SUBTASKS_KIND)));
}

/** The wait of every done subtask in `runs`, by run key. `keys` names each run by id, `plans` holds each parent's tasks by its key. */
export function mergeWaits(
  plans: Map<string, Subtask[]>,
  runs: RunEntity[],
  keys: Map<number, string>,
): Map<string, { mergeWait: string }> {
  const waits = new Map<string, { mergeWait: string }>();
  for (const run of runs) {
    const parentKey = typeof run.parentRunId === 'number' ? keys.get(run.parentRunId) : undefined;
    const plan = parentKey ? plans.get(parentKey) : undefined;
    const wait = plan && awaitsMerge(run) ? noteOf(run, plan) : {};
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
