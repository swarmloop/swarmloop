import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import type { FlowView } from '../contract/api';
import type { DocumentEntity, RunEntity } from '../history/entities';
import type { CommandRepository } from '../history/command.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import type { RunWaitLog } from '../history/run-wait.log';
import type { VisitRepository } from '../history/visit.repository';
import type { LiveHub } from '../live/live.hub';
import type { PipelineService } from '../pipeline/pipeline.service';
import { parseSubtasks, SUBTASKS_KIND } from '../contract/subtask';
import type { EtaSummary } from './eta-summary';
import { taskView } from './run-view/documents';
import { latest } from './run-view/flow';
import { liveRunOf, runViewEta, taskEtas } from './run-view/run-eta';
import { taskRuns } from './run-view/task-runs';

export interface TaskSources {
  runs: RunRepository;
  visits: VisitRepository;
  documents: DocumentRepository;
  commands: CommandRepository;
  pipeline: PipelineService;
  live?: LiveHub;
  config: AppConfig;
  clock: Clock;
  waitLog: RunWaitLog;
  etaSummary: EtaSummary;
}

/** The part of a run page that a subtask's change moves. */
export const TASK_SECTION_KEYS = ['tasks', 'taskLine', 'mergeQueue', 'decisions', 'eta', 'epic'] as const;

export type TaskSection = Pick<FlowView, (typeof TASK_SECTION_KEYS)[number]>;

/** The tasks of the run page and the ETA of the run, from one reading of the waits, so the header and the Tasks section agree. */
export async function tasksAndEta(
  sources: TaskSources,
  run: RunEntity,
  documents: DocumentEntity[],
  children: RunEntity[],
  own: Pick<FlowView, 'state' | 'stateReason'>,
): Promise<Pick<FlowView, 'tasks' | 'taskLine' | 'mergeQueue' | 'decisions' | 'eta'>> {
  await sources.waitLog.settled();
  const table = await sources.etaSummary.table();
  const waits = await sources.waitLog.waitsOf([run.id, ...children.map((child) => child.id)]);
  const { runs, lives } = await taskRuns(
    sources.runs,
    sources.visits,
    children,
    documents,
    sources.pipeline,
    { documents: sources.documents, commands: sources.commands },
    waits,
    sources.live,
  );
  const plan = parseSubtasks(latest(documents, SUBTASKS_KIND));
  const now = sources.clock.now();
  const parallel = sources.config.env.SUBTASKS_PARALLEL;
  const eta = runViewEta(liveRunOf(run, own, waits.get(run.id) ?? []), plan, lives, table, parallel, now);
  return {
    ...taskView(documents, run.currentStep, runs, taskEtas(plan, lives, table, now)),
    ...(eta ? { eta } : {}),
  };
}
