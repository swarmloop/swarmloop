import type { SplitFields } from '../../agent-result/definitions/split-fields';
import type { CoverageUnit } from '../shared/requirement-coverage';
import { isSplit, planItemsFromTasks } from './plan-tasks';

/** The plan items, or the tasks of a split, with the requirement ids each covers. A missing `covers` entry covers nothing. */
export function coverageUnits(value: SplitFields & { plan: string[]; covers?: string[][] }): CoverageUnit[] {
  if (isSplit(value)) {
    const lines = planItemsFromTasks(value.tasks);
    return value.tasks.map((task, index) => ({ item: lines[index], covers: task.covers ?? [] }));
  }
  return value.plan.map((item, index) => ({ item, covers: value.covers?.[index] ?? [] }));
}
