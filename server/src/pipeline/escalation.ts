import type { PlanChatEntry } from '../contract/plan-chat';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { renderQuestions } from '../steps/research/research-record';
import { openQuestions } from '../steps/shared/answers';
import type { QuestionHolds } from '../steps/shared/question-holds';
import { askPerson, type PersonAsk } from '../steps/shared/person-questions';
import { askedParts, readAnsweredQuestions, readStoredQuestions } from '../steps/shared/question-parts';

/** The question for the person that a planner's escalation makes: one line, built the same way to write and to match. */
export function escalationLine(escalation: PlanChatEntry): string {
  const step = (escalation.from ?? 'a step').replace(/-/g, ' ');
  const text = escalation.text.trim().replace(/\s*\n\s*/g, ' ');
  return `${step} asks: ${text} (asked ${escalation.at})`;
}

/** True when the escalated question is among the run's open questions. */
export async function isAsked(
  documents: DocumentRepository,
  run: RunEntity,
  escalation: PlanChatEntry,
): Promise<boolean> {
  return (await openLines(documents, run)).includes(escalationLine(escalation));
}

/**
 * Puts the escalated question into the run's `questions` document with its parts, so the run waits for the person.
 * A question the person answered before is not put again: the stored answer is returned and nothing is written.
 */
export async function escalateToPerson(
  documents: DocumentRepository,
  run: RunEntity,
  escalation: PlanChatEntry,
): Promise<PersonAsk> {
  const ask = {
    question: escalationLine(escalation),
    parts: askedParts(escalation.text, escalation.at, { asker: escalation.from, entry: escalation.key }),
  };
  const held = {
    lines: await openLines(documents, run),
    parts: readStoredQuestions((await documents.latestBody(run.key, ARTIFACTS.questionParts.kind)) ?? ''),
    answered: readAnsweredQuestions((await documents.latestBody(run.key, ARTIFACTS.answeredQuestions.kind)) ?? ''),
  };
  const result = askPerson(held, ask);
  if (result.kind === 'asked' && result.lines.length !== held.lines.length) {
    await documents.putDocument(run, ARTIFACTS.questions.kind, renderQuestions(result.lines));
    await documents.putDocument(run, ARTIFACTS.questionParts.kind, ARTIFACTS.questionParts.format(result.parts));
  }
  return result;
}

/**
 * Releases the run that waits for an escalated question. The run waits for the person, except that a question of a
 * backlog's run which the backlog's planner has not passed on keeps the run waiting for the planner.
 */
export async function releaseAsked(runs: RunRepository, holds: QuestionHolds | undefined, key: string): Promise<void> {
  const fresh = await runs.findRun(key);
  if (fresh?.status !== 'waiting') return;
  const found = holds ? await holds.facts(fresh) : null;
  const known = found && (found.needsAnswers || found.asksPlanner);
  const facts = known ? { needsAnswers: found.needsAnswers, asksPlanner: found.asksPlanner } : { needsAnswers: true };
  await runs.release(fresh, { status: 'waiting', facts });
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
