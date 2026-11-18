import type { Subtask } from '../../contract/subtask';
import type { SplitFields } from '../../agent-result/definitions/split-fields';
import { renderContract, startedTasks } from '../plan/plan-tasks';

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The entries of a stored contract: one per bullet, with the lines that follow it. Headings are not entries. */
function contractEntries(contract: string): string[] {
  const entries: string[] = [];
  let open = false;
  for (const line of contract.split('\n')) {
    if (line.startsWith('- ')) {
      entries.push(line.slice(2));
      open = true;
    } else if (open && line.trim() && /^\s/.test(line)) {
      entries[entries.length - 1] += ` ${line}`;
    } else {
      open = false;
    }
  }
  return entries;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** What changed in a started task, in words for the agent; empty when it is as stored. */
function changes(stored: Subtask, given: SplitFields['tasks'][number]): string[] {
  return [
    ...(given.title !== stored.title ? ['title'] : []),
    ...(given.description !== stored.description ? ['description'] : []),
    ...(!sameSet(given.files, stored.files) ? ['files'] : []),
    ...(given.proof !== stored.proof ? ['proof'] : []),
    ...(!sameSet(given.depends, stored.depends) ? ['dependencies'] : []),
  ];
}

/**
 * The reasons a plan may not replace the stored graph: a started or merged task that is missing or changed, and a
 * decision of the stored contract that is gone. Tasks that did not start yet may change freely. A first plan has no
 * started task, so nothing is refused.
 */
export function addedTasksErrors(stored: Subtask[], contract: string, answer: SplitFields): string[] {
  const started = startedTasks(stored);
  if (started.length === 0) return [];
  const errors = started.flatMap((task) => {
    const given = answer.tasks.find((candidate) => candidate.id === task.id);
    if (!given) return [`task ${task.id} already started and cannot be removed: keep it as it is`];
    const changed = changes(task, given);
    return changed.length > 0 ? [`task ${task.id} already started and cannot be changed (${changed.join(', ')})`] : [];
  });
  const rendered = squash(renderContract(answer.contract));
  const gone = contractEntries(contract).filter((entry) => !rendered.includes(squash(entry)));
  return [
    ...errors,
    ...gone.map((entry) => `the contract decision "${squash(entry)}" is already followed and cannot be removed`),
  ];
}

/** The graph with every started task as stored: its status, merge commits and note stay. New and waiting tasks are as planned. */
export function keepStored<T extends { tasks: Subtask[] }>(stored: Subtask[], graph: T): T {
  const started = new Map(startedTasks(stored).map((task) => [task.id, task]));
  return { ...graph, tasks: graph.tasks.map((task) => started.get(task.id) ?? task) };
}
