import type { DocumentRepository } from '../../history/document.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { DocumentDraft } from '../../history/visit';
import { ARTIFACTS } from '../contract/artifacts';
import { textDocument } from './handoff';

/** A failed visit keeps all validation errors with that visit, for the next launch of that agent. */
export function answerErrorsDocument(errors: string[]): DocumentDraft {
  return { ...textDocument(ARTIFACTS.answerErrors.kind, ARTIFACTS.answerErrors.format(errors)), perVisit: true };
}

/** The errors stored with each visit of the run as its answer-errors document, by the visit's stat id. */
export async function answerErrorsByVisit(
  deps: { documents: DocumentRepository },
  runId: number,
): Promise<Map<number, string[]>> {
  const byVisit = new Map<number, string[]>();
  for (const document of await deps.documents.listDocuments(runId)) {
    if (document.kind === ARTIFACTS.answerErrors.kind) {
      byVisit.set(document.stepStatId, ARTIFACTS.answerErrors.parse(document.body));
    }
  }
  return byVisit;
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
  return (await answerErrorsByVisit(deps, runId)).get(last.id);
}
