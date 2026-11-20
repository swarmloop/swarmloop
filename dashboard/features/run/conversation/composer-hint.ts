import type { ComposerMode } from '@contract/plan-chat';

const HINTS: Record<ComposerMode, string> = {
  plan: 'goes into the plan',
  amend: 'amends the plan when the current step ends',
  'add-tasks': 'adds tasks to the epic',
  reopen: 'reopens this run and updates its merge request',
  'follow-up': 'starts a follow-up run',
  subtask: "goes to this task's planner",
  epic: "goes to the epic's planner",
};

/** What sending a message does now. */
export function composerHint(mode: ComposerMode): string {
  return HINTS[mode];
}
