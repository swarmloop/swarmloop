import type { DocumentRepository } from '../history/document.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { parseMergeRequestSummaries } from '../steps/merge-request/merge-request-record';

/** The merge request text of a task's run. A run with no readable document has none. */
export async function mergeSummaryOf(documents: DocumentRepository, runKey: string): Promise<string> {
  const body = await documents.latestBody(runKey, ARTIFACTS.mergeRequest.kind);
  if (!body) return '';
  try {
    return parseMergeRequestSummaries(body).filter(Boolean).join('\n\n');
  } catch {
    return '';
  }
}
