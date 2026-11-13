import { shownTaskState, type Subtask, type SubtaskStatus } from '../../contract/subtask';
import type { RunState } from '../../contract/run-state';

/** The own state of a task's run, by task id. */
export type TaskRuns = Record<string, { state: RunState; currentStep: string }>;

interface TaskMapSibling {
  id: string;
  title: string;
  files: string[];
  state: SubtaskStatus;
}

interface TaskMapDependency {
  id: string;
  files: string[];
  summary: string;
}

interface TaskMap {
  siblings: TaskMapSibling[];
  merged: TaskMapDependency[];
}

/**
 * The other tasks of the parent with their shown state, and what each merged dependency of `task` made: its summary
 * and the files its merge changed (the files the plan listed for it when none were recorded).
 */
export function taskMap(
  tasks: Subtask[],
  task: Subtask,
  runs: TaskRuns,
  summaries: Record<string, string>,
  changed: Record<string, string[]> = {},
): TaskMap {
  const siblings = tasks
    .filter((item) => item.id !== task.id)
    .map((item) => ({
      id: item.id,
      title: item.title,
      files: item.files,
      state: shownTaskState(item, runs[item.id]),
    }));
  const merged = siblings
    .filter((item) => task.depends.includes(item.id) && item.state === 'merged')
    .map((item) => ({ id: item.id, files: changed[item.id] ?? item.files, summary: summaries[item.id] ?? '' }));
  return { siblings, merged };
}

/** The map as prompt text. Empty when the task has no siblings. */
export function renderTaskMap(map: TaskMap): string {
  if (map.siblings.length === 0) return '';
  const lines = map.siblings.map(
    (item) => `- ${item.id} (${item.state}): ${item.title} - files: ${item.files.join(', ')}`,
  );
  const parts = [`Task map, the other tasks of the parent run:\n${lines.join('\n')}`];
  for (const item of map.merged) {
    const summary = item.summary ? `\n${item.summary}` : '';
    parts.push(`Merged dependency ${item.id}, files: ${item.files.join(', ')}${summary}`);
  }
  return parts.join('\n\n');
}
