import { settled, withStatuses } from '../../contract/subtask';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputReader } from '../contract/input-reader';
import { openQuestions } from '../shared/answers';
import type { SubtaskOps } from '../shared/subtask-ops';
import { returnedNotes } from '../shared/handoff';
import { gapOf, gapTaken } from './review-gaps';

/**
 * Who runs the implement of a run now: the `agent` (an unsplit run; a split run with a parked conflict of its own
 * branch, whatever the state of its tasks; a return from the round that checks the resolution of such a conflict; or a
 * split run whose tasks are all settled and whose defect return the agent fixes on the merged branch), or the `split`
 * pass, which is the server's own work over the subtasks and launches no agent.
 */
export async function implementRunner(
  reader: InputReader,
  documents: DocumentRepository,
  subtasks: Pick<SubtaskOps, 'settledAt'>,
  run: RunEntity | null,
): Promise<'agent' | 'split'> {
  const tasks = run?.split ? await reader.reread(run.key, ARTIFACTS.subtasks) : null;
  if (!run || !tasks?.length) return 'agent';
  const { key } = run;
  const marker = ((await reader.reread(key, ARTIFACTS.rebaseConflict)) ?? '').trim();
  const taken = JSON.parse((await reader.reread(key, ARTIFACTS.starterTaken)) || '[]') as string[];
  const gap = await gapOf(documents, subtasks, run, tasks, taken);
  const settledAll = withStatuses(tasks).every(settled);
  const closed = settledAll && (await gapTaken(documents, run, taken));
  const asking = openQuestions((await reader.reread(key, ARTIFACTS.subtaskQuestions)) ?? '', []).length > 0;
  if (marker.startsWith('pending')) return 'agent';
  const notes = !!(await returnedNotes(documents, run.id));
  const round = ((await reader.reread(key, ARTIFACTS.epicRound)) ?? '').trim() === 'open';
  const fixing = notes && (round || (settledAll && !gap && !closed && !asking));
  return fixing ? 'agent' : 'split';
}
