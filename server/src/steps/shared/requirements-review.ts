import type { ReviewResult } from '../../agent-result/definitions/review';
import type { DocumentRepository } from '../../history/document.repository';
import { reviewResultOf } from '../contract/artifacts';

/** The latest stored result of the requirements review of a run, with the id of the document that holds it. */
export async function latestRequirementsReview(
  documents: DocumentRepository,
  key: string,
): Promise<{ id: number; result: ReviewResult } | null> {
  const artifact = reviewResultOf('requirements');
  const latest = await documents.latestDocument(key, artifact.kind);
  return latest ? { id: latest.id, result: artifact.parse(latest.body) } : null;
}
