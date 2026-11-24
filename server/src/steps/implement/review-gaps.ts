import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { SubtaskOps } from '../shared/subtask-ops';
import type { Requirement } from '../../contract/requirement-list';
import type { Subtask } from '../../contract/subtask';
import type { RequirementMark } from '../../agent-result/definitions/review';
import type { SplitTask } from '../../agent-result/definitions/split-fields';
import { latestRequirementsReview } from '../shared/requirements-review';
import { newestReturn } from '../shared/handoff';
import { readContract } from '../shared/contract-items';
import type { StoredQuestion } from '../shared/question-parts';
import { askedQuestion } from './split-questions';
import { applyStarterAnswer, type PlanChange } from './starter-actions';

const GAP_PREFIX = 'gap-';

/** The requirements or contract items the final review of a split parent marked partial or missing, and the review that did it. */
interface Gap {
  /** Names the review result that marked the ids, so each review is its own event. */
  key: string;
  marks: RequirementMark[];
}

/** What the parent holds when it turns a gap into a task. */
interface GapState {
  contract: string;
  tasks: Subtask[];
  requirements: Requirement[];
}

/** What taking a gap did: the new contract and task list, the plan changes, and the question for whoever started the run. */
interface TakenGap {
  contract: string;
  tasks: Subtask[];
  changes: PlanChange[];
  asks: StoredQuestion[];
  /** What the parent notes in its taken list for the gap task it added: `<task id>/<id>` for each id. */
  noted: string[];
}

/** The ids the latest final requirements review marked partial or missing in a return, and its key. Null when it marks none. */
async function latestGap(documents: DocumentRepository, runKey: string): Promise<Gap | null> {
  const review = await latestRequirementsReview(documents, runKey);
  if (!review) return null;
  const marks = (review.result.requirements ?? []).filter((mark) => mark.status !== 'met');
  return review.result.decision === 'return' && marks.length > 0 ? { key: `${GAP_PREFIX}${review.id}`, marks } : null;
}

/**
 * True when the latest final requirements review came after every task of the run settled, or when a task's settle
 * time is not known: a task that is done cannot take it, so it is a return for the parent's implement.
 */
async function recordedAfterSettling(
  documents: DocumentRepository,
  subtasks: Pick<SubtaskOps, 'settledAt'>,
  run: RunEntity,
  tasks: Pick<Subtask, 'id'>[],
): Promise<boolean> {
  const review = await latestRequirementsReview(documents, run.key);
  const times = await Promise.all(tasks.map((task) => subtasks.settledAt(run, task.id)));
  if (!review || times.some((time) => time === null)) return true;
  return times.every((time) => time !== null && Date.parse(review.createdAt) > Date.parse(time));
}

/** The gap in the latest final requirements review of the run. Null when it marks none or its key is already taken. */
export async function gapOf(
  documents: DocumentRepository,
  subtasks: Pick<SubtaskOps, 'settledAt'>,
  run: RunEntity,
  tasks: Pick<Subtask, 'id'>[],
  taken: string[],
): Promise<Gap | null> {
  const gap = await latestGap(documents, run.key);
  if (!gap || taken.includes(gap.key) || (await recordedAfterSettling(documents, subtasks, run, tasks))) return null;
  return gap;
}

/** What the parent notes in its taken list with a gap: the return it was taken from, so a later return is not mistaken for it. */
export async function gapReturn(documents: DocumentRepository, runId: number, gap: Gap): Promise<string> {
  return `${gap.key}@return-${await newestReturn(documents, runId)}`;
}

/**
 * True when the run's newest return is still the one of a gap the parent turned into a task: it is not a return for
 * its implement. A failed check or pipeline after that is a new return, and goes to the agent.
 */
export async function gapTaken(
  documents: DocumentRepository,
  run: { id: number; key: string },
  taken: string[],
): Promise<boolean> {
  const gap = await latestGap(documents, run.key);
  return gap !== null && taken.includes(await gapReturn(documents, run.id, gap));
}

const idsOf = (marks: RequirementMark[]): string[] => marks.map((mark) => mark.id);

/** The ids a gap task was added for: the parent notes each one as `<task id>/<id>` in its taken list. */
const gapIdsOf = (task: Subtask, taken: string[]): string[] =>
  taken.filter((entry) => entry.startsWith(`${task.id}/`)).map((entry) => entry.slice(task.id.length + 1));

/** The files of the tasks that were to deliver the ids, or of every task when none is known. */
function filesFor(ids: string[], state: GapState): string[] {
  const owners = new Set(
    readContract(state.contract).items.flatMap((item) => (ids.includes(item.id) ? [item.owner] : [])),
  );
  const own = state.tasks.filter((task) => owners.has(task.id) || (task.covers ?? []).some((id) => ids.includes(id)));
  return [...new Set((own.length > 0 ? own : state.tasks).flatMap((task) => task.files))];
}

function gapTask(gap: Gap, state: GapState): SplitTask {
  const ids = idsOf(gap.marks);
  const known = new Set(state.requirements.map((requirement) => requirement.id));
  const lines = gap.marks.map((mark) => `- ${mark.id} is ${mark.status}: ${mark.note}`);
  const count = state.tasks.filter((task) => task.id.startsWith(GAP_PREFIX)).length;
  return {
    id: `${GAP_PREFIX}${count + 1}`,
    title: `Close the gap in ${ids.join(', ')}`,
    description: [
      `The final requirements review marked these as not delivered:`,
      ...lines,
      `Gap for: ${ids.join(', ')}`,
    ].join('\n'),
    depends: [],
    files: filesFor(ids, state),
    proof: `The requirements review marks ${ids.join(', ')} met`,
    covers: ids.filter((id) => known.has(id)),
  };
}

/**
 * Turns a gap into one task added at the end of the list, through the checks of an added task. An id that a merged gap
 * task was already added for adds no second task: the person who started the run is asked, naming the gap task.
 */
export function takeGap(state: GapState, gap: Gap, taken: string[], at: string): TakenGap {
  const closing = state.tasks.filter((task) => task.status === 'merged' && task.id.startsWith(GAP_PREFIX));
  const repeated = gap.marks.flatMap((mark) => {
    const earlier = closing.find((task) => gapIdsOf(task, taken).includes(mark.id));
    return earlier ? [{ mark, earlier }] : [];
  });
  const ask = (taskId: string, text: string): TakenGap => ({
    ...state,
    changes: [],
    asks: [askedQuestion(taskId, text, at)],
    noted: [],
  });
  if (repeated.length > 0) {
    const text = repeated
      .map(
        ({ mark, earlier }) => `${mark.id} is still ${mark.status} after gap task ${earlier.id} merged: ${mark.note}`,
      )
      .join('; ');
    return ask(repeated[0].earlier.id, text);
  }
  const task = gapTask(gap, state);
  const ids = idsOf(gap.marks).join(', ');
  const decision = `The final requirements review marked ${ids} partial or missing: task ${task.id} delivers them.`;
  const applied = applyStarterAnswer({ ...state, asker: task.id }, { decision, addTask: [task] }, at);
  if (applied.errors.length > 0) {
    return ask(task.id, `${ids} is not delivered and its gap task was refused: ${applied.errors.join('; ')}`);
  }
  const reason = `The final requirements review marked ${ids} partial or missing`;
  return {
    contract: applied.contract,
    tasks: applied.tasks,
    changes: applied.changes.map((change) => ({ ...change, reason })),
    asks: [],
    noted: idsOf(gap.marks).map((id) => `${task.id}/${id}`),
  };
}
