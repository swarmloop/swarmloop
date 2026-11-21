import type { Requirement } from '../../contract/requirement-list';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { ARTIFACTS } from '../contract/artifacts';
import { readStored } from './report-stored';

interface StoredDocument {
  kind: string;
  body: string;
}

function latest(documents: StoredDocument[], kind: string): StoredDocument | undefined {
  return [...documents].reverse().find((document) => document.kind === kind);
}

export function requirementsFact(
  documents: StoredDocument[],
  marks: ReviewResult['requirements'],
): { met: number; total: number } | null {
  const stored = latest(documents, ARTIFACTS.requirementList.kind);
  const list: Requirement[] | null = stored ? readStored(() => ARTIFACTS.requirementList.parse(stored.body)) : null;
  if (!list || list.length === 0 || !marks) {
    return null;
  }
  const met = list.filter((item) => marks.some((mark) => mark.id === item.id && mark.status === 'met')).length;
  return { met, total: list.length };
}
