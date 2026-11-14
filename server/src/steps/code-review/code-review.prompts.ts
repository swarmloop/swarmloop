import { reviewAnswerDefinition, reviewDefinition } from '../../agent-result/definitions/review';
import { reviewReport } from '../../agent-result/definitions/review-report';
import { resultPromptFor } from '../../agent-result/result-prompt';

/** The merge request summary prompt for a new chat: the decisions to copy, and the full result text. */
export function reportFollowUp(brief: string, implementation?: string | null): string {
  const lines = [
    'Write the merge request summary from the implementation and the five decisions copied below.',
    'Those decisions are the only reviews. Ignore an earlier draft in this chat.',
    'Do not search again. Do not add a finding none of them wrote. Do not end with a decision line.',
    'Use these parts, in this order: What changed, Code review, What holds when a check is ok, and What to fix only when a latest decision is return.',
    'What holds is behavior an ok check accepted. What to fix must not undo it.',
    resultPromptFor(reviewReport, null),
    '',
  ];
  if (implementation?.trim()) {
    lines.push('Implementation:', implementation.trim(), '');
  }
  lines.push(brief.trim());
  return lines.join('\n');
}

/** What a reviewer sees on the next round: its last finding, the answer of implement, and what to decide. */
export function exchangeSection(finding: string, answer: string | null): { heading: string; body: string } {
  return {
    heading: 'Your last finding and the answer of implement',
    body: [
      finding.trim(),
      '',
      answer?.trim() ? `Implement answered: ${answer.trim()}` : 'Implement gave no answer to this finding.',
      '',
      'Decide again. decision: ok when the answer holds; decision: return when your finding still holds, and say why. Give that one line in `reason`.',
    ].join('\n'),
  };
}

export function reviewResume(
  name: string,
  implement: string,
  reviewed: string,
  plan?: string,
  returned?: string | null,
  received: string | null = reviewDefinition(name).name,
  exchange?: { heading: string; body: string },
): string {
  const note = (body: string): string => body.trim() || '- nothing recorded';
  const lines = [
    `Continue this ${name} review. This chat is only the ${name} angle.`,
    'The complete diff is /work/brief/diff.md. Read it, and read the files in the working directory that this angle needs.',
    'Do not run tests, a service, a database, or the application. Do not run git.',
    'Implement and implement-improve have run since your last decision. What they did and why:',
    '',
    'Implement:',
    note(implement),
    '',
    'Implement improve:',
    note(reviewed),
    '',
    ...(returned?.trim() ? ['Last return:', returned.trim(), ''] : []),
    'Judge only this angle. When your last return is already fixed, or it is already what the plan asks, decision: ok.',
    'Do not return a finding that undoes what the last return says must stay.',
    'A behavior it removes is not a missing requirement.',
    'A change that makes a failed pipeline job on this branch pass is not extra.',
    'The checklist may have been corrected to fix a failed pipeline or to follow later instructions. The list below is the current one.',
    'A change that makes the failed job pass, or that the latest pipeline note requires, is required and is never returned.',
    'Do not return a finding that brings back what the failing pipeline log shows as the cause.',
    'On `decision: return`, name one broken behavior. Do not ask for a new subsystem.',
    ...(exchange ? ['', `${exchange.heading}:`, exchange.body, ''] : []),
    resultPromptFor(exchange ? reviewAnswerDefinition(name) : reviewDefinition(name), exchange ? null : received),
  ];
  if (plan?.trim()) {
    lines.push('', plan.trim());
  }

  return lines.join('\n');
}

export function reviewContinue(name: string, received: string | null = reviewDefinition(name).name): string {
  return [
    `Continue this ${name} review. This chat is only the ${name} angle.`,
    'You were interrupted before the decision. Finish this review. Do not start over.',
    'The complete diff is /work/brief/diff.md.',
    'Do not run tests, a service, a database, or the application. Do not run git.',
    resultPromptFor(reviewDefinition(name), received),
  ].join('\n');
}

/** Finishes an interrupted report in its own chat, which has had the full result text. */
export const REPORT_CONTINUE = [
  'Continue this review report.',
  'You were interrupted before it was finished. Finish this report. Do not start over.',
  'Do not add a finding none of the five wrote. Do not change their decisions. Do not end with a decision line.',
  'Use these parts, in this order: What changed, Code review, What holds when a check is ok, and What to fix only when a latest decision is return.',
  resultPromptFor(reviewReport, reviewReport.name),
].join('\n');

export function approvedChecklist(items: string[]): string {
  return [
    'This is the approved checklist. A behavior it removes is not a missing requirement.',
    'On a later pass, decision: ok when the last return is already what this checklist asks, even when the files were left unchanged. Do not return that behavior again.',
    'The checklist may have been corrected to fix a failed pipeline or to follow later instructions. The list below is the current one.',
    'A change that makes the failed job pass, or that the latest pipeline note requires, is required and is never returned.',
    'Do not return a finding that brings back what the failing pipeline log shows as the cause.',
    ...items.map((item) => `- ${item}`),
  ].join('\n');
}

/** What the requirements reviewer is asked about the subtasks of a split run. */
export const SUBTASK_PROOF_CHECK =
  "This run was split into the subtasks below. Check every requirement of the input against the merged diff first. Check every task's proof after that.";
