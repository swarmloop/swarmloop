import type { Subtask } from '../../contract/subtask';
import type { AttemptFacts } from '../../contract/step-events';

type Node = Pick<Subtask, 'id' | 'depends'>;

/** The number of tasks on the longest `depends` chain. Ids that are not in the list are ignored. */
export function taskDepth(tasks: Node[]): number {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, number>();
  const depthOf = (task: Node): number => {
    const known = memo.get(task.id);
    if (known !== undefined) return known;
    // Set before the walk so a cycle, which the graph check refuses, cannot loop.
    memo.set(task.id, 1);
    const below = task.depends.flatMap((id) => byId.get(id) ?? []).map(depthOf);
    const depth = 1 + Math.max(0, ...below);
    memo.set(task.id, depth);
    return depth;
  };
  return Math.max(0, ...tasks.map(depthOf));
}

/** The facts line of a split plan: how many tasks and how deep their graph is. */
export function splitFacts(tasks: Node[]): AttemptFacts {
  return { details: [`${tasks.length} tasks · depth ${taskDepth(tasks)}`] };
}
