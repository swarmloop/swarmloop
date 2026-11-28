import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { FlowItem } from '../../contract/api';
import { jiraIssueKey } from '../../integrations/issue-tracker/jira/jira-url';
import { answered, openQuestions } from './answers';
import { readStoredQuestions } from './question-parts';
import { withoutSkipped } from './subtask-question-line';
import { parseSubtasks, SUBTASKS_KIND } from '../../contract/subtask';
import { research } from '../../agent-result/definitions/research';
import { storedResult } from '../../agent-result/stored-result';
import type { ResearchResult } from '../../agent-result/definitions/research';
import { plan, type PlanResult } from '../../agent-result/definitions/plan';
import { latest } from '../../history/latest-document';

/** The open questions of one kind of document, each with the answer the person already gave. */
function questionItems(
  documents: DocumentEntity[],
  kind: string,
  results: Parameters<typeof openQuestions>[1],
  /** The step whose document the questions were read from; it asks a question that has no stored parts. */
  asker: string,
  /** Only the questions the server stored parts for: the others are old questions of an earlier step. */
  withParts = false,
): FlowItem[] {
  const stored = answered(latest(documents, 'answers') ?? '');
  const parts = readStoredQuestions(latest(documents, 'question_parts') ?? '');
  const askedAt = [...documents].reverse().find((document) => document.kind === kind)?.createdAt ?? '';
  return openQuestions(latest(documents, kind) ?? '', results).flatMap((question) => {
    const found = parts.find((item) => item.question === question);
    if (withParts && !found) return [];
    // Parts of a question without stored ones exist in the item only, never stored.
    const shown = found?.parts ?? { decide: question, sides: [], full: '', askedAt, asker };
    return {
      kind: 'question',
      id: question,
      label: question,
      answer: stored.get(question) ?? '',
      parts: shown,
    };
  });
}

function pasteItems(documents: DocumentEntity[], pasteUrls: string[]): FlowItem[] {
  const pending = pendingUrl(latest(documents, 'pending'));
  return pending && !pasteUrls.includes(pending) && !jiraIssueKey(pending)
    ? [{ kind: 'paste', id: pending, label: pending, answer: '' }]
    : [];
}

/** The kinds of document `openItems` reads: its latest of each is all it needs. */
export const OPEN_ITEM_KINDS = [
  'questions',
  'answers',
  'question_parts',
  'subtask_questions',
  SUBTASKS_KIND,
  'review_questions',
  'pending',
  'passed_on',
  research.kind,
  plan.kind,
];

export function openItems(run: RunEntity, documents: DocumentEntity[], pasteUrls: string[]): FlowItem[] {
  const itemsOut: FlowItem[] = [];
  if (run.currentStep === 'research' || run.currentStep === 'plan') {
    itemsOut.push(
      ...questionItems(
        documents,
        'questions',
        [storedResult<ResearchResult>(research, documents), storedResult<PlanResult>(plan, documents)],
        run.currentStep,
      ),
    );
  } else {
    // A question the planner escalated to the person who started the run waits in the questions at the step the run is at.
    itemsOut.push(...questionItems(documents, 'questions', [], run.currentStep, true));
  }
  if (run.split && run.currentStep === 'implement') {
    // A question of a skipped task is asked of no one.
    const items = questionItems(documents, 'subtask_questions', [], run.currentStep);
    const asked = new Set(
      withoutSkipped(
        items.map((item) => item.id),
        parseSubtasks(latest(documents, SUBTASKS_KIND) ?? ''),
      ),
    );
    itemsOut.push(...items.filter((item) => asked.has(item.id)));
  }
  if (run.currentStep === 'code-review') {
    itemsOut.push(...questionItems(documents, 'review_questions', [], run.currentStep));
  }
  if (run.currentStep === 'requirements') {
    itemsOut.push(...pasteItems(documents, pasteUrls));
  }
  return itemsOut;
}

function pendingUrl(body: string | null): string | null {
  if (!body?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { url?: unknown };
    return typeof parsed.url === 'string' && parsed.url ? parsed.url : null;
  } catch {
    return null;
  }
}
