import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { PlanChatStore } from '../history/plan-chat.store';
import { latest } from '../history/latest-document';
import { answered, renderAnswers } from '../steps/shared/answers';
import { OPEN_ITEM_KINDS, openItems } from '../steps/shared/open-items';

/** What closing the questions of a skipped run reads and writes. */
export interface SkippedQuestionDeps {
  documents: DocumentRepository;
  chat: PlanChatStore;
}

/**
 * Closes every open question of a run a skip ends, with the skip's `reason` as its answer: the questions its run page
 * lists, and the planner's questions and escalations of its plan chat, raised or not. Answers already given are kept.
 * Nothing is written when nothing is open.
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
