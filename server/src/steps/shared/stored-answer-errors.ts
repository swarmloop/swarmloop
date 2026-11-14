import type { DocumentRepository } from '../../history/document.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { DocumentDraft } from '../../history/visit';
import { ARTIFACTS } from '../contract/artifacts';
import { textDocument } from './handoff';

/** A failed visit keeps all validation errors with that visit, for the next launch of that agent. */
export function answerErrorsDocument(errors: string[]): DocumentDraft {
  return { ...textDocument(ARTIFACTS.answerErrors.kind, ARTIFACTS.answerErrors.format(errors)), perVisit: true };
}

/** Errors belong to the latest failed visit of this run and agent; a later successful visit leaves none. */
export async function storedAnswerErrors(
  deps: { documents: DocumentRepository; visits: VisitRepository },
  runId: number,
  step: string,
): Promise<string[] | undefined> {
  const last = (await deps.visits.listStats(runId)).filter((stat) => stat.step === step).at(-1);
  if (last?.status !== 'failed') {
    return undefined;
  }
  const stored = (await deps.documents.listDocuments(runId))
    .filter((document) => document.stepStatId === last.id && document.kind === ARTIFACTS.answerErrors.kind)
    .at(-1);
  return stored ? ARTIFACTS.answerErrors.parse(stored.body) : undefined;
}
