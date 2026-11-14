import { ERROR_CODES } from '../../contract/error-codes';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import type { Need, ResearchResult } from '../../agent-result/definitions/research';
import { parseNeeds } from '../../agent-result/legacy/needs';

export type { Need };

/** The stored body of the needs. An empty list is an empty body. */
export function renderNeeds(needs: Need[]): string {
  return needs.length === 0 ? '' : `needs:\n${needs.map((need) => `- ${need.id}: ${need.what}`).join('\n')}\n`;
}

/** What `needsWait` and the parent's pass say a task waits for. */
function needsReason(needs: Need[]): string {
  return needs.map((need) => `waiting for ${need.id}: ${need.what}`).join('; ');
}

/** The result of the step that asked: the subtask waits, nothing is committed and nothing fails. The parent's pass acts on the stored needs. */
export function needsWait(startedAt: string, needs: Need[]): StepResult {
  const reason = needsReason(needs);
  return {
    route: { to: 'wait', code: ERROR_CODES.SUBTASK_WAITING, reason },
    summary: `${startedAt} ${reason}`,
    outputs: [{ artifact: ARTIFACTS.needs, value: renderNeeds(needs) }],
  };
}

/**
 * The needs a subtask's run holds. Research and plan both write `needs`, and the server clears it, so the object of
 * `research_result` counts only while the stored body is what it rendered; any other body is read as it was written.
 */
export function storedNeeds(needsBody: string, result: ResearchResult | null): Need[] {
  if (!needsBody.trim()) return [];
  if (result?.needs && needsBody === renderNeeds(result.needs)) return result.needs;
  return parseNeeds(needsBody);
}
