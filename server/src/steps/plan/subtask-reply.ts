import type { PlanChatEntry } from '../../contract/plan-chat';
import type { RunEntity } from '../../history/entities';
import type { PlanReplyResult } from '../../agent-result/definitions/plan-reply';
import type { ArtifactValue, StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../model-step-context';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { PlanConversation } from '../shared/plan-conversation';
import type { StarterExchange } from '../shared/starter-exchange';

/** What a subtask's reply is handed up with. */
interface ReplyDeps {
  planChat: PlanChatStore;
  conversation: PlanConversation;
  exchange: StarterExchange;
}

/** What a person said to a subtask's planner and what it answered. */
interface Exchange {
  /** The login of the first message, or null when it had none. */
  author: string | null;
  message: string;
  reply: string;
}

/**
 * The line the parent's conversation shows for an exchange, written once per visit of the subtask's plan step:
 * `<author> → <task id>: <message>`, the reply, and the subtask to link to.
 */
export async function tellParent(
  deps: ReplyDeps,
  ctx: ModelStepContext,
  parent: RunEntity,
  said: Exchange,
): Promise<void> {
  const { run, startedAt } = ctx.opened;
  const entry: PlanChatEntry = {
    key: `exchange-${run.key}-${startedAt}`,
    role: 'planner',
    kind: 'info',
    text: `${said.author ?? 'You'} → ${run.taskId}: ${said.message}`,
    reply: said.reply,
    link: run.key,
    at: deps.conversation.clock.iso(),
    state: 'taken',
  };
  await deps.planChat.appendEntry(parent.key, entry);
}

/**
 * What a subtask's reply hands up beside the change it made to its own plan. Before implement started the plan step
 * waits for the parent's answer, as it does for a question of its own. After it, the parts go up as escalations the
 * parent's planner finds, and the task goes on. Null when nothing is left to wait for.
 */
export async function handUpReply(
  deps: ReplyDeps,
  ctx: ModelStepContext,
  reply: PlanReplyResult,
  implemented: boolean,
  outputs: ArtifactValue[],
): Promise<StepResult | null> {
  const escalate = reply.escalate?.trim() ?? '';
  if (implemented) {
    await deps.exchange.handUp(ctx, reply, 'implement', escalate ? [escalate] : []);
    return null;
  }
  const question = [reply.question?.trim() ?? '', escalate].filter(Boolean).join('\n');
  const { wait } = await deps.exchange.act(
    ctx,
    { ...reply, question },
    { step: 'plan', route: 'document', answered: false, mayAsk: true, outputs },
  );
  return wait;
}
