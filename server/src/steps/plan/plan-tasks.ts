import { SwarmloopError } from '../../core/swarmloop-error';
import { isSubtask, type Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue } from '../contract/step-contract';
import { section } from '../shared/markdown-section';

interface TaskGraph {
  contract: string;
  tasks: Subtask[];
}

export interface TaskLimits {
  /** False for a subtask and for a run with `SPLIT=off`. */
  maySplit: boolean;
  /** The safety limit on the number of tasks. */
  maxTasks: number;
}

/** A subtask never splits. Any other run splits when its `split` flag says so. */
export function splitLimits(run: RunEntity, maxTasks: number): TaskLimits {
  return { maySplit: run.split && !isSubtask(run), maxTasks };
}

/** A split answer has a `tasks:` section and no `plan:` section. */
export function splitAnswer(text: string): boolean {
  return section(text, 'tasks') !== null && section(text, 'plan') === null;
}

/** The `contract:` and `tasks:` of a split answer. Every defect is a plan error, never a silent fix. */
export function parseTasks(text: string, limits: TaskLimits): TaskGraph {
  if (!limits.maySplit) {
    throw new SwarmloopError('tasks are not allowed: this run may not split');
  }
  const contract = (section(text, 'contract') ?? '').trim();
  if (!contract) {
    throw new SwarmloopError('contract is missing');
  }
  const tasks = taskLines(section(text, 'tasks') ?? '');
  if (tasks.length === 0) {
    throw new SwarmloopError('tasks is empty');
  }
  if (tasks.length > limits.maxTasks) {
    throw new SwarmloopError(`too many tasks: ${tasks.length}, the limit is ${limits.maxTasks}`);
  }
  assertGraph(tasks);
  return { contract, tasks };
}

/** The l17 checklist items the server writes from the tasks: `title - files: .. - proof: ..`. */
export function planItemsFromTasks(tasks: Subtask[]): string[] {
  return tasks.map((task) => `${task.title} - files: ${task.files.join(', ')} - proof: ${task.proof}`);
}

/** The documents of a split plan: its tasks and contract. No graph clears the tasks of an earlier split. */
export function splitOutputs(graph: TaskGraph | null): ArtifactValue[] {
  return [
    { artifact: ARTIFACTS.subtasks, value: graph?.tasks ?? [] },
    ...(graph ? [{ artifact: ARTIFACTS.contract, value: graph.contract }] : []),
  ];
}

function taskLines(block: string): Subtask[] {
  const tasks: Subtask[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^-\s/.test(line)) {
      tasks.push(taskOf(line.slice(2)));
    } else if (line.trim() && tasks.length > 0) {
      const last = tasks[tasks.length - 1];
      last.description = `${last.description}${last.description ? '\n' : ''}${line.trim()}`;
    }
  }
  return tasks;
}

function taskOf(line: string): Subtask {
  const [id = '', title = '', depends = '', files = '', ...proof] = line.split('|').map((part) => part.trim());
  if (!id || !title || !depends.startsWith('depends:') || !files.startsWith('files:') || proof.length === 0) {
    throw new SwarmloopError(`task line is malformed: ${line.trim()}`);
  }
  const named = depends.slice('depends:'.length).trim();
  const proofText = proof
    .join(' | ')
    .replace(/^proof:/, '')
    .trim();
  return {
    id,
    title,
    description: '',
    depends:
      named === 'none'
        ? []
        : named
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
    files: files
      .slice('files:'.length)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
    proof: proofText,
    status: 'pending',
  };
}

function assertGraph(tasks: Subtask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new SwarmloopError(`duplicate task id ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of tasks) {
    if (!task.proof) {
      throw new SwarmloopError(`task ${task.id} has no proof`);
    }
    const unknown = task.depends.find((id) => !ids.has(id));
    if (unknown) {
      throw new SwarmloopError(`task ${task.id} depends on unknown task ${unknown}`);
    }
  }
  const cycle = findCycle(tasks);
  if (cycle) {
    throw new SwarmloopError(`tasks have a dependency cycle: ${cycle.join(' -> ')}`);
  }
}

/** The ids of one cycle in dependency order, or null when the graph is acyclic. */
function findCycle(tasks: Subtask[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const done = new Set<string>();
  const walk = (id: string, path: string[]): string[] | null => {
    if (path.includes(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    if (done.has(id)) {
      return null;
    }
    for (const next of byId.get(id)?.depends ?? []) {
      const found = walk(next, [...path, id]);
      if (found) {
        return found;
      }
    }
    done.add(id);
    return null;
  };
  for (const task of tasks) {
    const found = walk(task.id, []);
    if (found) {
      return found;
    }
  }
  return null;
}
