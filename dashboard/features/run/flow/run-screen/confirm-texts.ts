import { STEPS } from '@contract/steps';
import type { FlowView } from '@contract/api';
import { stepLabel } from '../../phases';

/** The merge requests that are still open: a stop or a replay leaves them as they are. */
function openRequests(flow: FlowView): string[] {
  return flow.mergeRequests
    .filter((request) => request.state === 'draft' || request.state === 'open')
    .map((r) => r.repo);
}

/** True when a replay from this step also removes the subtasks of a split run: the plan is redone. */
function removesSubtasks(flow: FlowView, step: string): boolean {
  return (
    (flow.tasks?.length ?? 0) > 0 && STEPS.indexOf(step as (typeof STEPS)[number]) <= STEPS.indexOf('plan-improve')
  );
}

/** What a stop does now, what stays on the host, and what it cannot take back. */
export function stopBody(flow: FlowView): string {
  const open = openRequests(flow);
  return [
    `${stepLabel(flow.currentStep)} stops now.`,
    open.length > 0
      ? `Its commits and pushes stay, and the merge request in ${open.join(', ')} stays open while CI on the host keeps running.`
      : 'Its commits and pushes stay. No merge request is open yet.',
  ].join(' ');
}

/** What a replay throws away: the plan's subtasks of a split run, else the results of the later steps. */
function discarded(flow: FlowView, step: string): string {
  return removesSubtasks(flow, step)
    ? `The ${flow.tasks?.length ?? 0} subtasks of the plan are removed and the plan is made again, which cannot be undone.`
    : 'The results of the later steps are replaced, which cannot be undone.';
}

/** What a replay from a step does again, what stays, and what cannot be undone. */
export function replayBody(flow: FlowView, step: string): string {
  return `Everything after ${step} is done again. The earlier attempts stay in the history. ${discarded(flow, step)}`;
}

/** A replay that first stops the step the run is working on. */
export function stopAndStartBody(flow: FlowView, step: string): string {
  return `${stepLabel(flow.currentStep)} is running and stops now, then ${step} starts again. ${discarded(flow, step)}`;
}

/** What running one reviewer again does. */
export function reviewerBody(step: string): string {
  return [
    `The ${stepLabel(step)} review runs again on the current branch.`,
    'Its earlier answer stays in the history, and the other reviewers keep theirs.',
    'The review report is written again from the new answers, which cannot be undone.',
  ].join(' ');
}
