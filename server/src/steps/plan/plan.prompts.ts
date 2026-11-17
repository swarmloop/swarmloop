import type { Subtask } from '../../contract/subtask';
import { plan } from '../../agent-result/definitions/plan';
import { subtaskAnswer } from '../../agent-result/definitions/subtask-answer';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { LINKED_CONTEXT, TASK_SCOPE } from '../shared/requirements-brief';
import { skillSection } from '../shared/skill-prompt';

/** A subtask has no one to ask: it decides its own questions, states them as assumptions and gives the plan. */
export function subtaskDecides(resultText: string): string {
  return [
    'No one can answer these questions. Decide each one yourself from the task, the contract and the tree, then give the plan now. Do not ask again.',
    resultText,
  ].join('\n\n');
}

/** The prompt that finishes an interrupted plan in the same chat, which already holds the plan result prompt. */
export function planContinue(): string {
  return [
    'You were interrupted before the plan was done. Finish it. Do not start over.',
    resultPromptFor(plan, plan.name),
  ].join('\n');
}

export function planFollowUp(answers: string, resultText: string, heading = 'Answers:'): string {
  const lines = [
    'The requirements in this message are the whole task. Read the working directory when it has source files.',
    TASK_SCOPE,
    `${LINKED_CONTEXT} Every item must still be this task. Do not add an item that belongs only to another ticket.`,
    'Each item is the smallest change that does the work. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses.',
  ];
  if (answers.trim()) {
    lines.push('', heading, answers.trim());
  }
  lines.push('', resultText);
  return lines.join('\n');
}

/** The heading before a person's messages in a planner prompt. */
export const PERSON_WORDS = "The person's words:";

/** What the planner is told in its own chat when a person wrote to it. */
export function planChatFollowUp(messages: readonly { text: string }[], resultText: string): string {
  const guidance = skillSection('plan', 'Answer a person');
  const words = messages.map((message) => message.text.trim()).join('\n\n');
  return planFollowUp(words, [guidance, resultText].join('\n\n'), PERSON_WORDS);
}

/** The rules of an amendment: the run already implemented, so the plan is changed and not made again. */
const AMEND_RULES =
  'The run already implemented part of this plan. Items already done stay done. In `plan`, give the whole checklist: keep every done item as it is, and add or change items only for what the message asks. Do not split the run into tasks.';

/** What the planner is told in its own chat when a person wrote to a run that already implemented. */
export function planChatAmends(messages: readonly { text: string }[], resultText: string): string {
  return planChatFollowUp(messages, [AMEND_RULES, resultText].join('\n\n'));
}

/** The rules of a split run that already started its tasks: the planner adds tasks and changes none. */
const ADD_TASKS_RULES =
  'The tasks of this run already started or merged. Started and merged tasks and the decisions of the contract stay as they are. In `tasks`, give only the tasks to add, with their `contract` entries and `keep` lines, and no `plan`. A task you add may depend on a task that is already there.';

/** What the planner is told in its own chat when a person wrote to a split run whose tasks started. */
export function planChatAddsTasks(messages: readonly { text: string }[], resultText: string): string {
  return planChatFollowUp(messages, [ADD_TASKS_RULES, resultText].join('\n\n'));
}

/** What the parent's planner is asked in its own chat when a subtask has questions. */
export function subtaskAsks(task: Subtask, questions: string, contract: string, received: string | null): string {
  return [
    `Subtask ${task.id} asks:`,
    questions.trim(),
    '',
    `The task: ${task.title}`,
    task.description,
    '',
    'The contract now:',
    contract.trim() || '(empty)',
    '',
    'Answer each question as a decision the subtask follows. Do not change the task list. Send the decisions only.',
    '',
    resultPromptFor(subtaskAnswer, received),
  ].join('\n');
}

/** What the planner is asked in its own chat when a step of the run has a question it could not settle. */
export function planAnswersStep(step: string, question: string, resultText: string): string {
  return [
    `The ${step} step asks:`,
    question.trim(),
    '',
    'Answer from the brief, the requirements, the plan and the decisions you already hold, as one decision the step follows. Do not change the plan and do not add requirements.',
    'When it is a product decision you cannot settle from them, do not invent one: escalate it, and say what whoever started the run must decide.',
    '',
    resultText,
  ].join('\n');
}

/** What the planner is asked in its own chat when the person answered the question it escalated for a step. */
export function planReadsAnswer(
  step: string,
  question: string,
  escalation: string,
  answer: string,
  resultText: string,
): string {
  return [
    `You escalated a question of the ${step} step to the person who started the run:`,
    escalation.trim(),
    '',
    `The ${step} step had asked:`,
    question.trim(),
    '',
    'The person answered:',
    answer.trim(),
    '',
    'Give the step the decision the person made, as one decision it follows. Do not change the plan and do not add requirements.',
    '',
    resultText,
  ].join('\n');
}
