import type { Need } from '../agent-result/definitions/research';
import type { DocumentRepository } from '../history/document.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';

/** What a stored research or plan result held of the questions and needs a run's documents were rendered from. */
interface StoredAsk {
  questions: string[];
  needs?: Need[];
}

/** The stored `research_result` and `plan_result` of a run, those it has. */
export async function storedAsks(documents: DocumentRepository, key: string): Promise<StoredAsk[]> {
  const bodies = [
    [await documents.latestBody(key, ARTIFACTS.researchResult.kind), ARTIFACTS.researchResult],
    [await documents.latestBody(key, ARTIFACTS.planResult.kind), ARTIFACTS.planResult],
  ] as const;
  return bodies.flatMap(([body, artifact]) => (body === null ? [] : [artifact.parse(body)]));
}
