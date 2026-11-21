import { storedReview } from '../agent-result/stored-review';
import { requirementsFact } from '../steps/shared/requirements-fact';

interface StoredDocument {
  runId: number;
  kind: string;
  body: string;
}

/** Requirement ids met and all of them, summed over the merged runs. A run without per-id statuses adds nothing. */
export function requirementsOf(runIds: number[], documents: StoredDocument[]): { met: number; total: number } {
  const sum = { met: 0, total: 0 };
  for (const id of runIds) {
    const own = documents.filter((document) => document.runId === id);
    const fact = requirementsFact(own, storedReview('requirements', own)?.requirements);
    sum.met += fact?.met ?? 0;
    sum.total += fact?.total ?? 0;
  }
  return sum;
}
