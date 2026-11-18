import type { ComposerMode } from '@contract/plan-chat';

const HINTS: Record<Exclude<ComposerMode, 'read-only'>, string> = {
  plan: 'goes into the plan',
  amend: 'amends the plan when the current step ends',
  'add-tasks': 'adds tasks to the epic',
  reopen: 'reopens this run and updates its merge request',
  'follow-up': 'starts a follow-up run',
};

/** What sending a message does now. A read-only conversation has no message box, so no hint. */
export function composerHint(mode: ComposerMode): string | undefined {
  return mode === 'read-only' ? undefined : HINTS[mode];
}
