import { SwarmloopError } from '../../core/swarmloop-error';
import { isSubtask, type Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue } from '../contract/step-contract';
import { parseKeep, type KeepLine } from '../shared/keep-lines';
import { section } from '../shared/markdown-section';

interface TaskGraph {
  contract: string;
  tasks: Subtask[];
  /** One line per dependency the server added, in the form of the contract's `decisions:`. */
  decisions: string[];
  /** The capabilities that must keep working. They are constraints on tasks, never tasks. */
  keep: KeepLine[];
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

/** The same limits with no cap on the task count: the plan step stores an oversized plan, and plan-improve merges it. */
export function unbounded(limits: TaskLimits): TaskLimits {
  return { ...limits, maxTasks: Number.POSITIVE_INFINITY };
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
  const unread = writtenIds(text).filter((id) => !tasks.some((task) => task.id === id));
  if (unread.length > 0) {
    throw new SwarmloopError(`tasks ${unread.join(', ')} were written but not read`);
  }
  if (tasks.length === 0) {
    throw new SwarmloopError('tasks is empty');
  }
  if (tasks.length > limits.maxTasks) {
    throw new SwarmloopError(`too many tasks: ${tasks.length}, the limit is ${limits.maxTasks}`);
  }
  assertGraph(tasks);
  const bare = tasks.find((task) => !task.description);
  if (bare) {
    throw new SwarmloopError(`task ${bare.id} has no description`);
  }
  const bareFiles = tasks.find((task) => task.files.length === 0);
  if (bareFiles) {
    throw new SwarmloopError(`task ${bareFiles.id} has no file to change`);
  }
  const keep = parseKeep(
    section(text, 'keep'),
    tasks.map((task) => task.id),
  );
  return { contract, tasks, decisions: chainSharedFiles(tasks), keep };
}

/** The l17 checklist items the server writes from the tasks: `title - files: .. - proof: ..`. */
export function planItemsFromTasks(tasks: Subtask[]): string[] {
  return tasks.map((task) => `${task.title} - files: ${task.files.join(', ')} - proof: ${task.proof}`);
}

/** The documents of a split plan: its tasks, kept capabilities and contract. No graph clears the tasks of an earlier split. */
export function splitOutputs(graph: TaskGraph | null): ArtifactValue[] {
  return [
    { artifact: ARTIFACTS.subtasks, value: graph?.tasks ?? [] },
    { artifact: ARTIFACTS.keep, value: graph?.keep ?? [] },
    ...(graph ? [{ artifact: ARTIFACTS.contract, value: withDecisions(graph.contract, graph.decisions) }] : []),
  ];
}

/** The contract with the added lines under its `decisions:` heading, or under a new one. */
export function withDecisions(contract: string, decisions: string[]): string {
  if (decisions.length === 0) {
    return contract;
  }
  const lines = contract.split('\n');
  const heading = lines.findIndex((line) => /^decisions:\s*$/i.test(line.trim()));
  if (heading < 0) {
    return [contract, '', 'decisions:', ...decisions.map((line) => `- ${line}`)].join('\n');
  }
  let end = heading + 1;
  while (end < lines.length && lines[end].trim()) {
    end += 1;
  }
  lines.splice(end, 0, ...decisions.map((line) => `- ${line}`));
  return lines.join('\n');
}

function taskLines(block: string): Subtask[] {
  const tasks: Subtask[] = [];
  let body: string[] = [];
  const close = (): void => {
    const last = tasks[tasks.length - 1];
    if (last) {
      last.description = dedent(body);
    }
    body = [];
  };
  for (const line of block.split(/\r?\n/)) {
    if (/^-\s/.test(line)) {
      close();
      tasks.push(taskOf(line.slice(2)));
    } else {
      body.push(line);
    }
  }
  close();
  return tasks;
}

/** The lines of a description without the common indent and without blank lines at the start and the end. */
function dedent(lines: string[]): string {
  const kept = [...lines];
  while (kept.length > 0 && !kept[0].trim()) {
    kept.shift();
  }
  while (kept.length > 0 && !kept[kept.length - 1].trim()) {
    kept.pop();
  }
  const indent = Math.min(...kept.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
  return kept.map((line) => line.slice(Math.min(indent, line.length)).trimEnd()).join('\n');
}

/** The ids of every task-shaped line of the answer, wherever it stands. */
function writtenIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const id = /^\s*-\s+([^|\s][^|]*?)\s*\|[^|]*\|\s*depends:.*\|\s*files:.*\|\s*proof:/.exec(line)?.[1];
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
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

/** True when task `from` depends on task `to`, directly or through other tasks. */
export function reaches(tasks: Subtask[], from: string, to: string): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const next of byId.get(id)?.depends ?? []) {
      if (next === to) {
        return true;
      }
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/** The tasks in dependency order; a task with no order against another keeps its plan position. The graph is acyclic. */
function topologicalOrder(tasks: Subtask[]): Subtask[] {
  const rest = [...tasks];
  const ordered: Subtask[] = [];
  while (rest.length > 0) {
    const index = rest.findIndex((task) => task.depends.every((id) => ordered.some((done) => done.id === id)));
    ordered.push(...rest.splice(index, 1));
  }
  return ordered;
}

/**
 * Chains tasks that name one file with no dependency path between them: the later task in a topological order
 * depends on the earlier one, so no cycle can appear. Returns one decisions line per added edge.
 */
function chainSharedFiles(tasks: Subtask[]): string[] {
  const ordered = topologicalOrder(tasks);
  const decisions: string[] = [];
  ordered.forEach((later, position) => {
    for (const earlier of ordered.slice(0, position).reverse()) {
      const shared = later.files.find((file) => earlier.files.includes(file));
      if (shared && !reaches(tasks, later.id, earlier.id) && !reaches(tasks, earlier.id, later.id)) {
        later.depends.push(earlier.id);
        decisions.push(`${later.id} depends on ${earlier.id}: both change ${shared}`);
      }
    }
  });
  return decisions;
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
