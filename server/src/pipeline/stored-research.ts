import type { ResearchResult } from '../agent-result/definitions/research';
import type { DocumentRepository } from '../history/document.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';

/** The stored `research_result` of a run; null for a run that has none. */
export async function storedResearch(documents: DocumentRepository, key: string): Promise<ResearchResult | null> {
  const body = await documents.latestBody(key, ARTIFACTS.researchResult.kind);
  return body === null ? null : ARTIFACTS.researchResult.parse(body);
}
