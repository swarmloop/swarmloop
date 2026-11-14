import { reviewDefinition } from '../../agent-result/definitions/review';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { readResultFromOutput } from '../../agent-result/read-result';
import { latestReview } from '../../agent-result/stored-review';
import { stepOutput } from '../../core/attempt-output';
import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft } from '../../history/visit';
import { opinionOf, reviewDocuments } from './code-review-record';
import type { Opinion } from './code-review-record';
import { REVIEWERS } from './reviewer';
import type { Reviewer } from './reviewer';

interface Selection {
  kept: Opinion[];
  pending: Reviewer[];
  recovered: DocumentDraft[];
  stale: Set<string>;
}

interface SelectInput {
  key: string;
  only: string | undefined;
  fresh: boolean;
  retry: boolean;
  /** The attempt of the code-review visit that was interrupted. Set when `retry`. */
  attemptId: string | null;
  same: boolean;
  repeated: boolean;
  /** Whether the stored review `kind` counts for this generation and these files. */
  counts: (kind: string) => Promise<boolean>;
}

/** The latest stored review of a reviewer, as an opinion. */
async function storedOpinion(documents: DocumentRepository, key: string, reviewer: Reviewer): Promise<Opinion | null> {
  const review = await latestReview(documents, key, reviewer.name);
  return review ? opinionOf(reviewer.kind, review) : null;
}

/** The review a reviewer sent before its process died, read from the output of the interrupted attempt. */
function recoveredOpinion(root: string, key: string, attemptId: string | null, reviewer: Reviewer): Opinion | null {
  const read = readResultFromOutput(
    reviewDefinition(reviewer.name),
    stepOutput(root, key, `code-review-${reviewer.name}`, attemptId),
  );
  return read.ok ? opinionOf(reviewer.kind, read.value as ReviewResult) : null;
}

function staleReturn(repeated: boolean, opinion: Opinion): boolean {
  return repeated && opinion.decision === 'return';
}

/** Keeps an opinion that counts and notes a stale return. True when the opinion was kept. */
function take(
  round: Selection,
  reviewer: Reviewer,
  opinion: Opinion | null,
  repeated: boolean,
  keeps: boolean,
): boolean {
  if (!opinion) {
    return false;
  }
  if (staleReturn(repeated, opinion)) {
    round.stale.add(reviewer.name);
    return false;
  }
  if (keeps) {
    round.kept.push(opinion);
  }
  return keeps;
}

export async function selectReviewers(
  documents: DocumentRepository,
  root: string,
  input: SelectInput,
): Promise<Selection> {
  const { key, only, fresh, retry, attemptId, same, repeated, counts } = input;
  const round: Selection = { kept: [], pending: [], recovered: [], stale: new Set() };
  for (const reviewer of REVIEWERS) {
    if (fresh || only === reviewer.name) {
      if (!only || only === reviewer.name) {
        round.pending.push(reviewer);
      }
      continue;
    }
    const stored =
      (Boolean(only) || retry || same) && (await counts(reviewer.kind))
        ? await storedOpinion(documents, key, reviewer)
        : null;
    if (take(round, reviewer, stored, repeated, Boolean(only) || retry || stored?.decision === 'ok')) {
      continue;
    }
    const found = retry && !only ? recoveredOpinion(root, key, attemptId, reviewer) : null;
    if (take(round, reviewer, found, repeated, true) && found) {
      round.recovered.push(...reviewDocuments(found));
      continue;
    }
    if (!only) {
      round.pending.push(reviewer);
    }
  }
  return round;
}
