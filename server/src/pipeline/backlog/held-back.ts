import type { Subtask } from '../../contract/subtask';
import { settled } from '../../contract/subtask';

/** The slugs of the unsettled tasks that depend on `slug`, directly or through other tasks, in plan order. Depends are expanded already. */
export function heldBack(slug: string, tasks: Pick<Subtask, 'id' | 'depends' | 'status'>[]): string[] {
  const held = new Set<string>([slug]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const task of tasks) {
      if (held.has(task.id) || !task.depends.some((id) => held.has(id))) continue;
      held.add(task.id);
      grew = true;
    }
  }
  return tasks.filter((task) => task.id !== slug && held.has(task.id) && !settled(task)).map((task) => task.id);
}
