import { legacyRequirementsReview, legacyReview } from './legacy/review';
import { reviewDefinition, reviewStoredDefinition } from './definitions/review';
import type { ReviewResult } from './definitions/review';
import { storedResult } from './stored-result';

interface StoredDocument {
  kind: string;
  body: string;
}

/** The document kinds a reviewer's review is read from: the rendered review, and the stored result. */
export function reviewKinds(name: string): string[] {
  return [`review_${name}`, reviewDefinition(name).kind];
}

/** The latest review of a reviewer: its stored result, or for a run from before results the rendered document. */
export function storedReview(name: string, documents: StoredDocument[]): ReviewResult | null {
  const result = storedResult<ReviewResult>(reviewStoredDefinition(name), documents);
  if (result) {
    return result;
  }
  const [renderedKind] = reviewKinds(name);
  const rendered = [...documents].reverse().find((document) => document.kind === renderedKind);
  const legacy = name === 'requirements' ? legacyRequirementsReview : legacyReview;
  return rendered ? legacy(rendered.body) : null;
}

/** The latest review of a reviewer among a run's documents, read by key: its result, or its rendered document. */
export async function latestReview(
  documents: { latestBody(key: string, kind: string): Promise<string | null> },
  key: string,
  name: string,
): Promise<ReviewResult | null> {
  const stored: StoredDocument[] = [];
  for (const kind of reviewKinds(name)) {
    const body = await documents.latestBody(key, kind);
    if (body) {
      stored.push({ kind, body });
    }
  }
  return storedReview(name, stored);
}
