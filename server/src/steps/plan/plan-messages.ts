import { resumableChat } from '../../agent/agent-session';
import { isSubtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import type { DocumentRepository } from '../../history/document.repository';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { VisitRepository } from '../../history/visit.repository';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import { checkedRepoNames, mountsForStep } from '../../git/repo-names';
import { completePlan, type PlanResult } from '../../agent-result/definitions/plan';
import { planReplyFor, type PlanReplyResult } from '../../agent-result/definitions/plan-reply';
import { resultPromptFor } from '../../agent-result/result-prompt';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../model-step-context';
import { ARTIFACTS } from '../contract/artifacts';
import { withAddedRepos } from '../follow-up';
import { implementedWithoutTasks } from '../shared/amendment';
import { planErrors } from '../shared/plan-errors';
import type { PlanConversation } from '../shared/plan-conversation';
import { PLAN_EXECUTION_RULE } from '../shared/skill-prompt';
import { storedImpact } from '../shared/research-reads';
import { storedGraph } from '../shared/stored-graph';
import { appendImpact } from '../shared/handoff';
import type { StarterExchange } from '../shared/starter-exchange';
import { addTasksCheck, startedTasks, type TaskLimits } from './plan-tasks';
import { planChatAddsTasks, planChatAmends, planChatFollowUp } from './plan.prompts';
import { readPlan } from './plan-record';
import { handUpReply, tellParent } from './subtask-reply';

/** What the plan step answers a person's messages with. */
export interface MessageDeps {
  planChat: PlanChatStore;
  conversation: PlanConversation;
  documents: DocumentRepository;
  visits: VisitRepository;
  /** The root the run's worktrees and chats live under. */
  root: string;
  /** The runtime the plan step runs the run's agent on. */
  runtimeOf: (run: RunEntity) => RuntimeName;
  /** The one place that acts on what a subtask's reply hands back. */
  exchange: StarterExchange;
  /** The run a subtask belongs to and its contract as it is now; null for any other run. */
  parentOf: (run: RunEntity) => Promise<{ run: RunEntity; contract: string | null } | null>;
}

/** The prompt with the added repositories and the rule every plan prompt ends with. */
export function finished(prompt: string, added: string | null): string {
  return `${withAddedRepos(prompt, added)}\n\n${PLAN_EXECUTION_RULE}`;
}

/**
 * What a message is asked and checked with: tasks only for a split run whose tasks started, an amendment for a run
 * that implemented. A subtask implemented once its own implement visit exists; its decisions are checked against the contract.
 */
async function replyRoute(
  deps: MessageDeps,
  ctx: ModelStepContext,
  limits: TaskLimits,
  subtask: boolean,
  contract: string | null,
) {
  const { run } = ctx.opened;
  const graph = await storedGraph(ctx);
  const adding = limits.maySplit && !subtask && startedTasks(graph.tasks).length > 0;
  const implemented =
    (await implementedWithoutTasks(deps.documents, deps.visits, run)) ||
    (subtask && (await deps.visits.hasAgentVisit(run.id, 'implement')));
  const followUp = adding
    ? planChatAddsTasks
    : implemented
      ? (messages: readonly { text: string }[], text: string) => planChatAmends(messages, text, subtask)
      : (messages: readonly { text: string }[], text: string) => planChatFollowUp(messages, text, subtask);
  return {
    asked: planReplyFor({ split: limits.maySplit, subtask, ...(adding ? { addTasksOnly: true } : {}) }),
    followUp,
    implemented,
    check: adding
      ? addTasksCheck(graph, limits)
      : (value: unknown) => {
          const read = completePlan(value as Partial<PlanResult>);
          return [...planErrors(read, limits, subtask), ...deps.exchange.check(run, read, contract)];
        },
  };
}

/**
 * The messages a person sent are answered in the plan's own chat, with the reply the planner gives. Null when none is
 * waiting, or when there is no plan or no plan chat yet: the message then waits for the first plan, and plan-improve sends the run back.
 */
export async function answerMessages(deps: MessageDeps | null, ctx: ModelStepContext): Promise<StepResult | null> {
  const { run } = ctx.opened;
  if (!deps) return null;
  const { planChat, conversation } = deps;
  const pending = await planChat.pending(run.key);
  const chat = pending.length > 0 ? await resumableChat(deps.root, run.key, 'plan', deps.runtimeOf(run)) : null;
  // The chat can exist before the first plan (research shares it): a message waits until there is a plan to change.
  if (!chat?.chatId || !readPlan(await ctx.reread(ARTIFACTS.requirements))) return null;
  const names = checkedRepoNames((await ctx.reread(ARTIFACTS.repos)) ?? []);
  const mounts = mountsForStep(deps.root, run.key, names, run.targetPath);
  const limits = await conversation.limits(run);
  const subtask = isSubtask(run);
  const parent = subtask ? await deps.parentOf(run) : null;
  const { asked, followUp, check, implemented } = await replyRoute(
    deps,
    ctx,
    limits,
    subtask,
    parent?.contract ?? null,
  );
  const received = chat.resultName ?? null;
  const impact = storedImpact(await ctx.reread(ARTIFACTS.researchResult), await ctx.reread(ARTIFACTS.impact));
  const reason = pending.map((message) => message.text.trim()).join('\n\n');
  // The reply streams to the person while the planner writes it, until its stored entry takes its place.
  const answered = await conversation.whileReplying(run.key, async () => {
    const launched = await ctx.launch({
      prompt: finished(
        appendImpact(followUp(pending, resultPromptFor(asked, received)), impact),
        await ctx.reread(ARTIFACTS.addedRepos),
      ),
      mounts,
      result: asked,
      check,
    });
    const reply = launched.resultValue as PlanReplyResult;
    return { reply, applied: await conversation.applyReply(ctx, reply, reason) };
  });
  const { reply, applied } = answered;
  await planChat.markTaken(
    run.key,
    pending.map((message) => message.key),
  );
  if (parent) {
    const author = pending.find((message) => message.author)?.author ?? null;
    await tellParent(deps, ctx, parent.run, { author, message: reason, reply: reply.reply });
    const wait = await handUpReply(deps, ctx, reply, implemented, applied.outputs);
    if (wait) return { ...wait, ...(applied.handoff ? { handoff: applied.handoff } : {}) };
  }
  // A reply that leaves a plan plan-improve already approved as it was has nothing new to check: the run goes on past it.
  const checked = readPlan(await ctx.reread(ARTIFACTS.requirements))?.decision === 'approve';
  return {
    route: applied.outputs.length === 0 && checked ? { to: 'jump', step: 'branch' } : { to: 'next' },
    summary: `${ctx.opened.startedAt} plan answered`,
    outputs: applied.outputs,
    ...(applied.handoff ? { handoff: applied.handoff } : {}),
  };
}
