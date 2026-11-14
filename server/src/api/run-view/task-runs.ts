import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { LiveHub } from '../../live/live.hub';
import type { PipelineService } from '../../pipeline/pipeline.service';
import { openSpend } from '../run-queries-spend';
import { taskLayers, type TaskRuns } from './documents';
import { ownStates, type StateSources } from './own-state';

/** The own run of each task of a split run, with its state, step, spend and time. The state is read as the run list reads it. */
export async function taskRuns(
  runs: RunRepository,
  rows: RunEntity[],
  documents: DocumentEntity[],
  pipeline: PipelineService,
  sources: StateSources,
  live?: LiveHub,
): Promise<TaskRuns> {
  const children: TaskRuns = new Map();
  const tasks = taskLayers(documents).flatMap((layer) => layer.tasks);
  if (tasks.length === 0) {
    return children;
  }
  const durations = await runs.durationByRun(rows.map((row) => row.id));
  const planned = rows.filter((child) => child.taskId && tasks.some((task) => task.id === child.taskId));
  const states = await ownStates(sources, planned, (key) => pipeline.claimed(key));
  for (const child of planned) {
    const own = states.get(child.key);
    if (child.taskId && own) {
      children.set(child.taskId, {
        key: child.key,
        state: own.state,
        stateReason: own.stateReason,
        currentStep: child.currentStep,
        usd: child.spentUsd + openSpend(child, pipeline, live).usd,
        durationMs: durations.get(child.id) ?? 0,
      });
    }
  }
  return children;
}
