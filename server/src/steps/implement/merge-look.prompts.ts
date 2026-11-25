import type { Subtask } from '../../contract/subtask';
import { starterAnswerWithoutEscalate } from '../../agent-result/definitions/starter-answer';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { STARTER_ACTIONS, taskLines } from '../plan/plan.prompts';
import { skillSection } from '../shared/skill-prompt';

/** What the parent planner is asked when a task merged: the core's look after a merge, and the epic's own answer lines. */
function lookRules(): string {
  return [
    'A task of this run merged. Look at what landed against the plan.',
    skillSection('plan', 'The look after a merge'),
    'Tell a started or merged task what it must know in `decision`.',
    'Do not use `waitFor`: the merged task waits for nothing.',
    'Give `decision` as one short line: what the tasks that started must know, or that nothing changes.',
  ].join('\n');
}

/** What the planner is told of a merged task: its summary, and the marks the server made where it differs from its plan. */
interface MergedTask {
  task: Subtask;
  summary: string;
  marks: string[];
}

/** The follow-up prompt of the parent's plan chat for one merged task. Only the tasks that have not started are listed. */
export function mergeLookPrompt(
  merged: MergedTask,
  contract: string,
  notStarted: Subtask[],
  received: string | null,
): string {
  const { task, summary, marks } = merged;
  return [
    `Task ${task.id} merged: ${task.title}`,
    '',
    'What it delivered:',
    summary.trim() || '(no merge request text)',
    '',
    marks.length > 0 ? 'Where it differs from its plan:' : 'It differs from its plan in nothing the server can see.',
    ...marks.map((mark) => `- ${mark}`),
    '',
    'The contract now:',
    contract.trim() || '(empty)',
    '',
    'The tasks that have not started:',
    notStarted.length > 0 ? taskLines(notStarted) : '(none)',
    '',
    lookRules(),
    '',
    STARTER_ACTIONS,
    '',
    resultPromptFor(starterAnswerWithoutEscalate, received),
  ].join('\n');
}
