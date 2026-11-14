import type { DocumentRepository } from '../../history/document.repository';
import { CODE_REVIEWERS } from '../../contract/steps';
import type { Issue } from '../contract/step-contract';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { latestReview } from '../../agent-result/stored-review';
import { issueOf } from '../shared/handoff';

export const NOT_DELIVERED = 'nothing changed and the task is not delivered';

type UnchangedOutcome = { delivered: string } | { issues: Issue[] };

/** The places the requirements review names for the behaviors that are already in the tree. */
function locations(review: ReviewResult): string[] {
  return (review.met ?? []).map((place) => place.trim()).filter((place) => place !== '');
}

/**
 * What an unchanged tree means. It is delivered only when the last review round passed every reviewer
 * and its requirements review says where each required behavior already is. Any other unchanged tree goes back to implement.
 */
export async function unchangedOutcome(documents: DocumentRepository, key: string): Promise<UnchangedOutcome> {
  const requirements = await latestReview(documents, key, 'requirements');
  if (requirements?.decision === 'ok') {
    const found = locations(requirements);
    const others = await Promise.all(
      CODE_REVIEWERS.filter((name) => name !== 'requirements').map((name) => latestReview(documents, key, name)),
    );
    if (found.length > 0 && others.every((review) => review === null || review.decision === 'ok')) {
      return { delivered: [...new Set(found)].join('; ') };
    }
  }
  return { issues: [issueOf('commit', NOT_DELIVERED, `${NOT_DELIVERED}\n`)] };
}
