import { resumableChat } from '../../../agent/agent-session';
import type { Agent } from '../../../config/agents';
import type { AgentCallRepository } from '../../../history/agent-call.repository';
import { modelContextTokens } from '../../../steps/shared/model-context';
import { plannerChatKey } from './planner-chat-key';

/** Where the planner chat of a backlog is stored and what its renewal depends on. */
interface PlannerChatPlace {
  root: string;
  /** The share of the model's context past which a chat is renewed. */
  share: number;
  calls: Pick<AgentCallRepository, 'lastCallOfChat'>;
}

/** The chat a turn runs in, and whether it continues it; a new chat says why in `reason`. */
interface PlannerChat {
  chatKey: string;
  resume: boolean;
  reason: string | null;
}

/** Whether a turn on `agent` resumes the backlog's one planner chat or starts it anew, and why it starts anew. */
export async function plannerChatFor(place: PlannerChatPlace, backlogId: number, agent: Agent): Promise<PlannerChat> {
  const chatKey = plannerChatKey(backlogId);
  const renewed = (reason: string): PlannerChat => ({ chatKey, resume: false, reason });
  const session = await resumableChat(place.root, chatKey, 'backlog-plan', agent.runtime);
  if (!session?.chatId) return renewed('no stored chat');
  const last = await place.calls.lastCallOfChat(session.chatId);
  if (last === null) return renewed('no stored chat');
  if (
    last.runtime !== agent.runtime ||
    last.model !== agent.model ||
    (last.effort ?? null) !== (agent.effort ?? null)
  ) {
    return renewed('agent changed');
  }
  const context = modelContextTokens(agent.runtime, agent.model);
  if (context === null || (last.lastPromptTokens ?? 0) >= place.share * context) {
    return renewed('chat past its size limit');
  }
  return { chatKey, resume: true, reason: null };
}
