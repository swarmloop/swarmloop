import { ERROR_CODES } from '../../contract/error-codes';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { items, section } from './markdown-section';

/** A sibling task that a task needs before it can go on, and what it needs from it. */
export interface Need {
  id: string;
  what: string;
}

/** The `needs:` section of an answer: one `- <id>: <what>` line per sibling task. A line of another shape is dropped. */
export function parseNeeds(text: string): Need[] {
  const found: Need[] = [];
  for (const line of items(section(text, 'needs') ?? '')) {
    const match = /^`?([^\s:`]+)`?\s*:\s*(.+)$/.exec(line);
    if (match) {
      found.push({ id: match[1], what: match[2].trim() });
    }
  }
  return found;
}

/** The stored body of the needs. It reads back through `parseNeeds`. An empty list is an empty body. */
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
