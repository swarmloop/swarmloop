import { isPipelineReturn } from '../follow-up';
import type { FailedCommand } from '../../environment/environment-types';
import { TASK_SCOPE } from '../shared/requirements-brief';

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

const NEAR_TESTS_RULE =
  "Run the tests closest to the change: the spec files of the changed code and the ones that import it. Do not run the project's full check commands. The checks step runs them right after. The one exception is a command that came back red.";
const EDIT_TOOLS_RULE =
  "Change files with the runtime's own edit and write tools, and read them with its read tool. Use the shell to run commands, not to rewrite files.";
const RERUN_RULE =
  'On a return from the checks step, or a pipeline return whose failed job names a command the project also runs as a check, the failed commands come with it. Rerun each failed command in the sandbox after the change, and end only when it passes. When it cannot pass, `summary` says which command still fails and why.';

/** Sent after a turn that answered a checks return while the server's rerun of the failed commands is still red. */
export function checksStillRed(red: FailedCommand[]): string {
  return [
    'The server ran the failed checks again after your turn, and they still fail:',
    ...red.map(({ repo, command, tail }) => `\n${repo}: ${command}\n${tail.trim()}`),
    '',
    'Fix the cause, run each failed command again in the sandbox, and end only when it passes. When it cannot pass, say in the summary which command still fails and why.',
    'End with these sections:',
    'implementation:',
    '- item',
    '',
    'summary:',
    '- why',
  ].join('\n');
}

export function implementFollowUp(
  plan: string,
  notes: string | null,
  context: { heading: string; body: string }[] = [],
): string {
  const lines = [
    'Implement this approved checklist in the mounted worktree. Read a file before editing it.',
    'Do only that checklist. Context from earlier may change how an item is done. Do not start work that belongs to another ticket.',
    'A pipeline return outranks the approved checklist. So do instructions a person added after the checklist was approved. If the fix contradicts an item, do the fix.',
    'When an item changes, end with one plan: block of "- item" lines, not a JSON object, holding the full corrected checklist, before implementation and summary. Without a contradiction, do not write plan:.',
    'Do not start a service. Do not commit. Do not create a branch.',
    NEAR_TESTS_RULE,
    EDIT_TOOLS_RULE,
    RERUN_RULE,
    'Write the smallest change that does the checklist. Keep to the structure and patterns already in the tree, and keep it clean, simple, and straightforward: DRY, KISS, SOLID. Favor clear, well-factored code over clever or cramped code: each function, module, and layer has one clear responsibility. Reach for an abstraction when it makes the code clearer and matches how the tree is already organized; do not add a file, helper, or layer that does not earn its place or that the task does not need. When a change leaves a component, file, export, import, comment, or commented-out code with no remaining use, remove that leftover in the same change. Keep the behavior complete and reliable: the cases the requirement names work, and errors are handled the way the tree already handles them. Cover the change with tests in the style the tree already uses.',
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
  for (const { heading, body } of context) {
    lines.push('', `${heading}:`, body.trim());
  }
  lines.push('', 'End with these sections:', 'implementation:', '- item', '', 'summary:', '- why');
  return lines.join('\n');
}

const CHECK_FAILED_LINE = 'The server check below failed on your files. Run it, fix the cause, run it again.';

export function implementImproveFollowUp(notes: string | null): string {
  const lines = [
    'Check the change for logical and technical gaps and fix only those. Start from the files this change touched. Open another file only to follow a call from the change or a test the return names. Do not sweep the tree with grep. When there is no gap and no command came back red, leave the files. A pipeline return changes the code or the failed test. Do not leave them. Do not widen the change. Do not implement a linked ticket.',
    TASK_SCOPE,
    NEAR_TESTS_RULE,
    EDIT_TOOLS_RULE,
    RERUN_RULE,
    'Do not start a service, a database, or the application. Do not run `git commit`, `git push`, or `git add -A`. Do not create a branch.',
    'A pipeline return outranks the approved checklist. So do instructions a person added after the checklist was approved. If the fix contradicts an item, do the fix.',
    'When an item changes, end with one plan: block of "- item" lines, not a JSON object, holding the full corrected checklist, before implementation and summary. Without a contradiction, do not write plan:.',
    'When this pass changed the files, end with implementation and summary. When nothing changed and the return is not a pipeline failure, end with summary only.',
  ];
  const returned = notes?.trim();
  if (returned) {
    lines.push('', 'Why this returned:');
    if (returned.startsWith('## checks')) {
      lines.push(CHECK_FAILED_LINE);
    }
    lines.push(returned, '');
  }
  lines.push('implementation:', '- item', '', 'summary:', '- why');
  return lines.join('\n');
}
