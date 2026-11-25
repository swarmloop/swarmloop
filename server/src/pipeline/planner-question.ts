import type { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunEntity } from '../history/entities';
import type { OpenedStep } from '../steps/step-run';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { replyEscalation } from '../steps/shared/reply-escalation';
import { planAnswersStep, planReadsAnswer } from '../steps/plan/plan.prompts';
import { planReplyFor, type PlanReplyResult } from '../agent-result/definitions/plan-reply';
import { resultPromptFor } from '../agent-result/result-prompt';

/** What the planner left of a step's question: an answer, an escalation for the person, or nothing usable. */
type QuestionOutcome = { kind: 'answered' | 'none' | 'refused' } | { kind: 'escalated'; escalation: PlanChatEntry };

/** What a question turn needs. */
interface QuestionDeps {
  chat: PlanChatStore;
  conversation: PlanConversation;
  clock: Clock;
}

/** A visit of the plan step that no step holds: the run waits, so the visit is its own and starts now. */
export function openedFor(run: RunEntity, clock: Clock): OpenedStep {
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

const plainAnswer = planReplyFor({ split: false, subtask: false, answerOnly: true });
const findingAnswer = planReplyFor({ split: false, subtask: false, answerOnly: true, finding: true });

/** An answer to a question about a reviewer's finding also decides the finding. */
const answerOnly = (question: PlanChatEntry) => (question.about === 'finding' ? findingAnswer : plainAnswer);

export const hasReply = (value: unknown): string[] =>
  (value as PlanReplyResult).reply.trim() ? [] : ['reply: give the answer'];

/** The planner's answer to the step that asked, kept for the step to read once. */
async function recordAnswer(
  deps: QuestionDeps,
  run: RunEntity,
  question: PlanChatEntry,
  reply: PlanReplyResult,
): Promise<void> {
  const instruction = reply.instruction?.trim();
  await deps.chat.appendEntry(run.key, {
    key: `answer-${question.key}`,
    role: 'planner',
    text: reply.reply.trim(),
    at: deps.clock.iso(),
    // Only a step reads an answer (by `from`); the answer to a person's message has no reader and stays a plain chat line.
    state: question.from ? 'pending' : 'taken',
    kind: 'answer',
    ...(question.from ? { from: question.from } : {}),
    ...(reply.finding ? { finding: reply.finding } : {}),
    ...(instruction ? { instruction } : {}),
  });
}

/**
 * Asks the run's planner the question of a step, in the planner's own chat, for an answer only. An answer is recorded
 * for the step and the question is taken. An escalation is recorded as pending for the person who started the run and
 * the question is taken: the person's answer comes back through the planner. Without a usable reply nothing is written.
 */
export async function askPlanner(
  deps: QuestionDeps,
  run: RunEntity,
  question: PlanChatEntry,
): Promise<QuestionOutcome> {
  const shape = answerOnly(question);
  const visit = await deps.conversation.visit(
    openedFor(run, deps.clock),
    (received) => planAnswersStep(question.from ?? 'a step', question.text, resultPromptFor(shape, received)),
    shape,
    hasReply,
    [question.text],
  );
  if (!visit) return { kind: 'none' };
  if ('refused' in visit) return { kind: 'refused' };
  const reply = visit.value as PlanReplyResult;
  const escalation = replyEscalation(reply.escalate, question, deps.clock.iso());
  if (escalation) {
    await deps.chat.appendEntry(run.key, escalation);
    await deps.chat.markTaken(run.key, [question.key]);
    return { kind: 'escalated', escalation };
  }
  await recordAnswer(deps, run, question, reply);
  await deps.chat.markTaken(run.key, [question.key]);
  return { kind: 'answered' };
}

/**
 * The planner reads the person's answer to the question it escalated, in its own chat, and gives the step the decision.
 * The decision is recorded for the step; the caller closes the escalation. Without a usable reply nothing is written.
 */
export async function readPersonAnswer(
  deps: QuestionDeps,
  run: RunEntity,
  escalation: PlanChatEntry,
  question: PlanChatEntry,
  person: string,
): Promise<QuestionOutcome> {
  const shape = answerOnly(question);
  const visit = await deps.conversation.visit(
    openedFor(run, deps.clock),
    (received) =>
      planReadsAnswer(
        escalation.from ?? 'a step',
        question.text,
        escalation.text,
        person,
        resultPromptFor(shape, received),
      ),
    shape,
    hasReply,
    [question.text, escalation.text, person],
  );
  if (!visit) return { kind: 'none' };
  if ('refused' in visit) return { kind: 'refused' };
  await recordAnswer(deps, run, question, visit.value as PlanReplyResult);
  return { kind: 'answered' };
}
