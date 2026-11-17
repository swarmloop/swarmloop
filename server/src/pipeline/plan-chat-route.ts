import type { RunEntity } from '../history/entities';
import { STEPS, type StepName } from '../contract/steps';
import type { RunState } from '../contract/run-state';

/** Where a person's message goes. */
export type MessageTurn = 'answer' | 'planning' | 'amend' | 'add-tasks' | 'reopen' | 'follow-up' | 'subtask';

/** What the route of a message depends on besides the run's row. */
interface TurnContext {
  state: RunState;
  /** The key of the parent run, for a subtask. */
  parentKey?: string;
  /** How many questions or paste items wait for the person. */
  openItems: number;
}

/** Runs whose work ended without a merge request waiting to be merged. */
const ENDED: readonly RunState[] = ['merged', 'closed'];
/** Runs that stand still with work left or done: a message reopens them. */
const REOPENED: readonly RunState[] = ['done', 'stopped', 'failed', 'blocked'];

/** True once the run reached implement, so the plan is amended and not made again. */
function implementStarted(step: string): boolean {
  return STEPS.indexOf(step as StepName) >= STEPS.indexOf('implement');
}

/** The one rule per place of a run that says what a message does. */
export function messageTurn(
  run: Pick<RunEntity, 'split' | 'currentStep' | 'workspace'>,
  context: TurnContext,
): MessageTurn {
  if (context.parentKey) return 'subtask';
  if (ENDED.includes(context.state) || run.workspace === 'removed') return 'follow-up';
  if (context.openItems > 0) return 'answer';
  if (!implementStarted(run.currentStep)) return 'planning';
  if (REOPENED.includes(context.state)) return 'reopen';
  return run.split ? 'add-tasks' : 'amend';
}
