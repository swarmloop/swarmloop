import { planShapeError, type PlanResult } from '../../agent-result/definitions/plan';
import { isSplit, taskErrors, unbounded, type TaskLimits } from '../plan/plan-tasks';

/** What the server checks on a plan answer after its schema: the shape, which `needs` lifted for a subtask only, and the split. */
export function planErrors(value: PlanResult, limits: TaskLimits, subtask: boolean): string[] {
  if (subtask && value.needs?.length) {
    return [];
  }
  const shape = value.needs?.length ? planShapeError(value) : null;
  return [...(shape ? [shape] : []), ...(isSplit(value) ? taskErrors(value, unbounded(limits)) : [])];
}
