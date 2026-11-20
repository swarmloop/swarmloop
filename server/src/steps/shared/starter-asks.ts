import type { PlanChatEntry, PlanChatLog } from '../../contract/plan-chat';
import { SUBTASK_ASKING_STEPS } from '../implement/implement-question';

/**
 * The questions of a subtask's implement and implement-improve that its planner escalated and nobody answered yet,
 * oldest first. An escalation is closed once an answer entry for the step that asked is newer than it.
 */
export function asksForStarter(log: Pick<PlanChatLog, 'entries'>): PlanChatEntry[] {
  const answers = log.entries.filter((entry) => entry.kind === 'answer');
  return log.entries
    .filter(
      (entry) =>
        entry.kind === 'escalation' &&
        entry.state === 'pending' &&
        entry.from !== undefined &&
        SUBTASK_ASKING_STEPS.includes(entry.from) &&
        !answers.some((answer) => answer.from === entry.from && answer.at >= entry.at),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
}
