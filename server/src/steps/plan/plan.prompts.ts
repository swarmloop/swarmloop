import { LINKED_CONTEXT, TASK_SCOPE } from '../shared/requirements-brief';

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
