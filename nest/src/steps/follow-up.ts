import { LINKED_CONTEXT, TASK_SCOPE } from './requirements-brief';

export function withAddedRepos(prompt: string, note: string | null): string {
  if (!note?.trim()) {
    return prompt;
  }
  return `${prompt.trimEnd()}\n\n${note.trim()}\n`;
}

export function planFollowUp(answers: string): string {
  const lines = [
    'The requirements in this message are the whole task. Read the working directory when it has source files.',
    TASK_SCOPE,
    `${LINKED_CONTEXT} Every item must still be this task. Do not add an item that belongs only to another ticket.`,
    'Each item is the smallest change that does the work. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.',
  ];
  if (answers.trim()) {
    lines.push('', 'Answers:', answers.trim());
  }
  lines.push('', 'End with these sections:', 'plan:', '- item', '', 'summary:', '- why');
  return lines.join('\n');
}

export const PLAN_IMPROVE_FOLLOW_UP = [
  'Check the checklist in this message for correctness, logical gaps, and inconsistencies. Fix those in the checklist. Return the full checklist implementation should follow. Read the working directory when it has source files.',
  `${TASK_SCOPE} Check that the checklist covers every behavior the task requires, and add an item for each one that is missing.`,
  `${LINKED_CONTEXT} Every item must still be this task. Do not add an item that belongs only to another ticket.`,
  'Keep each item the smallest change that does the work; when an item adds more, rewrite it onto the existing path. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.',
  'End with these sections:',
  'plan:',
  '- item',
  '',
  'summary:',
  '- why',
].join('\n');

export function rebaseConflictPrompt(input: {
  repo: string;
  files: string[];
  requirements: string;
  base: string;
  commit: string;
}): string {
  const files = input.files.length > 0 ? input.files.map((file) => `- ${file}`).join('\n') : '- (none listed)';
  return [
    `A rebase is in progress in ${input.repo}.`,
    `The new base is ${input.base}.`,
    `The commit being replayed is ${input.commit}.`,
    'Edit only these files:',
    files,
    'Requirements:',
    input.requirements.trim(),
    'Do not run git.',
    'Do not push. Do not create a branch.',
  ].join('\n');
}

export function implementFollowUp(plan: string, notes: string | null): string {
  const lines = [
    'Implement this approved checklist in the mounted worktree. Read a file before editing it.',
    'Do only that checklist. Context from earlier may change how an item is done. Do not start work that belongs to another ticket.',
    'A pipeline return outranks the approved checklist. So do instructions a person added after the checklist was approved. If the fix contradicts an item, do the fix.',
    'When an item changes, end with a plan: section holding the full corrected checklist, before implementation and summary. Without a contradiction, do not write plan:.',
    'Do not start a service. Do not run tests. Do not commit. Do not create a branch.',
    'Write the smallest change that does the checklist. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses. Tests run only in the GitLab or GitHub pipeline, never in this sandbox.',
    '',
    'Plan:',
    plan.trim(),
  ];
  if (notes?.trim()) {
    lines.push('', notes.trim(), '');
    lines.push(
      isPipelineReturn(notes)
        ? 'A pipeline return is a test that failed on this commit. Change the code or that test. Do not leave the files as they are. Do not add a mechanism it did not name.'
        : 'The return is one list. Fix what it names, and do not undo what it says holds. Do not add a mechanism it did not name. In the summary, say that behavior now holds.',
    );
  }
  lines.push('', 'End with these sections:', 'implementation:', '- item', '', 'summary:', '- why');
  return lines.join('\n');
}

export const IMPLEMENT_IMPROVE_FOLLOW_UP = [
  'Check the change for logical and technical gaps and fix only those. Start from the files this change touched. Open another file only to follow a call from the change or a test the return names. Do not sweep the tree with grep. When there is no gap, leave the files. A pipeline return changes the code or the failed test. Do not leave them. Do not widen the change. Do not implement a linked ticket.',
  TASK_SCOPE,
  'Do not start a service, a database, or the application. Do not run tests. Do not run `git commit`, `git push`, or `git add -A`. Do not create a branch.',
  'A pipeline return outranks the approved checklist. So do instructions a person added after the checklist was approved. If the fix contradicts an item, do the fix.',
  'When an item changes, end with a plan: section holding the full corrected checklist, before implementation and summary. Without a contradiction, do not write plan:.',
  'When this pass changed the files, end with implementation and summary. When nothing changed and the return is not a pipeline failure, end with summary only.',
  'implementation:',
  '- item',
  '',
  'summary:',
  '- why',
].join('\n');

export function isPipelineReturn(notes: string | null | undefined): boolean {
  if (!notes) {
    return false;
  }
  const lines = notes.split(/\r?\n/).map((line) => line.trim());
  return lines.includes('## pipeline') && lines.includes('result: fail');
}

export function reportFollowUp(brief: string, implementation?: string | null): string {
  const lines = [
    'Write the merge request summary from the implementation and the five decisions copied below.',
    'Those decisions are the only reviews. Ignore an earlier draft in this chat.',
    'Do not search again. Do not add a finding none of them wrote. Do not end with a decision line.',
    'Use these parts, in this order: What changed, Code review, What holds when a check is ok, and What to fix only when a latest decision is return.',
    'What holds is behavior an ok check accepted. What to fix must not undo it.',
    '',
  ];
  if (implementation?.trim()) {
    lines.push('Implementation:', implementation.trim(), '');
  }
  lines.push(brief.trim());
  return lines.join('\n');
}

export function reviewResume(name: string, implement: string, reviewed: string, plan?: string, returned?: string | null): string {
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
    'End with a summary list and one line, either `decision: ok` or `decision: return`.',
  ];
  if (plan?.trim()) {
    lines.push('', plan.trim());
  }
  return lines.join('\n');
}

export function reviewContinue(name: string): string {
  return [
    `Continue this ${name} review. This chat is only the ${name} angle.`,
    'You were interrupted before the decision. Finish this review. Do not start over.',
    'The complete diff is /work/brief/diff.md.',
    'Do not run tests, a service, a database, or the application. Do not run git.',
    'End with a summary list and one line, either `decision: ok` or `decision: return`.',
  ].join('\n');
}

export const REPORT_CONTINUE = [
  'Continue this review report.',
  'You were interrupted before it was finished. Finish this report. Do not start over.',
  'Do not add a finding none of the five wrote. Do not change their decisions. Do not end with a decision line.',
  'Use these parts, in this order: What changed, Code review, What holds when a check is ok, and What to fix only when a latest decision is return.',
].join('\n');
