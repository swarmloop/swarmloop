import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { LiveHub } from '../../live/live.hub';
import type { PipelineService } from '../../pipeline/pipeline.service';
import { openSpend } from '../run-queries-spend';
import type { TaskEntry } from '../../contract/api';
import type { RunState } from '../../contract/run-state';
import { parsePaths } from '../../git/commit-paths';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import { interruptionOf, taskEntries, type TaskRuns } from './documents';
import { ownStates, type StateSources } from './own-state';

type Result = NonNullable<NonNullable<TaskEntry['run']>['result']>;

/** Whether a task's proof held: its checks, review and CI passed when its run is done or merged; failed when it is blocked or failed. */
function proofMet(state: RunState): boolean | null {
  if (state === 'done' || state === 'merged') return true;
  return state === 'blocked' || state === 'failed' ? false : null;
}

/** What a task changed, once its run has a merge request: the merged files, else the paths of its commit. */
function resultOf(documents: DocumentEntity[], state: RunState): Result | null {
  const body = (kind: string) => documents.find((document) => document.kind === kind)?.body;
  if (body(ARTIFACTS.mergeRequest.kind) === undefined) {
    return null;
  }
  const merged = body(ARTIFACTS.mergedFiles.kind);
  const files =
    merged !== undefined
      ? merged.split('\n').filter(Boolean)
      : parsePaths(body(ARTIFACTS.commit.kind) ?? '').map((planned) => planned.path);
  return { files, proofMet: proofMet(state) };
}

/** The own run of each task of a split run, with its state, step, spend and time. The state is read as the run list reads it. */
export async function taskRuns(
  runs: RunRepository,
  visits: Pick<VisitRepository, 'latestVisits'>,
  rows: RunEntity[],
  documents: DocumentEntity[],
  pipeline: PipelineService,
  sources: StateSources,
  live?: LiveHub,
  place: (key: string) => string | undefined = () => undefined,
): Promise<TaskRuns> {
  const children: TaskRuns = new Map();
  const tasks = taskEntries(documents);
  if (tasks.length === 0) {
    return children;
  }
  const durations = await runs.durationByRun(rows.map((row) => row.id));
  const planned = rows.filter((child) => child.taskId && tasks.some((task) => task.id === child.taskId));
  const states = await ownStates(sources, planned, (key) => pipeline.claimed(key), place);
  const stored = await sources.documents.latestDocuments(
    planned.map((child) => child.id),
    ['interruption', ARTIFACTS.mergeRequest.kind, ARTIFACTS.mergedFiles.kind, ARTIFACTS.commit.kind],
  );
  const latestVisits = await visits.latestVisits(planned.map((child) => child.id));
  for (const child of planned) {
    const own = states.get(child.key);
    if (child.taskId && own) {
      const last = latestVisits.get(child.id);
      const childDocuments = stored.filter((document) => document.runId === child.id);
      const note = last?.killReason === 'process died' ? interruptionOf(childDocuments, last.id) : null;
      const result = resultOf(childDocuments, own.state);
      children.set(child.taskId, {
        key: child.key,
        state: own.state,
        stateReason: own.stateReason,
        currentStep: child.currentStep,
        usd: child.spentUsd + openSpend(child, pipeline, live).usd,
        durationMs: durations.get(child.id) ?? 0,
        ...(note ? { interruption: note } : {}),
        ...(result ? { result } : {}),
      });
    }
  }
  return children;
}
