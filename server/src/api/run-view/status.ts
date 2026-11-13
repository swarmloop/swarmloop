import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { isLoopStep } from '../../core/pipeline-result';
import { readOutcome } from '../../history/run-state';
import type { RunSummary } from '../../contract/api';
import type { MergeOutcome } from '../../contract/run-state';
import { STEPS } from '../../contract/steps';
import type { StepName } from '../../contract/steps';

export function stepStatus(name: string, run: RunEntity, stat: StepStatEntity | undefined): string {
  if (name === 'done') {
    return run.status === 'done' ? 'done' : 'idle';
  }
  if (stat?.status === 'skipped') {
    return 'skipped';
  }
  if (name === run.currentStep) {
    return run.status === 'done' ? 'done' : run.status;
  }
  if (isLoopStep(name) && stat?.status === 'waiting') {
    return 'returned';
  }
  const current = STEPS.indexOf(run.currentStep as StepName);
  const index = STEPS.indexOf(name as StepName);
  if (index < current || stat) {
    return 'done';
  }
  return 'idle';
}

export function latest(documents: DocumentEntity[], kind: string): string | null {
  const found = [...documents].reverse().find((document) => document.kind === kind);
  return found?.body ?? null;
}

/** Set on a subtask only: its parent's key and its task id. */
const parentLink = (run: RunEntity, keys: Map<number, string>): { parentKey?: string; taskId?: string } =>
  typeof run.parentRunId === 'number' && keys.has(run.parentRunId)
    ? { parentKey: keys.get(run.parentRunId), taskId: run.taskId ?? undefined }
    : {};

/** The merge outcome of a done run, left out until its merge requests have ended. */
export function mergeView(run: RunEntity): { merge?: MergeOutcome } {
  const merge = readOutcome(run.mergeOutcome);
  return merge ? { merge } : {};
}

/** What a run list row adds to the plain run: the parent link of a subtask and the merge outcome of a done run. */
export const listExtras = (
  run: RunEntity,
  keys: Map<number, string>,
): ReturnType<typeof parentLink> & ReturnType<typeof mergeView> => ({
  ...parentLink(run, keys),
  ...mergeView(run),
});

/** The subtask runs of each parent, by parent id. */
export function childrenByParent(runs: RunEntity[]): Map<number, RunEntity[]> {
  const byParent = new Map<number, RunEntity[]>();
  for (const run of runs) {
    if (typeof run.parentRunId === 'number') {
      byParent.set(run.parentRunId, [...(byParent.get(run.parentRunId) ?? []), run]);
    }
  }
  return byParent;
}

/** The epic totals of a run with subtask runs: all their cost, and the wall clock from its start to its end. Empty without subtasks. */
export function epicTotal(
  run: RunEntity,
  children: RunEntity[],
  usdOf: (run: RunEntity) => number,
  now: number,
): Pick<RunSummary, 'epic'> {
  if (children.length === 0) {
    return {};
  }
  const all = [run, ...children];
  const end = all.some((item) => item.status === 'running')
    ? now
    : Math.max(...all.map((item) => Date.parse(item.updatedAt)));
  return {
    epic: {
      usd: all.reduce((sum, item) => sum + usdOf(item), 0),
      durationMs: Math.max(0, end - Date.parse(run.createdAt)),
    },
  };
}
