import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunRepository } from '../history/run.repository';
import { latest } from '../history/latest-document';
import { answered, openQuestions, renderAnswers } from '../steps/shared/answers';
import { questionTask } from '../steps/shared/subtask-question-line';
import { OPEN_ITEM_KINDS, openItems } from '../steps/shared/open-items';

/** What closing the questions of a skipped run reads and writes. */
export interface SkippedQuestionDeps {
  documents: DocumentRepository;
  chat: PlanChatStore;
}

/** What closing the questions its epic holds for a skipped run reads and writes. */
interface EpicQuestionDeps {
  documents: DocumentRepository;
  runs: Pick<RunRepository, 'findById'>;
}

/**
 * Closes every open question of a run a skip ends, with the skip's `reason` as its answer: the questions its run page
 * lists, and the planner's questions and escalations of its plan chat, raised or not. Answers already given are kept.
 * Nothing is written when nothing is open. The questions its epic holds for it are `closeEpicQuestions`.
 */
export async function closeSkippedQuestions(
  { documents, chat }: SkippedQuestionDeps,
  run: RunEntity,
  reason: string,
): Promise<void> {
  const stored = await documents.latestDocuments([run.id], [...OPEN_ITEM_KINDS]);
  const open = openItems(run, stored, []).filter((item) => item.kind === 'question' && !item.answer.trim());
  if (open.length > 0) {
    const kept = [...answered(latest(stored, 'answers') ?? '')].filter(([, answer]) => answer.trim());
    const closed = open.map((item): [string, string] => [item.id, reason]);
    await documents.putDocument(run, 'answers', renderAnswers([...kept, ...closed]));
  }
  const entries = [...(await chat.pendingQuestions(run.key)), ...(await chat.pendingEscalations(run.key))];
  await chat.markTaken(
    run.key,
    entries.map((entry) => entry.key),
    reason,
  );
}

/**
 * Closes the open questions of a skipped subtask run that its epic holds, with the skip's `reason` as their answer: the
 * lines of the epic's `subtask_questions` from that task that have no answer yet. Answers already given are kept.
 * Nothing is written when the run has no epic or nothing is open.
 */
export async function closeEpicQuestions(
  { documents, runs }: EpicQuestionDeps,
  run: RunEntity,
  reason: string,
): Promise<void> {
  const { parentRunId, taskId } = run;
  if (typeof parentRunId !== 'number' || !taskId) return;
  const epic = await runs.findById(parentRunId);
  if (!epic) return;
  const stored = await documents.latestDocuments([epic.id], ['subtask_questions', 'answers']);
  const given = [...answered(latest(stored, 'answers') ?? '')].filter(([, answer]) => answer.trim());
  const open = openQuestions(latest(stored, 'subtask_questions') ?? '', []).filter(
    (line) => questionTask(line) === taskId && !given.some(([question]) => question === line),
  );
  if (open.length === 0) return;
  await documents.putDocument(
    epic,
    'answers',
    renderAnswers([...given, ...open.map((line): [string, string] => [line, reason])]),
  );
}
