import type { Requirement } from '../../contract/requirement-list';
import type { Subtask } from '../../contract/subtask';
import type { BriefingRecord } from './briefing-record';
import { readContract } from './contract-items';
import { renderMerged, renderTaskMap, taskMap, type TaskMap, type TaskRuns } from './task-map';

/** What a subtask's starter holds that the subtask is told: its parent's tasks, results and contract. */
interface BriefingInput {
  tasks: Subtask[];
  task: Subtask;
  runs: TaskRuns;
  summaries: Record<string, string>;
  changed: Record<string, string[]>;
  /** The parent's contract as it is now. */
  contract: string;
  requirements: Requirement[];
}

export interface BriefingState {
  map: TaskMap;
  contract: string;
  /** The contract's decisions log, one line per entry with its task and time. */
  decisions: string[];
  /** The requirements this task serves, and the ids that belong to named siblings. */
  own: Requirement[];
  siblings: { id: string; requirements: string[] }[];
}

export function briefingState(input: BriefingInput): BriefingState {
  const { items, decisions } = readContract(input.contract);
  const covered = new Set(input.task.covers ?? []);
  return {
    map: taskMap(input.tasks, input.task, input.runs, input.summaries, input.changed, items),
    contract: input.contract.trimEnd(),
    decisions: decisions.map((entry) => {
      const who = entry.task ? `subtask ${entry.task}${entry.at ? ` at ${entry.at}` : ''}` : 'parent';
      return `${who}: ${entry.text}`;
    }),
    own: input.requirements.filter((item) => covered.has(item.id)),
    siblings: input.tasks
      .filter((item) => item.id !== input.task.id && item.covers?.length)
      .map((item) => ({ id: item.id, requirements: item.covers ?? [] })),
  };
}

function requirementLines(state: BriefingState): string {
  const parts: string[] = [];
  if (state.own.length > 0) {
    parts.push(`Requirements of this task:\n${state.own.map((item) => `- ${item.id}: ${item.text}`).join('\n')}`);
  }
  if (state.siblings.length > 0) {
    const lines = state.siblings.map((item) => `- ${item.id}: ${item.requirements.join(', ')}`);
    parts.push(`Requirements that belong to other tasks:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/** The whole state: the task map with the merged dependencies, the contract with its decisions, the requirement ids. */
export function renderFull(state: BriefingState): string {
  const parts = [
    renderTaskMap(state.map),
    state.contract ? `Contract:\n${state.contract}` : '',
    requirementLines(state),
  ].filter(Boolean);
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

/** What a chat that was told `record` has not seen: new decisions, dependencies merged since, items whose status changed. */
export function renderDelta(state: BriefingState, record: BriefingRecord): string {
  const decisions = state.decisions.filter((line) => !record.decisions.includes(line));
  const merged = state.map.merged.filter((item) => !record.merged.includes(item.id));
  const delivered = new Set(merged.flatMap((item) => item.delivered?.map((entry) => entry.id) ?? []));
  const items = state.map.siblings.flatMap((sibling) =>
    (sibling.items ?? [])
      .filter((item) => record.items[item.id] !== item.status && !delivered.has(item.id))
      .map((item) => `- ${item.id} (owner ${sibling.id}): ${item.status}`),
  );
  const parts = [
    decisions.length > 0
      ? `New decisions since your last prompt:\n${decisions.map((line) => `- ${line}`).join('\n')}`
      : '',
    ...merged.map(renderMerged),
    items.length > 0 ? `Contract items whose status changed:\n${items.join('\n')}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

/** What a chat that was told this state has seen. */
export function recordOf(state: BriefingState): BriefingRecord {
  return {
    decisions: state.decisions,
    merged: state.map.merged.map((item) => item.id),
    items: Object.fromEntries(
      state.map.siblings.flatMap((sibling) => (sibling.items ?? []).map((item) => [item.id, item.status])),
    ),
  };
}
