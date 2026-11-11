import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { LiveHub } from '../../live/live.hub';
import type { PipelineService } from '../../pipeline/pipeline.service';
import { openSpend } from '../run-queries-spend';
import { taskLayers, type TaskRuns } from './documents';

/** The own run of each task of a split run, with its step, spend and time. */
export async function taskRuns(
  runs: RunRepository,
  run: RunEntity,
  documents: DocumentEntity[],
  pipeline: PipelineService,
  live?: LiveHub,
): Promise<TaskRuns> {
  const children: TaskRuns = new Map();
  const tasks = taskLayers(documents).flatMap((layer) => layer.tasks);
  if (tasks.length === 0) {
    return children;
  }
  const rows = await runs.children(run);
  const durations = await runs.durationByRun(rows.map((row) => row.id));
  for (const child of rows) {
    if (child.taskId && tasks.some((task) => task.id === child.taskId)) {
      children.set(child.taskId, {
        key: child.key,
        currentStep: child.currentStep,
        usd: child.spentUsd + openSpend(child, pipeline, live).usd,
        durationMs: durations.get(child.id) ?? 0,
      });
    }
  }
  return children;
}
