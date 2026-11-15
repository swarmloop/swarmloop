import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import type { VisitRepository } from '../../history/visit.repository';
import type { LiveHub } from '../../live/live.hub';
import type { PipelineService } from '../../pipeline/pipeline.service';
import { openSpend } from '../run-queries-spend';
import { interruptionOf, taskLayers, type TaskRuns } from './documents';
import { ownStates, type StateSources } from './own-state';

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
  const tasks = taskLayers(documents).flatMap((layer) => layer.tasks);
  if (tasks.length === 0) {
    return children;
  }
  const durations = await runs.durationByRun(rows.map((row) => row.id));
  const planned = rows.filter((child) => child.taskId && tasks.some((task) => task.id === child.taskId));
  const states = await ownStates(sources, planned, (key) => pipeline.claimed(key), place);
  const notes = await sources.documents.latestDocuments(
    planned.map((child) => child.id),
    ['interruption'],
  );
  const latestVisits = await visits.latestVisits(planned.map((child) => child.id));
  for (const child of planned) {
    const own = states.get(child.key);
    if (child.taskId && own) {
      const last = latestVisits.get(child.id);
      const note =
        last?.killReason === 'process died'
          ? interruptionOf(
              notes.filter((document) => document.runId === child.id),
              last.id,
            )
          : null;
      children.set(child.taskId, {
        key: child.key,
        state: own.state,
        stateReason: own.stateReason,
        currentStep: child.currentStep,
        usd: child.spentUsd + openSpend(child, pipeline, live).usd,
        durationMs: durations.get(child.id) ?? 0,
        ...(note ? { interruption: note } : {}),
      });
    }
  }
  return children;
}
