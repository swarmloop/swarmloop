import type { RunEntity } from '../../history/entities';
import type { RunSummary } from '../../contract/api';

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
