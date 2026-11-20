import type { RunEta } from '../../contract/eta';
import { shownTaskState, type Subtask } from '../../contract/subtask';
import { epicEta } from '../../eta/epic-eta';
import type { EtaTable, LiveRun, TaskInput } from '../../eta/eta.types';
import { etaAfter, runEta } from '../../eta/run-eta';
import { SEED_RUN_MS } from '../../eta/seed';
import { runKind } from '../../eta/working-time';
import type { RunEntity } from '../../history/entities';
import type { RunWaitEntity } from '../../history/run-wait.entity';
import type { OwnState } from './own-state';

/** The own run of each task, by task id, as the estimate reads it. */
type TaskLives = ReadonlyMap<string, LiveRun>;

/** A run that has not ended, as the estimate reads it: its own state and the stretches it did not work in. */
export function liveRunOf(run: RunEntity, own: OwnState, waits: readonly RunWaitEntity[]): LiveRun {
  return {
    kind: runKind({ parentRunId: run.parentRunId?.toString(), epicAt: run.epicAt }),
    state: own.state,
    reason: own.stateReason ?? null,
    currentStep: run.currentStep,
    stepStartedAt: run.stepStartedAt,
    waits: waits.map((wait) => ({ from: wait.startedAt, to: wait.endedAt })),
  };
}

function taskInputs(plan: readonly Subtask[], lives: TaskLives): TaskInput[] {
  return plan.map((task) => {
    const run = lives.get(task.id);
    return {
      id: task.id,
      status: shownTaskState(task, run),
      depends: task.depends,
      ...(run ? { run } : {}),
    };
  });
}

/**
 * The estimate of a run for every view: `undefined` when it has ended, `null` when it waits for a person. A run with
 * a plan of tasks is an epic; its tasks are the plan's, each with its own run.
 */
export function runViewEta(
  run: LiveRun,
  plan: readonly Subtask[] | undefined,
  lives: TaskLives,
  table: EtaTable,
  parallel: number,
  now: number,
): RunEta | null | undefined {
  const at = new Date(now).toISOString();
  if (!plan || plan.length === 0) {
    return runEta(run, table, at);
  }
  return epicEta(run, taskInputs(plan, lives), table, parallel, at);
}

/** The estimate of each running, waiting or pending task of the plan, by task id; a task that waits for a person has none. */
export function taskEtas(
  plan: readonly Subtask[],
  lives: TaskLives,
  table: EtaTable,
  now: number,
): Map<string, RunEta> {
  const at = new Date(now).toISOString();
  const etas = new Map<string, RunEta>();
  for (const task of taskInputs(plan, lives)) {
    if (task.status !== 'running' && task.status !== 'waiting' && task.status !== 'pending') {
      continue;
    }
    const eta = task.run ? runEta(task.run, table, at) : etaAfter(table.subtask.whole ?? SEED_RUN_MS, at);
    if (eta) {
      etas.set(task.id, eta);
    }
  }
  return etas;
}
