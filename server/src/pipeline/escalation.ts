import type { PlanChatEntry } from '../contract/plan-chat';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { renderQuestions } from '../steps/research/research-record';
import { openQuestions } from '../steps/shared/answers';
import { askedParts, readStoredQuestions } from '../steps/shared/question-parts';

/** The question for the person that a planner's escalation makes: one line, built the same way to write and to match. */
export function escalationLine(escalation: PlanChatEntry): string {
  const step = (escalation.from ?? 'a step').replace(/-/g, ' ');
  const text = escalation.text.trim().replace(/\s*\n\s*/g, ' ');
  return `${step} asks: ${text} (asked ${escalation.at})`;
}

/** Puts the escalated question into the run's `questions` document with its parts, so the run waits for the person. */
export async function escalateToPerson(
  documents: DocumentRepository,
  run: RunEntity,
  escalation: PlanChatEntry,
): Promise<void> {
  const line = escalationLine(escalation);
  const open = await openLines(documents, run);
  if (open.includes(line)) return;
  const parts = {
    question: line,
    parts: askedParts(escalation.text, escalation.at, { asker: escalation.from, entry: escalation.key }),
  };
  const stored = readStoredQuestions((await documents.latestBody(run.key, ARTIFACTS.questionParts.kind)) ?? '');
  const lines = [...open, line];
  await documents.putDocument(run, ARTIFACTS.questions.kind, renderQuestions(lines));
  await documents.putDocument(
    run,
    ARTIFACTS.questionParts.kind,
    ARTIFACTS.questionParts.format([...stored.filter((item) => item.question !== line), parts]),
  );
}

/** Takes the escalated question out of the open questions once the planner read the person's answer. */
export async function closeEscalation(
  documents: DocumentRepository,
  run: RunEntity,
  escalation: PlanChatEntry,
): Promise<void> {
  const line = escalationLine(escalation);
  const open = await openLines(documents, run);
  if (!open.includes(line)) return;
  const lines = open.filter((item) => item !== line);
  const stored = readStoredQuestions((await documents.latestBody(run.key, ARTIFACTS.questionParts.kind)) ?? '');
  await documents.putDocument(run, ARTIFACTS.questions.kind, renderQuestions(lines));
  await documents.putDocument(
    run,
    ARTIFACTS.questionParts.kind,
    ARTIFACTS.questionParts.format(stored.filter((item) => item.question !== line)),
  );
}

async function openLines(documents: DocumentRepository, run: RunEntity): Promise<string[]> {
  return openQuestions((await documents.latestBody(run.key, ARTIFACTS.questions.kind)) ?? '', []);
}
