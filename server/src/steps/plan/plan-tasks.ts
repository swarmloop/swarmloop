import { isSubtask, type Subtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';
import { ARTIFACTS } from '../contract/artifacts';
import type { ArtifactValue } from '../contract/step-contract';
import type { ContractItem, SplitFields, SplitTask } from '../../agent-result/definitions/split-fields';
import { isPartId, PART_ID_MAX_LENGTH } from '../../core/pipeline-result';
import { keepErrors, type KeepLine } from '../shared/keep-lines';

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

/** True when the answer splits the run: it holds tasks. */
export function isSplit(value: Pick<SplitFields, 'tasks'>): boolean {
  return value.tasks.length > 0;
}

/**
 * Every defect of the tasks, contract and keep lines of a split answer, in the words the follow-up sends back to the
 * agent. A defect is never fixed silently. No error means the answer is a valid graph.
 */
export function taskErrors(value: SplitFields, limits: TaskLimits): string[] {
  if (!limits.maySplit) {
    return ['tasks are not allowed: this run may not split'];
  }
  const { tasks } = value;
  const errors: string[] = [];
  if (!value.contract.some((entry) => entry.text.trim())) {
    errors.push('contract is missing');
  }
  if (tasks.length > limits.maxTasks) {
    errors.push(`too many tasks: ${tasks.length}, the limit is ${limits.maxTasks}`);
  }
  errors.push(...graphErrors(tasks));
  const ids = tasks.map((task) => task.id);
  errors.push(...keepErrors(value.keep, ids));
  return errors;
}

/** The task graph of a checked split answer, with the dependencies the server adds for shared files. */
export function buildGraph(value: SplitFields): TaskGraph {
  const tasks: Subtask[] = value.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    depends: [...task.depends],
    files: [...task.files],
    proof: task.proof,
    covers: [...(task.covers ?? [])],
    status: 'pending',
  }));
  return { contract: renderContract(value.contract), tasks, decisions: chainSharedFiles(tasks), keep: value.keep };
}

/** The graph a run stores: its tasks, the contract text and the kept capabilities. */
export type StoredGraph = Pick<TaskGraph, 'contract' | 'tasks' | 'keep'>;

/** The tasks the split pass opened a run for: they have a status, and it is not the `pending` a plan writes. */
export function startedTasks(tasks: Subtask[]): Subtask[] {
  return tasks.filter((task) => task.status && task.status !== 'pending');
}

/**
 * The stored graph with the tasks, contract entries and keep lines of `added` appended. Stored tasks and their
 * dependencies stay as they are; an added task that shares a file with another task depends on the earlier one.
 * The merged graph is checked as a whole: the errors come back and no graph is built when it is not valid.
 */
export function withAddedTasks(
  stored: StoredGraph,
  added: SplitFields,
  limits: TaskLimits,
): { graph: TaskGraph | null; errors: string[] } {
  const errors = taskErrors(
    {
      contract: [{ id: '', text: stored.contract, owner: '' }, ...added.contract],
      tasks: [...stored.tasks, ...added.tasks],
      keep: [...stored.keep, ...added.keep],
    },
    limits,
  );
  if (errors.length > 0) {
    return { graph: null, errors };
  }
  const built = buildGraph(added);
  // The stored tasks are chained as copies: only the added tasks gain dependencies.
  const copies = stored.tasks.map((task) => ({ ...task, depends: [...task.depends] }));
  const decisions = [...built.decisions, ...chainSharedFiles([...copies, ...built.tasks])];
  const contract = [stored.contract, built.contract].filter((part) => part.trim()).join('\n\n');
  const graph = {
    contract,
    tasks: [...stored.tasks, ...built.tasks],
    decisions,
    keep: [...stored.keep, ...added.keep],
  };
  return { graph, errors };
}

/** The check of a reply that adds tasks to a stored graph: no error means the merged graph is valid. */
export function addTasksCheck(stored: StoredGraph, limits: TaskLimits): (value: unknown) => string[] {
  return (value) => {
    const given = value as Partial<SplitFields> & { plan?: string[] };
    const refused = given.plan?.length ? ['plan is not allowed: give only the tasks to add in `tasks`'] : [];
    return [...refused, ...withAddedTasks(stored, completeSplit(given), unbounded(limits)).errors];
  };
}

function completeSplit(value: Partial<SplitFields>): SplitFields {
  return { contract: value.contract ?? [], tasks: value.tasks ?? [], keep: value.keep ?? [] };
}

/**
 * The stored contract: one bullet per item, `- <id> (owner <task>): <text>`, the lines after the first indented two
 * spaces. An item with no id, as one read from a text contract, is `- <text>`.
 */
export function renderContract(items: ContractItem[]): string {
  return items
    .filter((item) => item.text.trim())
    .map((item) => {
      const [first, ...rest] = item.text.trim().split('\n');
      const head = item.id ? `${item.id} (owner ${item.owner}): ` : '';
      return [`- ${head}${first}`, ...rest.map((line) => (line.trim() ? `  ${line}` : ''))].join('\n');
    })
    .join('\n');
}

/** The l17 checklist items the server writes from the tasks: `title - files: .. - proof: ..`. */
export function planItemsFromTasks(tasks: Pick<SplitTask, 'title' | 'files' | 'proof'>[]): string[] {
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

function graphErrors(tasks: SplitTask[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      errors.push(`duplicate task id ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of tasks) {
    if (!isPartId(task.id)) {
      errors.push(
        `task ${task.id}: a task id is a lowercase letter or digit, then lowercase letters, digits and dashes, up to ${PART_ID_MAX_LENGTH} characters; rename it`,
      );
    }
    if (!task.proof.trim()) {
      errors.push(`task ${task.id} has no proof`);
    }
    if (!task.description.trim()) {
      errors.push(`task ${task.id} has no description`);
    }
    if (task.files.length === 0) {
      errors.push(`task ${task.id} has no file to change`);
    }
    for (const missing of task.depends.filter((id) => !ids.has(id))) {
      errors.push(`task ${task.id} depends on unknown task ${missing}`);
    }
  }
  const cycle = findCycle(tasks);
  return cycle ? [...errors, `tasks have a dependency cycle: ${cycle.join(' -> ')}`] : errors;
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
export function chainSharedFiles(tasks: Subtask[]): string[] {
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
function findCycle(tasks: Pick<Subtask, 'id' | 'depends'>[]): string[] | null {
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
