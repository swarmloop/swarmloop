import { shownTaskState, type Subtask, type SubtaskStatus } from '../../contract/subtask';
import type { RunState } from '../../contract/run-state';
import type { ContractItem } from '../../agent-result/definitions/split-fields';

/** The own state of a task's run, by task id. */
export type TaskRuns = Record<string, { state: RunState; currentStep: string }>;

/** A contract item a task owns. It counts as delivered once its owner task merged. */
interface OwnedItem {
  id: string;
  status: 'delivered' | 'pending';
}

interface TaskMapSibling {
  id: string;
  title: string;
  files: string[];
  state: SubtaskStatus;
  /** The contract items the task owns. Absent when it owns none. */
  items?: OwnedItem[];
}

interface TaskMapDependency {
  id: string;
  files: string[];
  summary: string;
  /** The contract items the dependency delivered. Absent when it owns none. */
  delivered?: ContractItem[];
}

export interface TaskMap {
  siblings: TaskMapSibling[];
  merged: TaskMapDependency[];
}

/**
 * The other tasks of the parent with their shown state, and what each merged dependency of `task` made: its summary
 * and the files its merge changed (the files the plan listed for it when none were recorded). `items` is the parent's
 * contract: each task gets the items it owns, and a merged dependency the ones it delivered.
 */
export function taskMap(
  tasks: Subtask[],
  task: Subtask,
  runs: TaskRuns,
  summaries: Record<string, string>,
  changed: Record<string, string[]> = {},
  items: ContractItem[] = [],
): TaskMap {
  const siblings = tasks
    .filter((item) => item.id !== task.id)
    .map((item) => {
      const state = shownTaskState(item, runs[item.id]);
      const owned = items.filter((entry) => entry.id && entry.owner === item.id);
      const status: OwnedItem['status'] = state === 'merged' ? 'delivered' : 'pending';
      return {
        id: item.id,
        title: item.title,
        files: item.files,
        state,
        ...(owned.length > 0 ? { items: owned.map((entry) => ({ id: entry.id, status })) } : {}),
      };
    });
  const merged = siblings
    .filter((item) => task.depends.includes(item.id) && item.state === 'merged')
    .map((item) => {
      const delivered = items.filter((entry) => entry.id && entry.owner === item.id);
      return {
        id: item.id,
        files: changed[item.id] ?? item.files,
        summary: summaries[item.id] ?? '',
        ...(delivered.length > 0 ? { delivered } : {}),
      };
    });
  return { siblings, merged };
}

/** One merged dependency as prompt text: its files, its summary and the contract items it delivered. */
export function renderMerged(item: TaskMapDependency): string {
  const summary = item.summary ? `\n${item.summary}` : '';
  const delivered = item.delivered?.map((entry) => `\n- ${entry.id}: ${entry.text}`).join('') ?? '';
  const items = delivered ? `\nContract items it delivered:${delivered}` : '';
  return `Merged dependency ${item.id}, files: ${item.files.join(', ')}${summary}${items}`;
}

/** The map as prompt text. Empty when the task has no siblings. */
export function renderTaskMap(map: TaskMap): string {
  if (map.siblings.length === 0) return '';
  const lines = map.siblings.map((item) => {
    const owns = item.items?.map((entry) => `${entry.id} (${entry.status})`).join(', ');
    return `- ${item.id} (${item.state}): ${item.title} - files: ${item.files.join(', ')}${owns ? ` - owns: ${owns}` : ''}`;
  });
  return [`Task map, the other tasks of the parent run:\n${lines.join('\n')}`, ...map.merged.map(renderMerged)].join(
    '\n\n',
  );
}
