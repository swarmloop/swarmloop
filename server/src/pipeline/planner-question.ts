import type { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunEntity } from '../history/entities';
import type { OpenedStep } from '../steps/step-run';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { planAnswersStep } from '../steps/plan/plan.prompts';
import { planReplyFor, type PlanReplyResult } from '../agent-result/definitions/plan-reply';
import { resultPromptFor } from '../agent-result/result-prompt';

/** What the planner left of a step's question: an answer, an escalation, or nothing usable. */
type QuestionOutcome = 'answered' | 'escalated' | 'none';

/** What a question turn needs. */
interface QuestionDeps {
  chat: PlanChatStore;
  conversation: PlanConversation;
  clock: Clock;
}

/** A visit of the plan step that no step holds: the run waits, so the visit is its own and starts now. */
function openedFor(run: RunEntity, clock: Clock): OpenedStep {
  return {
    run: { ...run, stepStartedAt: null },
    attemptId: '',
    prior: null,
    previousStep: run.currentStep,
    previousStatus: run.status,
    started: clock.now(),
    startedAt: clock.iso(),
  };
}

/**
 * Asks the run's planner the question of a step, in the planner's own chat, for an answer only. An answer is recorded
 * for the step and the question is taken. An escalation is recorded as the planner's words and the question stays, so
 * the step keeps waiting. Without a usable reply nothing is written.
 */
export async function askPlanner(
  deps: QuestionDeps,
  run: RunEntity,
  question: PlanChatEntry,
): Promise<QuestionOutcome> {
  const definition = planReplyFor({ split: false, subtask: false, answerOnly: true });
  const visit = await deps.conversation.visit(
    openedFor(run, deps.clock),
    (received) => planAnswersStep(question.from ?? 'a step', question.text, resultPromptFor(definition, received)),
    definition,
    (value) => ((value as PlanReplyResult).reply.trim() ? [] : ['reply: give the answer']),
  );
  if (!visit) return 'none';
  const reply = visit.value as PlanReplyResult;
  const entry = { role: 'planner', text: reply.reply.trim(), at: deps.clock.iso() } as const;
  if (reply.escalate?.trim()) {
    await deps.chat.appendEntry(run.key, { ...entry, key: `escalate-${question.key}`, state: 'taken' });
    return 'escalated';
  }
  await deps.chat.appendEntry(run.key, {
    ...entry,
    key: `answer-${question.key}`,
    state: 'pending',
    kind: 'answer',
    ...(question.from ? { from: question.from } : {}),
  });
  await deps.chat.markTaken(run.key, [question.key]);
  return 'answered';
}
