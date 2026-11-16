import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import { DELIVERED_PREFIX } from '../commit/commit-result';

export const NOTHING_TO_MERGE = 'Nothing to merge: the change was not needed.';

/**
 * The run ends `done` with no merge request. The commit document starts like a delivered task's, so a parent reads the
 * child as skipped, not as a green task that has no request to merge.
 */
export function nothingToMergeResult(startedAt: string, reason: string): StepResult {
  const why = reason.trim();
  return {
    route: { to: 'jump', step: 'done' },
    summary: `${startedAt} merge-request done\n${NOTHING_TO_MERGE}${why ? `\n${why}` : ''}`,
    outputs: [{ artifact: ARTIFACTS.commit, value: `${DELIVERED_PREFIX} ${NOTHING_TO_MERGE}\n` }],
    handoff: `- ${NOTHING_TO_MERGE}\n`,
  };
}
