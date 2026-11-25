import type { PlanChatEntry } from '../../contract/plan-chat';

/**
 * The one reading of a planner's `escalate`: what whoever started the run must decide, as the pending escalation of the
 * question or message it answers. Null when the reply escalates nothing. The key names the question, so a replay of the
 * same visit writes it once.
 */
export function replyEscalation(
  escalate: string | undefined,
  asked: { key: string; from?: string },
  at: string,
): PlanChatEntry | null {
  const text = escalate?.trim();
  if (!text) return null;
  return {
    key: `escalate-${asked.key}`,
    role: 'planner',
    kind: 'escalation',
    text,
    at,
    state: 'pending',
    ...(asked.from ? { from: asked.from } : {}),
  };
}
