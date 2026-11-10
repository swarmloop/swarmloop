import type { FlowView } from '@contract/api';
import { REASON } from '@contract/run-state';

/** True for a run blocked because CI did not run its jobs or timed out. */
function isCiInfra(code: string | null | undefined): boolean {
  return code === REASON.ciNotRun || code === REASON.ciTimeout;
}

/** The label of the resume action: for a CI run that did not run it re-runs CI. */
export function resumeLabel(code: string | null | undefined): string {
  return isCiInfra(code) ? 'Re-run CI' : 'Resume';
}

/** The reason line and the job names of a blocked CI log, or null for any other run. */
export function ciInfra(flow: FlowView): { reason: string; jobs: string[] } | null {
  if (!isCiInfra(flow.stateReason?.code) || !flow.reason) {
    return null;
  }
  const lines = flow.reason.split('\n').filter((line) => line.trim() !== '');
  const jobs = lines.filter((line) => line.startsWith('job: ')).map((line) => line.slice('job: '.length));
  return { reason: lines.filter((line) => !line.startsWith('job: ')).join('\n'), jobs };
}
