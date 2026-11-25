import type { RunEntity } from '../history/entities';
import { STEPS, type StepName } from '../contract/steps';
import type { RunState } from '../contract/run-state';

/** Where a person's message goes. `to-parent` is a message to a subtask that ended: its planner is the parent's. */
export type MessageTurn = 'answer' | 'planning' | 'amend' | 'add-tasks' | 'reopen' | 'follow-up' | 'to-parent';

/** What the route of a message depends on besides the run's row. */
interface TurnContext {
  state: RunState;
  /** The key of the parent run, for a subtask. */
  parentKey?: string;
  /** How many questions or paste items still wait for their answer; an item that carries its answer is not counted. */
  openItems: number;
  /** True when the run's plan holds tasks. A run that may split but made one plan has none and is amended. */
  split?: boolean;
}

/** Runs whose work ended without a merge request waiting to be merged. */
const ENDED: readonly RunState[] = ['merged', 'closed'];
/** Runs that stand still without being done: a message does what Resume does for them. */
const STALLED: readonly RunState[] = ['stopped', 'failed', 'blocked'];
/** Runs that stand still with work left or done: a message reopens them. */
const REOPENED: readonly RunState[] = ['done', ...STALLED];

/** True once the run reached implement, so the plan is amended and not made again. */
function implementStarted(step: string): boolean {
  return STEPS.indexOf(step as StepName) >= STEPS.indexOf('implement');
}

/** How many of the items still wait for their answer: the count `openItems` takes. */
export function waitingItems(items: readonly { answer: string }[]): number {
  return items.filter((item) => !item.answer.trim()).length;
}

/** The one rule per place of a run that says what a message does. */
export function messageTurn(run: Pick<RunEntity, 'currentStep' | 'workspace'>, context: TurnContext): MessageTurn {
  if (ENDED.includes(context.state) || run.workspace === 'removed')
    return context.parentKey ? 'to-parent' : 'follow-up';
  if (context.openItems > 0 && context.state !== 'running') return 'answer';
  if (!implementStarted(run.currentStep)) return 'planning';
  if (REOPENED.includes(context.state)) return 'reopen';
  return context.split && !context.parentKey ? 'add-tasks' : 'amend';
}

/** True when the message starts the run again: a reopened run, or a stopped, failed or blocked run in planning. */
export function startsRun(turn: MessageTurn, state: RunState): boolean {
  return turn === 'reopen' || (turn === 'planning' && STALLED.includes(state));
}
