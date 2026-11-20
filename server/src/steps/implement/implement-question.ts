import { resumableChat } from '../../agent/agent-session';
import { agentFor } from '../../config/agents';
import type { SwarmloopEnv } from '../../config/env';
import type { Clock } from '../../core/clock';
import type { PlanChatEntry } from '../../contract/plan-chat';
import { ASKS_PLANNER_WORDS, REASON } from '../../contract/run-state';
import { isSubtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { StepResult } from '../contract/step-contract';

/** The heading before the planner's answer in a prompt. */
const ANSWER_HEADING = 'Answer from the planner';

const DECIDE_LINE =
  'This answers the question you asked. Decide any further open choice yourself, and do not ask again: name the choice in `summary` as an assumption.';

/** The steps of a subtask whose questions the planner of its parent takes when its own planner escalates them. */
export const SUBTASK_ASKING_STEPS: readonly string[] = ['implement', 'implement-improve'];

/**
 * True when the run has someone to ask: its own planner, and for a subtask only at the steps that ask. A run that never planned, such as a
 * review of another branch, has no planner chat and asks no one.
 */
export async function mayAsk(
  run: RunEntity,
  chat: PlanChatStore | undefined,
  place: { root: string; env: SwarmloopEnv },
): Promise<boolean> {
  if (!chat) return false;
  if (isSubtask(run) && !SUBTASK_ASKING_STEPS.includes(run.currentStep)) return false;
  const { runtime } = agentFor(place.env, run, 'plan');
  const got = await resumableChat(place.root, run.key, 'plan', runtime);
  return Boolean(got?.chatId);
}

/** The planner's answer to this step's question that the step did not read yet, or null. */
export async function readAnswer(
  chat: PlanChatStore | undefined,
  key: string,
  step: string,
): Promise<PlanChatEntry | null> {
  return (await chat?.answerFor(key, step)) ?? null;
}

/** The answer is read once: the step marks it taken after its launch returned, so a launch that died reads it again. */
export async function takeAnswer(
  chat: PlanChatStore | undefined,
  key: string,
  answer: PlanChatEntry | null,
): Promise<void> {
  if (answer) await chat?.markTaken(key, [answer.key]);
}

/** The answer as a section of a first prompt. */
export function answerSection(answer: PlanChatEntry): { heading: string; body: string } {
  return { heading: ANSWER_HEADING, body: `${answer.text.trim()}\n\n${DECIDE_LINE}` };
}

/** The prompt that continues the step's own chat with the planner's answer. */
export function answerFollowUp(answer: PlanChatEntry, resultText: string): string {
  const { heading, body } = answerSection(answer);
  return [`${heading}:`, body, '', resultText].join('\n');
}

/** A choice the step made itself, for the handoff. */
export function assumedLine(question: string): string {
  return `assumed: ${question.trim().replace(/\s*\n\s*/g, ' ')}`;
}

/** The handoff text with the assumption after it, when the step made one. */
export function withAssumed(handoff: string, question: string | undefined): string {
  return question?.trim() ? `${handoff.trimEnd()}\n${assumedLine(question)}` : handoff;
}

/** What a step that asks needs to say who asked and when. */
interface QuestionAsk {
  chat: PlanChatStore;
  clock: Clock;
  step: string;
  /** The attempt that asked: it names the question, so a replay of the attempt asks once. */
  attemptId: string;
  startedAt: string;
  question: string;
}

/**
 * Records the question in the plan chat and gives the result of a step that waits for the planner. Nothing is
 * committed and no container is held: the server takes the question to the planner and starts the step again.
 */
export async function waitForPlanner(run: RunEntity, ask: QuestionAsk): Promise<StepResult> {
  await ask.chat.appendEntry(run.key, {
    key: `ask-${ask.step}-${ask.attemptId}`,
    role: 'planner',
    kind: 'question',
    from: ask.step,
    text: ask.question.trim(),
    at: ask.clock.iso(),
    state: 'pending',
  });
  const reason = `${ask.step} ${ASKS_PLANNER_WORDS}`;
  return {
    route: { to: 'wait', code: REASON.asksPlanner, reason },
    summary: `${ask.startedAt} ${reason}\n${ask.question.trim()}`,
    outputs: [],
  };
}
