/** A requirement ref, `M<milestone number>.R<n>`. */
export const REQUIREMENT_REF = /^M\d+\.R\d+$/;

/** The fields of a task that the graph reads. */
interface GraphTask {
  slug: string;
  covers?: string[];
  depends: string[];
}

/** One step of a dependency: the id waited for, and the requirement it came from, when it came from one. */
interface DependencyEdge {
  id: string;
  ref: string | null;
}

/**
 * What a task depends on. A requirement stands for the tasks that cover it, except the task itself: its own coverage is never a dependency.
 * A requirement that no task covers stays as it is, and so keeps the task waiting.
 */
export function dependencyEdges(task: GraphTask, tasks: GraphTask[]): DependencyEdge[] {
  return task.depends.flatMap((id): DependencyEdge[] => {
    if (!REQUIREMENT_REF.test(id)) return [{ id, ref: null }];
    const covering = tasks.filter((other) => (other.covers ?? []).includes(id));
    if (covering.length === 0) return [{ id, ref: id }];
    return covering.filter((other) => other.slug !== task.slug).map((other) => ({ id: other.slug, ref: id }));
  });
}

function label(edge: DependencyEdge): string {
  return edge.ref !== null && edge.ref !== edge.id ? `${edge.ref} (${edge.id})` : edge.id;
}

function words(start: string, path: DependencyEdge[]): string {
  return [start, ...path.map(label)].join(' -> ');
}

/** One dependency cycle through the tasks in words, or null. A walk from each task in plan order. */
export function findCycle(tasks: GraphTask[]): string | null {
  const bySlug = new Map(tasks.map((task) => [task.slug, task]));
  const done = new Set<string>();
  const walk = (id: string, path: string[], edges: DependencyEdge[]): string | null => {
    if (path.includes(id)) return words(path[path.indexOf(id)], edges.slice(path.indexOf(id)));
    if (done.has(id)) return null;
    const task = bySlug.get(id);
    for (const edge of task ? dependencyEdges(task, tasks) : []) {
      const found = walk(edge.id, [...path, id], [...edges, edge]);
      if (found) return found;
    }
    done.add(id);
    return null;
  };
  for (const task of tasks) {
    const found = walk(task.slug, [], []);
    if (found) return found;
  }
  return null;
}

/** The first dependency path in words that comes back to `slug`, or null when none does. */
export function cycleFrom(slug: string, tasks: GraphTask[]): string | null {
  const bySlug = new Map(tasks.map((task) => [task.slug, task]));
  const seen = new Set<string>();
  const walk = (id: string, edges: DependencyEdge[]): string | null => {
    const task = bySlug.get(id);
    for (const edge of task ? dependencyEdges(task, tasks) : []) {
      if (edge.id === slug) return words(slug, [...edges, edge]);
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      const found = walk(edge.id, [...edges, edge]);
      if (found) return found;
    }
    return null;
  };
  return walk(slug, []);
}
