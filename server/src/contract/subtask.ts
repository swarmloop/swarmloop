/** One task in the `subtasks` document of a parent run. */
export interface Subtask {
  id: string;
  title: string;
  description: string;
  /** Ids of the tasks that must be done before this one starts. */
  depends: string[];
  files: string[];
  proof: string;
  status: SubtaskStatus;
  /** What the pass says about the task, such as the tasks it waits for. */
  note?: string;
  /** The merge commit per repository, for the merge requests of this task that the server has merged. Kept while the task is partly merged. */
  merged?: Record<string, string>;
}

/** `pending` is what the plan writes; every reader sees it as `waiting`. `green`: the subtask is done, its merge request into the feature branch has green CI. */
export type SubtaskStatus = 'pending' | 'waiting' | 'running' | 'green' | 'merged' | 'blocked' | 'skipped';

/** The kinds a subtask reads from its parent: the task list, and the decisions that bind every subtask. */
export const SUBTASKS_KIND = 'subtasks';
export const CONTRACT_KIND = 'contract';

export function parseSubtasks(body: string | null): Subtask[] {
  if (!body?.trim()) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? withStatuses((parsed as Partial<Subtask>[]).map(withDepends)) : [];
  } catch {
    return [];
  }
}

function withDepends(task: Partial<Subtask>): Subtask {
  return { ...task, depends: task.depends ?? [] } as Subtask;
}

/** The tasks as every reader sees them: a task without a status, or with the plan's `pending`, is `waiting`. */
export function withStatuses(tasks: Subtask[]): Subtask[] {
  return tasks.map((task) => ({
    ...task,
    status: !task.status || task.status === 'pending' ? 'waiting' : task.status,
  }));
}

/** A run with a parent is a subtask. */
export function isSubtask(run: { parentRunId?: number | null }): boolean {
  return typeof run.parentRunId === 'number';
}

/** A task whose work no longer holds up the tasks that depend on it. */
export function settled(task: Subtask): boolean {
  return task.status === 'merged' || task.status === 'skipped';
}

/** The ids a task still waits for. */
export function unmetDepends(task: Subtask, tasks: Subtask[]): string[] {
  return task.depends.filter((id) => {
    const found = tasks.find((item) => item.id === id);
    return !found || !settled(found);
  });
}

/** The blocked tasks that `task` depends on, directly or through other unsettled tasks. */
function blockedAncestors(task: Subtask, tasks: Subtask[]): string[] {
  const seen = new Set<string>();
  const blocked: string[] = [];
  const queue = [...task.depends];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const found = tasks.find((item) => item.id === id);
    if (seen.has(id) || !found || settled(found)) continue;
    seen.add(id);
    if (found.status === 'blocked') blocked.push(id);
    queue.push(...found.depends);
  }
  return blocked;
}

/** The waiting tasks that may start now: every dependency is settled and none is behind a blocked task, up to `parallel` tasks at a time. */
export function readyTasks(tasks: Subtask[], parallel: number): Subtask[] {
  const free = Math.max(0, parallel - tasks.filter((task) => task.status === 'running').length);
  return tasks
    .filter(
      (task) =>
        task.status === 'waiting' &&
        unmetDepends(task, tasks).length === 0 &&
        blockedAncestors(task, tasks).length === 0,
    )
    .slice(0, free);
}

/** What a waiting task waits for: a blocked task, the tasks it depends on, or a free slot. Never a settled task. */
export function waitNote(task: Subtask, tasks: Subtask[]): string {
  const blocked = blockedAncestors(task, tasks);
  if (blocked.length > 0) return `waiting for ${blocked.join(', ')}, which is blocked`;
  const unmet = unmetDepends(task, tasks);
  if (unmet.length > 0) return `waiting for ${unmet.join(', ')}`;
  const running = tasks.filter((item) => item.status === 'running').length;
  return `waiting for a free slot: ${running} of SUBTASKS_PARALLEL running`;
}

/** `4/7 merged · 2 running · 1 waiting`. A count of zero is left out. */
export function statusLine(tasks: Subtask[]): string {
  const count = (status: SubtaskStatus): number => tasks.filter((task) => task.status === status).length;
  const parts = [`${count('merged')}/${tasks.length} merged`];
  for (const status of ['running', 'green', 'waiting', 'blocked', 'skipped'] as const) {
    if (count(status) > 0) {
      parts.push(`${count(status)} ${status}`);
    }
  }
  return parts.join(' · ');
}

/** `Split: 7 tasks · 5 merged · 2 running`. The running count is left out when no task runs. */
export function splitLine(tasks: Subtask[]): string {
  const running = tasks.filter((task) => task.status === 'running').length;
  const merged = tasks.filter((task) => task.status === 'merged').length;
  return ['Split: ' + tasks.length + ' tasks', `${merged} merged`, ...(running > 0 ? [`${running} running`] : [])].join(
    ' · ',
  );
}
