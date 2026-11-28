import { settled, type Subtask } from '../../contract/subtask';
import type { SubtaskOps, OwnEdits } from '../shared/subtask-ops';
import { mergedOf, taskStatusOf } from '../shared/subtask-status';
import type { RunEntity } from '../../history/entities';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import { renderImplementation } from './implement-record';
import { ownConflictMarker } from './own-conflict-marker';

/**
 * The tasks as their runs give them, read only: nothing is opened, launched or resumed. Null when a task has no run
 * or is not merged or skipped, or whose move has not run, so the parent still waits for it.
 */
export async function settledView(
  subtasks: SubtaskOps,
  parent: RunEntity,
  tasks: Subtask[],
): Promise<Subtask[] | null> {
  const view: Subtask[] = [];
  for (const task of tasks) {
    if (settled(task)) {
      view.push(task);
      continue;
    }
    const child = await subtasks.find(parent, task.id);
    if (!child || (await subtasks.moveOf(child))?.kind === 'moving') return null;
    const delivered = child.status === 'done' ? await subtasks.deliveredNote(child) : null;
    if (delivered) {
      view.push({ ...task, status: 'skipped', note: delivered });
    } else if (taskStatusOf(task, child) === 'merged') {
      view.push({ ...task, status: 'merged', merged: mergedOf(child), note: undefined });
    } else {
      return null;
    }
  }
  return view;
}

/** What a split parent stores when every task is settled: the lines, the body and the implementation results. */
export function settledRecord(tasks: Subtask[]): { lines: string[]; body: string; outputs: StepResult['outputs'] } {
  const lines = tasks.map((task) => `${task.title} (${task.status})`);
  const body = renderImplementation(lines);
  return {
    lines,
    body,
    outputs: [
      { artifact: ARTIFACTS.implementation, value: body },
      { artifact: ARTIFACTS.implementationResult, value: { implementation: lines, summary: [] } },
    ],
  };
}

/**
 * The parent's own edits conflict with the feature branch and every task is settled: the pass parks the conflict and
 * sends the run back to implement, where the next visit is the agent's.
 */
export function handOver(
  ctx: StepContext,
  tasks: Subtask[],
  own: OwnEdits & { conflict: string },
  stored: Subtask[],
): StepResult {
  const summary = [`${ctx.opened.startedAt} ${own.conflict}; the implement agent resolves it`, own.committed]
    .filter(Boolean)
    .join('; ');
  return {
    route: { to: 'jump', step: 'implement' },
    summary,
    outputs: [
      ...(JSON.stringify(tasks) === JSON.stringify(stored) ? [] : [{ artifact: ARTIFACTS.subtasks, value: tasks }]),
      { artifact: ARTIFACTS.rebaseConflict, value: ownConflictMarker(own.conflict) },
      ...settledRecord(tasks).outputs,
    ],
  };
}
